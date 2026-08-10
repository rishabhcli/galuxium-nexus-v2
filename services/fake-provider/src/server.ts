import {
  createLogger,
  createServiceServer,
  parseDevelopmentServiceEnvironment,
  readRequestBody,
  RequestBodyError,
  runUntilSignalled,
  type HttpResponse,
} from '@galuxium-nexus-v2/observability';
import {
  deterministicFixtureUsage,
  fixtureProviderModeSchema,
  fixtureProviderRequestSchema,
} from './fixture.js';

const EXPECTED_SERVICE = { name: 'fake-provider', port: 4163 } as const;
const MAXIMUM_BODY_BYTES = 65_536;

async function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error('request aborted');
  }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    const onAbort = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(signal.reason instanceof Error ? signal.reason : new Error('request aborted'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    timer.unref();
  });
}

function errorResponse(
  status: number,
  code: string,
  message: string,
  requestId: string,
): HttpResponse {
  return {
    body: JSON.stringify({ error: { code, message, requestId, retryable: status >= 500 } }),
    headers: { 'content-type': 'application/json; charset=utf-8' },
    status,
  };
}

async function main(): Promise<void> {
  const config = parseDevelopmentServiceEnvironment(process.env, EXPECTED_SERVICE);
  const logger = createLogger({
    minimumLevel: config.logLevel,
    service: config.serviceName,
  });
  const server = createServiceServer({
    host: config.host,
    logger,
    port: config.port,
    requestDeadlineMs: 5_000,
    route: async ({ request, requestId, signal, url }) => {
      if (request.method === 'GET' && url.pathname === '/') {
        return {
          body: JSON.stringify({
            modes: fixtureProviderModeSchema.options,
            model: 'fixture-text-v1',
            productionStatus: 'local test boundary only',
            requestId,
          }),
          headers: { 'content-type': 'application/json; charset=utf-8' },
          status: 200,
        };
      }

      if (request.method !== 'POST' || url.pathname !== '/v1/chat/completions') {
        return undefined;
      }
      if (!(request.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
        return errorResponse(
          415,
          'UNSUPPORTED_MEDIA_TYPE',
          'Content-Type must be application/json.',
          requestId,
        );
      }

      let rawBody: Buffer;
      try {
        rawBody = await readRequestBody(request, {
          maximumBytes: MAXIMUM_BODY_BYTES,
          signal,
        });
      } catch (error) {
        if (error instanceof RequestBodyError) {
          const status =
            error.code === 'BODY_TOO_LARGE' ? 413 : error.code === 'BODY_ABORTED' ? 408 : 400;
          return errorResponse(status, error.code, error.message, requestId);
        }
        throw error;
      }

      let decoded: unknown;
      try {
        decoded = JSON.parse(rawBody.toString('utf8'));
      } catch {
        return errorResponse(400, 'INVALID_JSON', 'The request body is not valid JSON.', requestId);
      }
      const parsedRequest = fixtureProviderRequestSchema.safeParse(decoded);
      if (!parsedRequest.success) {
        return errorResponse(
          400,
          'INVALID_PROVIDER_REQUEST',
          'The request does not match the deterministic provider contract.',
          requestId,
        );
      }

      const rawMode = request.headers['x-fake-provider-mode'] ?? 'success';
      const parsedMode = fixtureProviderModeSchema.safeParse(rawMode);
      if (!parsedMode.success) {
        return errorResponse(
          400,
          'INVALID_FAILURE_MODE',
          'The requested failure mode is unsupported.',
          requestId,
        );
      }
      if (parsedMode.data === 'http_error') {
        return errorResponse(
          503,
          'FIXTURE_PROVIDER_UNAVAILABLE',
          'Injected provider unavailability.',
          requestId,
        );
      }
      if (parsedMode.data === 'malformed') {
        return {
          body: '{"fixture":"intentionally-malformed"',
          headers: { 'content-type': 'application/json; charset=utf-8' },
          status: 200,
        };
      }
      if (parsedMode.data === 'slow') {
        await wait(250, signal);
      }

      const usage = deterministicFixtureUsage(parsedRequest.data);
      return {
        body: JSON.stringify({
          choices: [
            {
              finish_reason: 'stop',
              index: 0,
              message: { content: 'Deterministic fixture response.', role: 'assistant' },
            },
          ],
          created: 0,
          id: usage.id,
          model: parsedRequest.data.model,
          object: 'chat.completion',
          system_fingerprint: 'fixture-provider-v1',
          usage: {
            completion_tokens: usage.completionTokens,
            prompt_tokens: usage.promptTokens,
            total_tokens: usage.promptTokens + usage.completionTokens,
          },
        }),
        headers: { 'content-type': 'application/json; charset=utf-8' },
        status: 200,
      };
    },
    service: config.serviceName,
    version: config.serviceVersion,
  });
  await runUntilSignalled(server, logger);
}

await main().catch((error: unknown) => {
  const logger = createLogger({ service: EXPECTED_SERVICE.name });
  logger.error('service.start_failed', { error });
  process.exitCode = 1;
});
