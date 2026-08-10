import { EventEmitter } from 'node:events';
import {
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { createConnection } from 'node:net';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';

import {
  createRequestRateAdmission,
  createServiceServer,
  handleServiceRequest,
  type ServiceServerOptions,
} from '../src/http.js';
import { createLogger, type LogRecord } from '../src/logger.js';

class TestRequest extends PassThrough {
  readonly headers: Record<string, string | undefined> = {};
  complete = false;
  method = 'GET';
  url = '/';
}

class TestResponse extends EventEmitter {
  body = '';
  destroyed = false;
  readonly headers = new Map<string, string | number | readonly string[]>();
  headersSent = false;
  statusCode = 0;
  writableEnded = false;
  writableFinished = false;

  destroy(): this {
    this.destroyed = true;
    this.emit('close');
    return this;
  }

  end(body?: string): this {
    this.body = body ?? '';
    this.writableEnded = true;
    this.writableFinished = true;
    return this;
  }

  setHeader(name: string, value: string | number | readonly string[]): this {
    this.headers.set(name.toLowerCase(), value);
    return this;
  }

  writeHead(status: number, headers: Readonly<Record<string, string | number>> = {}): this {
    this.statusCode = status;
    this.headersSent = true;
    for (const [name, value] of Object.entries(headers)) {
      this.headers.set(name.toLowerCase(), value);
    }
    return this;
  }
}

function harness(overrides: Partial<ServiceServerOptions> = {}): {
  readonly logs: readonly LogRecord[];
  readonly metrics: ReturnType<typeof createServiceServer>['metrics'];
  readonly options: ServiceServerOptions;
} {
  const logs: LogRecord[] = [];
  const logger = createLogger({
    minimumLevel: 'debug',
    service: 'http-test',
    write: (line) => logs.push(JSON.parse(line) as LogRecord),
  });
  const options: ServiceServerOptions = {
    host: '127.0.0.1',
    logger,
    port: 4164,
    service: 'http-test',
    version: '0.1.0',
    ...overrides,
  };
  // Constructing a Node server does not bind a port. This gives the direct
  // request-handler tests the exact metric registry used by production code.
  const metrics = createServiceServer(options).metrics;
  return { logs, metrics, options };
}

function request(
  value: {
    readonly headers?: Readonly<Record<string, string>>;
    readonly method?: string;
    readonly url?: string;
  } = {},
): TestRequest {
  const candidate = new TestRequest();
  Object.assign(candidate.headers, value.headers);
  candidate.method = value.method ?? 'GET';
  candidate.url = value.url ?? '/';
  return candidate;
}

interface LiveResponse {
  readonly body: string;
  readonly headers: IncomingHttpHeaders;
  readonly status: number;
}

async function liveRequest(
  path: string,
  headers: Readonly<Record<string, string>> = {},
): Promise<LiveResponse> {
  return new Promise<LiveResponse>((resolve, reject) => {
    const outgoing = httpRequest(
      {
        agent: false,
        headers,
        host: '127.0.0.1',
        method: 'GET',
        path,
        port: 4164,
      },
      (incoming) => {
        const chunks: Buffer[] = [];
        incoming.on('data', (chunk: Buffer) => {
          chunks.push(chunk);
        });
        incoming.once('end', () => {
          resolve({
            body: Buffer.concat(chunks).toString('utf8'),
            headers: incoming.headers,
            status: incoming.statusCode ?? 0,
          });
        });
        incoming.once('error', reject);
      },
    );
    outgoing.once('error', reject);
    outgoing.end();
  });
}

describe('handleServiceRequest', () => {
  it('returns a safe 400 for a malformed target without rejecting or logging the raw target', async () => {
    const target = 'http://[private-request-target';
    const testHarness = harness();
    const testRequest = request({ url: target });
    const response = new TestResponse();

    await expect(
      handleServiceRequest(
        testHarness.options,
        testHarness.metrics,
        testRequest as unknown as IncomingMessage,
        response as unknown as ServerResponse,
      ),
    ).resolves.toBeUndefined();

    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body)).toMatchObject({ code: 'INVALID_REQUEST_TARGET' });
    const serializedLogs = JSON.stringify(testHarness.logs);
    expect(serializedLogs).toContain('invalid_request_target');
    expect(serializedLogs).not.toContain(target);
  });

  it('never reflects or logs caller request IDs or raw hostile paths', async () => {
    const hostileRequestId = 'ALPHANUMERICREQUESTSECRET998877';
    const hostilePath = '/ALPHANUMERICPATHSECRET112233';
    const testHarness = harness();
    const response = new TestResponse();

    await handleServiceRequest(
      testHarness.options,
      testHarness.metrics,
      request({
        headers: { 'x-request-id': hostileRequestId },
        url: hostilePath,
      }) as unknown as IncomingMessage,
      response as unknown as ServerResponse,
    );

    const responseRequestId = response.headers.get('x-request-id');
    expect(response.statusCode).toBe(404);
    expect(responseRequestId).toEqual(expect.stringMatching(/^[0-9a-f-]{36}$/));
    expect(responseRequestId).not.toBe(hostileRequestId);
    expect(JSON.parse(response.body)).toMatchObject({ requestId: responseRequestId });
    const serializedLogs = JSON.stringify(testHarness.logs);
    expect(serializedLogs).toContain('unmatched');
    expect(serializedLogs).not.toContain(hostileRequestId);
    expect(serializedLogs).not.toContain(hostilePath.slice(1));
  });

  it('returns a stable 504 and aborts a route at the explicit request deadline', async () => {
    let observedSignal: AbortSignal | undefined;
    const testHarness = harness({
      requestDeadlineMs: 20,
      route: async ({ signal }) => {
        observedSignal = signal;
        await new Promise<never>((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => {
              reject(
                signal.reason instanceof Error
                  ? signal.reason
                  : new Error('Request signal was aborted.'),
              );
            },
            { once: true },
          );
        });
      },
    });
    const response = new TestResponse();

    await handleServiceRequest(
      testHarness.options,
      testHarness.metrics,
      request() as unknown as IncomingMessage,
      response as unknown as ServerResponse,
    );

    expect(observedSignal?.aborted).toBe(true);
    expect(response.statusCode).toBe(504);
    expect(JSON.parse(response.body)).toMatchObject({ code: 'REQUEST_DEADLINE_EXCEEDED' });
    expect(testHarness.logs).toContainEqual(
      expect.objectContaining({ event: 'service.request_completed', context: expect.any(Object) }),
    );
  });

  it('bounds a readiness check that ignores cancellation and still exposes its aborted signal', async () => {
    let observedSignal: AbortSignal | undefined;
    const testHarness = harness({
      readinessChecks: [
        {
          name: 'ignores-cancellation',
          check: async (signal) => {
            observedSignal = signal;
            await new Promise<never>(() => undefined);
          },
        },
      ],
      requestDeadlineMs: 20,
    });
    const response = new TestResponse();

    await handleServiceRequest(
      testHarness.options,
      testHarness.metrics,
      request({ url: '/readyz' }) as unknown as IncomingMessage,
      response as unknown as ServerResponse,
    );

    expect(observedSignal?.aborted).toBe(true);
    expect(response.statusCode).toBe(504);
  });

  it('cancels work and records status 499 when the client disconnects', async () => {
    let routeStarted = false;
    let observedSignal: AbortSignal | undefined;
    const testHarness = harness({
      route: async ({ signal }) => {
        routeStarted = true;
        observedSignal = signal;
        await new Promise<never>(() => undefined);
      },
    });
    const testRequest = request();
    const response = new TestResponse();
    const handling = handleServiceRequest(
      testHarness.options,
      testHarness.metrics,
      testRequest as unknown as IncomingMessage,
      response as unknown as ServerResponse,
    );
    expect(routeStarted).toBe(true);

    testRequest.emit('aborted');
    await handling;

    expect(observedSignal?.aborted).toBe(true);
    expect(response.destroyed).toBe(true);
    expect(testHarness.logs).toContainEqual(
      expect.objectContaining({
        context: expect.objectContaining({ status: 499 }),
        event: 'service.request_completed',
      }),
    );
  });
});

describe('createServiceServer limits and shutdown', () => {
  it('enforces a strict rolling request-rate window with a deterministic clock', () => {
    let now = 0;
    const admission = createRequestRateAdmission(2, () => now);

    expect(admission.admit()).toBe(true);
    expect(admission.admit()).toBe(true);
    expect(admission.admit()).toBe(false);
    now = 999;
    expect(admission.admit()).toBe(false);
    now = 1_000;
    expect(admission.admit()).toBe(true);
    now = Number.NaN;
    expect(admission.admit()).toBe(false);
  });

  it('returns a stable 429 and metric when the per-process request rate is exhausted', async () => {
    const testHarness = harness({ maximumRequestsPerSecond: 1 });
    const server = createServiceServer(testHarness.options);
    await server.listen();

    try {
      const admitted = await liveRequest('/livez');
      expect(admitted.status).toBe(200);

      const refused = await liveRequest('/livez');
      expect(refused.status).toBe(429);
      expect(refused.headers['retry-after']).toBe('1');
      expect(JSON.parse(refused.body)).toMatchObject({ code: 'SERVICE_RATE_LIMIT_EXCEEDED' });
      expect(server.metrics.get('galuxium_nexus_v2_http_requests_rate_limited_total')).toBe(1);
    } finally {
      await server.close();
    }
  });

  it('returns an explicit 503 and increments the refusal metric at the in-flight limit', async () => {
    let releaseRoute: (() => void) | undefined;
    let announceRouteStarted: (() => void) | undefined;
    const routeStarted = new Promise<void>((resolve) => {
      announceRouteStarted = resolve;
    });
    const routeGate = new Promise<void>((resolve) => {
      releaseRoute = resolve;
    });
    const testHarness = harness({
      maximumConnections: 4,
      maximumInFlightRequests: 1,
      route: async () => {
        announceRouteStarted?.();
        await routeGate;
        return { body: 'done', status: 200 };
      },
    });
    const server = createServiceServer(testHarness.options);
    await server.listen();

    try {
      const firstRequest = liveRequest('/hold');
      await routeStarted;
      const refused = await liveRequest('/hold', {
        'x-request-id': 'ADMISSIONSECRET445566',
      });

      expect(refused.status).toBe(503);
      expect(JSON.parse(refused.body)).toMatchObject({ code: 'SERVICE_CAPACITY_EXHAUSTED' });
      expect(server.metrics.get('galuxium_nexus_v2_http_requests_refused_total')).toBe(1);
      expect(JSON.stringify(testHarness.logs)).not.toContain('ADMISSIONSECRET445566');

      releaseRoute?.();
      const firstResponse = await firstRequest;
      expect(firstResponse.status).toBe(200);
      expect(firstResponse.body).toBe('done');
    } finally {
      releaseRoute?.();
      await server.close();
    }
  });

  it('aborts active request work and completes shutdown within its grace bound', async () => {
    let observedSignal: AbortSignal | undefined;
    let announceRouteStarted: (() => void) | undefined;
    const routeStarted = new Promise<void>((resolve) => {
      announceRouteStarted = resolve;
    });
    const testHarness = harness({
      route: async ({ signal }) => {
        observedSignal = signal;
        announceRouteStarted?.();
        await new Promise<never>(() => undefined);
      },
      shutdownGraceMs: 100,
    });
    const server = createServiceServer(testHarness.options);
    await server.listen();
    const activeRequest = liveRequest('/never');
    await routeStarted;

    await expect(server.close()).resolves.toBeUndefined();
    expect(observedSignal?.aborted).toBe(true);
    const response = await activeRequest;
    expect(response.status).toBe(503);
    expect(JSON.parse(response.body)).toMatchObject({ code: 'SERVICE_SHUTTING_DOWN' });
  });

  it('bounds accepted connections, records drops, and destroys a stalled socket on close', async () => {
    const testHarness = harness({
      maximumConnections: 1,
      maximumInFlightRequests: 1,
      shutdownGraceMs: 20,
    });
    const server = createServiceServer(testHarness.options);
    await server.listen();
    const firstSocket = createConnection({ host: '127.0.0.1', port: 4164 });
    await new Promise<void>((resolve, reject) => {
      firstSocket.once('connect', resolve);
      firstSocket.once('error', reject);
    });
    firstSocket.write('GET /stalled HTTP/1.1\r\nHost: 127.0.0.1\r\n');
    const firstSocketClosed = new Promise<void>((resolve) => {
      firstSocket.once('close', () => {
        resolve();
      });
    });

    const droppedSocket = createConnection({ host: '127.0.0.1', port: 4164 });
    await new Promise<void>((resolve, reject) => {
      droppedSocket.once('close', () => {
        resolve();
      });
      droppedSocket.once('error', (error) => {
        if ((error as NodeJS.ErrnoException).code === 'ECONNRESET') {
          resolve();
        } else {
          reject(error);
        }
      });
    });
    await vi.waitFor(() => {
      expect(server.metrics.get('galuxium_nexus_v2_http_connections_dropped_total')).toBe(1);
    });

    const startedAt = performance.now();
    await server.close();
    await firstSocketClosed;
    expect(performance.now() - startedAt).toBeLessThan(500);
    expect(firstSocket.destroyed).toBe(true);
    droppedSocket.destroy();
  });
});
