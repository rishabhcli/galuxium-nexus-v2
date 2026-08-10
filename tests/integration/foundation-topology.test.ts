import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

const REPOSITORY_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const GATEWAY_LOG_PATH = fileURLToPath(new URL('../../.dev/logs/gateway.log', import.meta.url));
const REQUEST_TIMEOUT_MS = 5_000;
const SERVICE_VERSION = '0.1.0';
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

const HTTP_SERVICES = [
  {
    checks: ['postgres-ledger', 'redis-coordination'],
    name: 'gateway',
    port: 4160,
  },
  {
    checks: ['postgres-ledger', 'redis-coordination'],
    name: 'reconciler',
    port: 4161,
  },
  {
    checks: ['gateway', 'reconciler'],
    name: 'admin',
    port: 4162,
  },
  {
    checks: [],
    name: 'fake-provider',
    port: 4163,
  },
  {
    checks: ['gateway', 'reconciler', 'admin', 'fake-provider'],
    name: 'metrics',
    port: 4167,
  },
] as const;

const CORRELATED_STATUS_SURFACES = [
  { path: '/status', port: 4160 },
  { path: '/status', port: 4161 },
  { path: '/api/status', port: 4162 },
  { path: '/', port: 4163 },
  { path: '/', port: 4167 },
] as const;

const PROVIDER_URL = 'http://127.0.0.1:4163/v1/chat/completions';
const PROVIDER_REQUEST = {
  max_tokens: 32,
  messages: [
    { content: 'Return a deterministic fixture.', role: 'system' },
    { content: 'budget envelope', role: 'user' },
  ],
  model: 'fixture-text-v1',
  stream: false,
} as const;

interface CommandOutput {
  readonly stderr: string;
  readonly stdout: string;
}

interface ProviderErrorBody {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly requestId: string;
    readonly retryable: boolean;
  };
}

function serviceUrl(port: number, path: string): string {
  return `http://127.0.0.1:${String(port)}${path}`;
}

async function boundedFetch(url: string, init: RequestInit = {}): Promise<Response> {
  return fetch(url, {
    ...init,
    cache: 'no-store',
    redirect: 'error',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}

async function readJsonObject(response: Response): Promise<Record<string, unknown>> {
  expect(response.headers.get('content-type')).toContain('application/json');
  const value: unknown = await response.json();
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Expected an object JSON response.');
  }
  return value as Record<string, unknown>;
}

function expectInternalRequestId(response: Response, callerRequestId: string): string {
  const responseRequestId = response.headers.get('x-request-id');
  if (responseRequestId === null) {
    throw new Error('The service response omitted its internally generated request ID.');
  }
  expect(responseRequestId).toMatch(UUID_V4_PATTERN);
  expect(responseRequestId).not.toBe(callerRequestId);
  return responseRequestId;
}

async function readGatewayLogAfter(byteOffset: number): Promise<string> {
  const log = await readFile(GATEWAY_LOG_PATH);
  if (log.byteLength < byteOffset) {
    throw new Error('The gateway log was truncated while the request-log assertion was running.');
  }
  return log.subarray(byteOffset).toString('utf8');
}

function runDevHealth(): Promise<CommandOutput> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      ['tooling/dev/health.mjs'],
      {
        cwd: REPOSITORY_ROOT,
        encoding: 'utf8',
        maxBuffer: 128 * 1_024,
        timeout: 20_000,
      },
      (error, stdout, stderr) => {
        if (error !== null) {
          reject(
            new Error(`dev:health failed. stdout=${stdout} stderr=${stderr}`, {
              cause: error,
            }),
          );
          return;
        }
        resolve({ stderr, stdout });
      },
    );
  });
}

async function postProvider(options: {
  readonly body?: BodyInit;
  readonly callerRequestId: string;
  readonly contentType?: string;
  readonly mode?: string | undefined;
}): Promise<Response> {
  const headers = new Headers({
    'content-type': options.contentType ?? 'application/json',
    'x-request-id': options.callerRequestId,
  });
  if (options.mode !== undefined) {
    headers.set('x-fake-provider-mode', options.mode);
  }
  return boundedFetch(PROVIDER_URL, {
    body: options.body ?? JSON.stringify(PROVIDER_REQUEST),
    headers,
    method: 'POST',
  });
}

async function expectProviderError(
  response: Response,
  expected: {
    readonly callerRequestId: string;
    readonly code: string;
    readonly message: string;
    readonly retryable: boolean;
    readonly status: number;
  },
): Promise<void> {
  expect(response.status).toBe(expected.status);
  const responseRequestId = expectInternalRequestId(response, expected.callerRequestId);
  const body = (await readJsonObject(response)) as unknown as ProviderErrorBody;
  expect(body).toEqual({
    error: {
      code: expected.code,
      message: expected.message,
      requestId: responseRequestId,
      retryable: expected.retryable,
    },
  });
}

let verifiedDevHealth: CommandOutput | undefined;

beforeAll(async () => {
  const result = await runDevHealth();
  if (result.stderr !== '') {
    throw new Error(`dev:health wrote to stderr: ${result.stderr}`);
  }
  if (
    !result.stdout.includes(
      '[dev:health] PASS local development topology is ready on 127.0.0.1:4160-4169.',
    )
  ) {
    throw new Error(`dev:health omitted the topology readiness assertion: ${result.stdout}`);
  }
  verifiedDevHealth = result;
}, 25_000);

describe('real Tier 0 readiness identities', () => {
  it.each(HTTP_SERVICES)(
    '$name distinguishes liveness from dependency-backed readiness on $port',
    async ({ checks: expectedChecks, name, port }) => {
      const liveRequestId = `integration-${name}-live`;
      const liveResponse = await boundedFetch(serviceUrl(port, '/livez'), {
        headers: { 'x-request-id': liveRequestId },
      });
      expect(liveResponse.status).toBe(200);
      expectInternalRequestId(liveResponse, liveRequestId);
      expect(await readJsonObject(liveResponse)).toEqual({
        service: name,
        status: 'alive',
        version: SERVICE_VERSION,
      });

      const readyRequestId = `integration-${name}-ready`;
      const readyResponse = await boundedFetch(serviceUrl(port, '/readyz'), {
        headers: { 'x-request-id': readyRequestId },
      });
      expect(readyResponse.status).toBe(200);
      expectInternalRequestId(readyResponse, readyRequestId);
      const readiness = await readJsonObject(readyResponse);
      expect(readiness).toMatchObject({
        service: name,
        status: 'ready',
        version: SERVICE_VERSION,
      });
      expect(readiness['checks']).toEqual(
        expectedChecks.map((checkName) => ({
          durationMs: expect.any(Number),
          name: checkName,
          status: 'ready',
        })),
      );
      for (const check of readiness['checks'] as readonly { readonly durationMs: number }[]) {
        expect(check.durationMs).toBeGreaterThanOrEqual(0);
      }
    },
  );

  it('proves the PostgreSQL namespace and Redis logical DB through dev:health', () => {
    const result = verifiedDevHealth;
    if (result === undefined) {
      throw new Error('The bounded dev:health setup did not publish its verified output.');
    }

    expect(result.stderr).toBe('');
    expect(result.stdout).toContain(
      '[dev:health] PASS postgres query=ok database=galuxium_nexus_v2 owner=galuxium_nexus_v2_owner role=galuxium_nexus_v2 least_privilege=ok database_scope=ok version=16.14',
    );
    expect(result.stdout).toContain('[dev:health] PASS redis PING=PONG db=6 version=8.10.0');
  });
});

describe('correlation IDs', () => {
  it.each(CORRELATED_STATUS_SURFACES)(
    'rejects caller correlation authority and returns one internal ID in the header and body on $port $path',
    async ({ path, port }) => {
      const callerRequestId = `integration-correlation-${String(port)}`;
      const response = await boundedFetch(serviceUrl(port, path), {
        headers: { 'x-request-id': callerRequestId },
      });

      expect(response.status).toBe(200);
      const responseRequestId = expectInternalRequestId(response, callerRequestId);
      expect((await readJsonObject(response))['requestId']).toBe(responseRequestId);
    },
  );

  it('replaces an unsafe caller ID with one internally generated ID', async () => {
    const callerRequestId = '../../not-a-safe-correlation-id';
    const response = await boundedFetch(serviceUrl(4160, '/status'), {
      headers: { 'x-request-id': callerRequestId },
    });
    const body = await readJsonObject(response);

    expect(response.status).toBe(200);
    const responseRequestId = expectInternalRequestId(response, callerRequestId);
    expect(body['requestId']).toBe(responseRequestId);
  });

  it('logs only the internal correlation ID and stable route class for a new request', async () => {
    const callerRequestId = `caller-${randomUUID()}`;
    const secret = `secret-${randomUUID()}`;
    const queryMarker = `query-${randomUUID()}`;
    const rawPath = '/status';
    const rawQuery = `access_token=${encodeURIComponent(secret)}&query_marker=${encodeURIComponent(queryMarker)}`;
    const rawRequestTarget = `${rawPath}?${rawQuery}`;
    const logByteOffset = (await stat(GATEWAY_LOG_PATH)).size;
    const response = await boundedFetch(serviceUrl(4160, rawRequestTarget), {
      headers: { 'x-request-id': callerRequestId },
    });

    expect(response.status).toBe(200);
    const responseRequestId = expectInternalRequestId(response, callerRequestId);
    expect((await readJsonObject(response))['requestId']).toBe(responseRequestId);
    await expect
      .poll(async () =>
        (await readGatewayLogAfter(logByteOffset)).includes(`"requestId":"${responseRequestId}"`),
      )
      .toBe(true);
    const appendedLog = await readGatewayLogAfter(logByteOffset);
    const matchingRecords = appendedLog
      .split('\n')
      .filter((line) => line.includes(`"requestId":"${responseRequestId}"`));
    expect(matchingRecords).toHaveLength(1);
    const matchingRecord = matchingRecords[0];
    if (matchingRecord === undefined) {
      throw new Error('The gateway omitted the current request completion record.');
    }
    const parsedRecord: unknown = JSON.parse(matchingRecord);
    expect(parsedRecord).toMatchObject({
      context: {
        method: 'GET',
        requestId: responseRequestId,
        route: 'application',
        status: 200,
      },
      event: 'service.request_completed',
      level: 'info',
      service: 'gateway',
    });
    expect(appendedLog).not.toContain(callerRequestId);
    expect(appendedLog).not.toContain(rawPath);
    expect(appendedLog).not.toContain(rawQuery);
    expect(appendedLog).not.toContain(rawRequestTarget);
    expect(appendedLog).not.toContain('access_token');
    expect(appendedLog).not.toContain(queryMarker);
    expect(appendedLog).not.toContain(secret);
  });
});

describe('deterministic fake provider boundary', () => {
  it('returns byte-for-byte repeatable output and usage for the same request', async () => {
    const firstCallerRequestId = 'integration-provider-repeat-1';
    const secondCallerRequestId = 'integration-provider-repeat-2';
    const first = await postProvider({ callerRequestId: firstCallerRequestId });
    const second = await postProvider({ callerRequestId: secondCallerRequestId });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const firstResponseRequestId = expectInternalRequestId(first, firstCallerRequestId);
    const secondResponseRequestId = expectInternalRequestId(second, secondCallerRequestId);
    expect(firstResponseRequestId).not.toBe(secondResponseRequestId);
    const firstText = await first.text();
    const secondText = await second.text();
    expect(secondText).toBe(firstText);
    expect(JSON.parse(firstText)).toEqual({
      choices: [
        {
          finish_reason: 'stop',
          index: 0,
          message: { content: 'Deterministic fixture response.', role: 'assistant' },
        },
      ],
      created: 0,
      id: 'fixture-facceba96d1af5abf5248f22',
      model: 'fixture-text-v1',
      object: 'chat.completion',
      system_fingerprint: 'fixture-provider-v1',
      usage: {
        completion_tokens: 10,
        prompt_tokens: 12,
        total_tokens: 22,
      },
    });
  });

  it('injects an explicit retryable HTTP error without pretending success', async () => {
    const callerRequestId = 'integration-provider-http-error';
    const response = await postProvider({ callerRequestId, mode: 'http_error' });

    expect(response.status).toBe(503);
    await expectProviderError(response, {
      callerRequestId,
      code: 'FIXTURE_PROVIDER_UNAVAILABLE',
      message: 'Injected provider unavailability.',
      retryable: true,
      status: 503,
    });
  });

  it('injects a successful HTTP response with deliberately malformed JSON', async () => {
    const callerRequestId = 'integration-provider-malformed';
    const response = await postProvider({ callerRequestId, mode: 'malformed' });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    expectInternalRequestId(response, callerRequestId);
    const body = await response.text();
    expect(body).toBe('{"fixture":"intentionally-malformed"');
    expect(() => JSON.parse(body)).toThrow(SyntaxError);
  });

  it.each([
    {
      body: JSON.stringify(PROVIDER_REQUEST),
      code: 'UNSUPPORTED_MEDIA_TYPE',
      contentType: 'text/plain',
      label: 'unsupported media type',
      message: 'Content-Type must be application/json.',
      mode: undefined,
      status: 415,
    },
    {
      body: '{"model":',
      code: 'INVALID_JSON',
      contentType: 'application/json',
      label: 'invalid JSON',
      message: 'The request body is not valid JSON.',
      mode: undefined,
      status: 400,
    },
    {
      body: JSON.stringify({ ...PROVIDER_REQUEST, max_tokens: 0 }),
      code: 'INVALID_PROVIDER_REQUEST',
      contentType: 'application/json',
      label: 'invalid provider schema',
      message: 'The request does not match the deterministic provider contract.',
      mode: undefined,
      status: 400,
    },
    {
      body: JSON.stringify(PROVIDER_REQUEST),
      code: 'INVALID_FAILURE_MODE',
      contentType: 'application/json',
      label: 'invalid failure mode',
      message: 'The requested failure mode is unsupported.',
      mode: 'invented-mode',
      status: 400,
    },
  ])('refuses $label with a stable safe error contract', async (testCase) => {
    const callerRequestId = `integration-provider-${testCase.code.toLowerCase().replaceAll('_', '-')}`;
    const response = await postProvider({
      body: testCase.body,
      callerRequestId,
      contentType: testCase.contentType,
      mode: testCase.mode,
    });

    expect(response.status).toBe(testCase.status);
    await expectProviderError(response, {
      callerRequestId,
      code: testCase.code,
      message: testCase.message,
      retryable: false,
      status: testCase.status,
    });
  });

  it('refuses a request body above the 64 KiB boundary', async () => {
    const callerRequestId = 'integration-provider-body-too-large';
    const response = await postProvider({
      body: 'x'.repeat(65_537),
      callerRequestId,
    });

    expect(response.status).toBe(413);
    await expectProviderError(response, {
      callerRequestId,
      code: 'BODY_TOO_LARGE',
      message: 'The request body exceeds the size limit.',
      retryable: false,
      status: 413,
    });
  });
});

describe('truthful admin surface', () => {
  it('states the exact not-yet-production boundary on the human page', async () => {
    const callerRequestId = 'integration-admin-page';
    const response = await boundedFetch(serviceUrl(4162, '/'), {
      headers: { 'x-request-id': callerRequestId },
    });
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(response.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(response.headers.get('x-frame-options')).toBe('DENY');
    const responseRequestId = expectInternalRequestId(response, callerRequestId);
    expect(body).toContain('<strong>Not yet in production.</strong>');
    expect(body).toContain('Budget authorization and ledger workflows are not implemented yet.');
    expect(body).toContain('<dt>Gateway</dt><dd class="ready">dependency check passed</dd>');
    expect(body).toContain('<dt>Reconciler</dt><dd class="ready">dependency check passed</dd>');
    expect(body).toContain(`Request ID: <code>${responseRequestId}</code>`);
  });

  it('reports the same boundary and real dependency state from the API', async () => {
    const callerRequestId = 'integration-admin-api';
    const response = await boundedFetch(serviceUrl(4162, '/api/status'), {
      headers: { 'x-request-id': callerRequestId },
    });

    expect(response.status).toBe(200);
    const responseRequestId = expectInternalRequestId(response, callerRequestId);
    expect(await readJsonObject(response)).toEqual({
      dependencies: [
        { name: 'Gateway', ready: true },
        { name: 'Reconciler', ready: true },
      ],
      productionStatus: 'not yet in production',
      requestId: responseRequestId,
      status: 'ready',
    });
  });
});

describe('Prometheus exposition', () => {
  it('exports typed, newline-terminated foundation metrics', async () => {
    const callerRequestId = 'integration-prometheus';
    const response = await boundedFetch(serviceUrl(4167, '/metrics'), {
      headers: { accept: 'text/plain', 'x-request-id': callerRequestId },
    });
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/plain; version=0.0.4; charset=utf-8');
    expectInternalRequestId(response, callerRequestId);
    expect(body.endsWith('\n')).toBe(true);
    expect(body).toContain(
      '# HELP galuxium_nexus_v2_foundation_dependencies_expected Number of foundation service dependencies expected by the metrics endpoint.\n',
    );
    expect(body).toContain('# TYPE galuxium_nexus_v2_foundation_dependencies_expected gauge\n');
    expect(body).toContain('galuxium_nexus_v2_foundation_dependencies_expected 4\n');
    expect(body).toContain('# TYPE galuxium_nexus_v2_http_requests_total counter\n');
    expect(body).toContain('# TYPE galuxium_nexus_v2_http_failures_total counter\n');
    expect(body).toContain('# TYPE galuxium_nexus_v2_http_requests_refused_total counter\n');
    expect(body).toContain('# TYPE galuxium_nexus_v2_http_requests_rate_limited_total counter\n');
    expect(body).toContain('# TYPE galuxium_nexus_v2_http_connections_dropped_total counter\n');
    expect(body).toContain('# TYPE galuxium_nexus_v2_http_requests_in_flight gauge\n');
    expect(body).toContain('# TYPE galuxium_nexus_v2_http_connections_active gauge\n');
    expect(body).toContain('# TYPE galuxium_nexus_v2_service_ready gauge\n');
    expect(body).toContain('galuxium_nexus_v2_service_ready 1\n');
    expect(body).toContain('# TYPE galuxium_nexus_v2_process_uptime_seconds gauge\n');

    const samples = body.split('\n').filter((line) => line.length > 0 && !line.startsWith('#'));
    expect(samples.length).toBe(10);
    for (const sample of samples) {
      expect(sample).toMatch(
        /^[a-zA-Z_:][a-zA-Z0-9_:]* [-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?$/u,
      );
    }
  });
});
