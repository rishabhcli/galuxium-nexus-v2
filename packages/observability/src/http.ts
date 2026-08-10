import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';

import type { Logger } from './logger.js';
import { MetricRegistry } from './metrics.js';

const DEFAULT_MAXIMUM_CONNECTIONS = 128;
const DEFAULT_MAXIMUM_IN_FLIGHT_REQUESTS = 64;
const DEFAULT_MAXIMUM_REQUESTS_PER_SECOND = 512;
const DEFAULT_SHUTDOWN_GRACE_MS = 2_000;
const REQUEST_RATE_WINDOW_MS = 1_000;

export interface ReadinessCheck {
  readonly name: string;
  readonly check: (signal: AbortSignal) => Promise<void>;
}

export interface HttpResponse {
  readonly body?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly status: number;
}

export interface RequestContext {
  readonly request: IncomingMessage;
  readonly requestId: string;
  readonly signal: AbortSignal;
  readonly url: URL;
}

export interface ServiceServerOptions {
  readonly host: string;
  readonly logger: Logger;
  readonly maximumConnections?: number;
  readonly maximumInFlightRequests?: number;
  readonly maximumRequestsPerSecond?: number;
  readonly metrics?: MetricRegistry;
  readonly port: number;
  readonly readinessChecks?: readonly ReadinessCheck[];
  readonly requestDeadlineMs?: number;
  readonly route?: (
    context: RequestContext,
  ) => HttpResponse | Promise<HttpResponse | undefined> | undefined;
  readonly service: string;
  readonly shutdownGraceMs?: number;
  readonly version: string;
}

export interface ServiceServer {
  readonly metrics: MetricRegistry;
  close(): Promise<void>;
  listen(): Promise<void>;
}

export interface RequestRateAdmission {
  admit(): boolean;
}

interface ReadinessResult {
  readonly durationMs: number;
  readonly name: string;
  readonly status: 'ready' | 'not_ready';
}

type RequestCancellationCode =
  'CLIENT_DISCONNECTED' | 'REQUEST_DEADLINE_EXCEEDED' | 'SERVICE_SHUTTING_DOWN';

type RouteClassification =
  | 'application'
  | 'health_live'
  | 'health_ready'
  | 'invalid_request_target'
  | 'metrics'
  | 'unmatched';

class RequestCancellationError extends Error {
  readonly code: RequestCancellationCode;

  constructor(code: RequestCancellationCode) {
    const message =
      code === 'CLIENT_DISCONNECTED'
        ? 'Client disconnected.'
        : code === 'REQUEST_DEADLINE_EXCEEDED'
          ? 'Request deadline exceeded.'
          : 'Service is shutting down.';
    super(message);
    this.name = 'RequestCancellationError';
    this.code = code;
  }
}

function jsonResponse(response: ServerResponse, status: number, body: unknown): void {
  const encoded = JSON.stringify(body);
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(encoded),
    'content-type': 'application/json; charset=utf-8',
  });
  response.end(encoded);
}

function canWriteResponse(response: ServerResponse): boolean {
  return !response.headersSent && !response.writableEnded && !response.destroyed;
}

function cancellationFrom(signal: AbortSignal): RequestCancellationError {
  return signal.reason instanceof RequestCancellationError
    ? signal.reason
    : new RequestCancellationError('CLIENT_DISCONNECTED');
}

async function withCancellation<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    throw cancellationFrom(signal);
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      signal.removeEventListener('abort', onAbort);
      reject(cancellationFrom(signal));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(
          error instanceof Error ? error : new Error('Asynchronous request operation failed.'),
        );
      },
    );
  });
}

function requestUrl(request: IncomingMessage, options: ServiceServerOptions): URL {
  const base = new URL(`http://${options.host}:${String(options.port)}`);
  const parsed = new URL(request.url ?? '/', base);
  if (parsed.origin !== base.origin || parsed.username !== '' || parsed.password !== '') {
    throw new TypeError('Request target authority does not match this service.');
  }
  return parsed;
}

function stableMethod(method: string | undefined): string {
  switch (method) {
    case undefined:
      return 'OTHER';
    case 'DELETE':
    case 'GET':
    case 'HEAD':
    case 'OPTIONS':
    case 'PATCH':
    case 'POST':
    case 'PUT':
      return method;
    default:
      return 'OTHER';
  }
}

function validateBoundedInteger(
  candidate: number,
  name: string,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isSafeInteger(candidate) || candidate < minimum || candidate > maximum) {
    throw new Error(
      `${name} must be an integer between ${String(minimum)} and ${String(maximum)}.`,
    );
  }
  return candidate;
}

/**
 * Strict rolling-window admission with memory bounded by the configured rate.
 * A non-finite, backwards, or throwing monotonic clock fails closed.
 */
export function createRequestRateAdmission(
  maximumRequestsPerSecond: number,
  now: () => number = () => performance.now(),
): RequestRateAdmission {
  validateBoundedInteger(maximumRequestsPerSecond, 'Service request rate limit', 1, 10_000);
  let lastObservedAt: number;
  try {
    lastObservedAt = now();
  } catch {
    throw new Error('Service request rate clock failed during initialization.');
  }
  if (!Number.isFinite(lastObservedAt) || lastObservedAt < 0) {
    throw new Error('Service request rate clock must be finite and non-negative.');
  }
  const admissions: number[] = [];

  return {
    admit: () => {
      let observedAt: number;
      try {
        observedAt = now();
      } catch {
        return false;
      }
      if (!Number.isFinite(observedAt) || observedAt < lastObservedAt) {
        return false;
      }
      lastObservedAt = observedAt;
      const oldestAllowedAt = observedAt - REQUEST_RATE_WINDOW_MS;
      while (admissions[0] !== undefined && admissions[0] <= oldestAllowedAt) {
        admissions.shift();
      }
      if (admissions.length >= maximumRequestsPerSecond) {
        return false;
      }
      admissions.push(observedAt);
      return true;
    },
  };
}

function defineServiceMetrics(metrics: MetricRegistry): void {
  metrics.defineCounter(
    'galuxium_nexus_v2_http_requests_total',
    'HTTP requests accepted by this process.',
  );
  metrics.defineCounter(
    'galuxium_nexus_v2_http_failures_total',
    'HTTP requests that ended in a 5xx response.',
  );
  metrics.defineCounter(
    'galuxium_nexus_v2_http_requests_refused_total',
    'HTTP requests refused before application work because admission was unavailable.',
  );
  metrics.defineCounter(
    'galuxium_nexus_v2_http_requests_rate_limited_total',
    'HTTP requests refused by the bounded per-process request-rate admission.',
  );
  metrics.defineCounter(
    'galuxium_nexus_v2_http_connections_dropped_total',
    'TCP connections dropped because the process connection limit was reached.',
  );
  metrics.defineGauge(
    'galuxium_nexus_v2_http_requests_in_flight',
    'HTTP requests currently admitted by this process.',
  );
  metrics.defineGauge(
    'galuxium_nexus_v2_http_connections_active',
    'TCP connections currently accepted by this process.',
  );
  metrics.defineGauge(
    'galuxium_nexus_v2_service_ready',
    'Whether every readiness dependency currently succeeds.',
  );
  metrics.defineGauge(
    'galuxium_nexus_v2_process_uptime_seconds',
    'Process uptime in seconds at collection time.',
  );
}

export async function handleServiceRequest(
  options: ServiceServerOptions,
  metrics: MetricRegistry,
  request: IncomingMessage,
  response: ServerResponse,
  shutdownSignal?: AbortSignal,
): Promise<void> {
  // Never trust or reflect a caller-provided correlation value. Every accepted
  // request receives an independent identifier generated inside this process.
  const requestId = randomUUID();
  response.setHeader('x-request-id', requestId);
  metrics.increment('galuxium_nexus_v2_http_requests_total');
  const startedAt = performance.now();
  const controller = new AbortController();
  const requestDeadlineMs = options.requestDeadlineMs ?? 5_000;
  const deadline = setTimeout(() => {
    controller.abort(new RequestCancellationError('REQUEST_DEADLINE_EXCEEDED'));
  }, requestDeadlineMs);
  deadline.unref();

  const abortForClientDisconnect = (): void => {
    controller.abort(new RequestCancellationError('CLIENT_DISCONNECTED'));
  };
  const abortForShutdown = (): void => {
    controller.abort(new RequestCancellationError('SERVICE_SHUTTING_DOWN'));
  };
  const onRequestClose = (): void => {
    if (!request.complete && !response.writableFinished) {
      abortForClientDisconnect();
    }
  };
  const onResponseClose = (): void => {
    if (!response.writableFinished) {
      abortForClientDisconnect();
    }
  };
  request.once('aborted', abortForClientDisconnect);
  request.once('close', onRequestClose);
  response.once('close', onResponseClose);
  if (shutdownSignal?.aborted === true) {
    abortForShutdown();
  } else {
    shutdownSignal?.addEventListener('abort', abortForShutdown, { once: true });
  }

  let route: RouteClassification = 'invalid_request_target';
  let status = 500;
  try {
    let url: URL;
    try {
      url = requestUrl(request, options);
    } catch (error) {
      status = 400;
      options.logger.warn('service.invalid_request_target', { error, requestId });
      jsonResponse(response, status, {
        code: 'INVALID_REQUEST_TARGET',
        message: 'The HTTP request target is invalid.',
        requestId,
      });
      return;
    }

    if (request.method === 'GET' && url.pathname === '/livez') {
      route = 'health_live';
      status = 200;
      jsonResponse(response, status, {
        service: options.service,
        status: 'alive',
        version: options.version,
      });
      return;
    }

    if (request.method === 'GET' && url.pathname === '/readyz') {
      route = 'health_ready';
      const results: ReadinessResult[] = [];
      for (const readinessCheck of options.readinessChecks ?? []) {
        const checkStartedAt = performance.now();
        try {
          await withCancellation(
            Promise.resolve().then(async () => readinessCheck.check(controller.signal)),
            controller.signal,
          );
          results.push({
            durationMs: Math.round((performance.now() - checkStartedAt) * 100) / 100,
            name: readinessCheck.name,
            status: 'ready',
          });
        } catch (error) {
          if (controller.signal.aborted) {
            throw cancellationFrom(controller.signal);
          }
          options.logger.warn('service.readiness_check_failed', {
            check: readinessCheck.name,
            error,
            requestId,
          });
          results.push({
            durationMs: Math.round((performance.now() - checkStartedAt) * 100) / 100,
            name: readinessCheck.name,
            status: 'not_ready',
          });
        }
      }
      const ready = results.every((result) => result.status === 'ready');
      metrics.set('galuxium_nexus_v2_service_ready', ready ? 1 : 0);
      status = ready ? 200 : 503;
      jsonResponse(response, status, {
        checks: results,
        service: options.service,
        status: ready ? 'ready' : 'not_ready',
        version: options.version,
      });
      return;
    }

    if (request.method === 'GET' && url.pathname === '/metrics') {
      route = 'metrics';
      metrics.set('galuxium_nexus_v2_process_uptime_seconds', process.uptime());
      const body = metrics.render();
      status = 200;
      response.writeHead(status, {
        'cache-control': 'no-store',
        'content-length': Buffer.byteLength(body),
        'content-type': 'text/plain; version=0.0.4; charset=utf-8',
      });
      response.end(body);
      return;
    }

    const routed = await withCancellation(
      Promise.resolve(
        options.route?.({
          request,
          requestId,
          signal: controller.signal,
          url,
        }),
      ),
      controller.signal,
    );
    if (routed === undefined) {
      route = 'unmatched';
      status = 404;
      jsonResponse(response, status, {
        code: 'ROUTE_NOT_FOUND',
        message: 'The requested route is not supported.',
        requestId,
      });
      return;
    }

    route = 'application';
    status = routed.status;
    response.writeHead(status, {
      'cache-control': 'no-store',
      ...(routed.body === undefined
        ? { 'content-length': '0' }
        : { 'content-length': String(Buffer.byteLength(routed.body)) }),
      ...routed.headers,
    });
    response.end(routed.body);
  } catch (error) {
    if (error instanceof RequestCancellationError) {
      if (error.code === 'REQUEST_DEADLINE_EXCEEDED') {
        status = 504;
        options.logger.warn('service.request_deadline_exceeded', { error, requestId });
        if (canWriteResponse(response)) {
          jsonResponse(response, status, {
            code: error.code,
            message: 'The service did not complete the request before its deadline.',
            requestId,
          });
        } else if (!response.writableEnded) {
          response.destroy();
        }
      } else if (error.code === 'SERVICE_SHUTTING_DOWN') {
        status = 503;
        options.logger.info('service.request_cancelled_for_shutdown', { requestId });
        if (canWriteResponse(response)) {
          response.setHeader('connection', 'close');
          jsonResponse(response, status, {
            code: error.code,
            message: 'The service is shutting down.',
            requestId,
          });
        } else if (!response.writableEnded) {
          response.destroy();
        }
      } else {
        status = 499;
        options.logger.info('service.client_disconnected', { error, requestId });
        if (!response.writableEnded && !response.destroyed) {
          response.destroy();
        }
      }
    } else {
      status = 500;
      options.logger.error('service.request_failed', { error, requestId });
      if (canWriteResponse(response)) {
        jsonResponse(response, status, {
          code: 'INTERNAL_ERROR',
          message: 'The service could not complete the request.',
          requestId,
        });
      } else if (!response.writableEnded) {
        response.destroy();
      }
    }
  } finally {
    clearTimeout(deadline);
    request.off('aborted', abortForClientDisconnect);
    request.off('close', onRequestClose);
    response.off('close', onResponseClose);
    shutdownSignal?.removeEventListener('abort', abortForShutdown);
    if (status >= 500) {
      metrics.increment('galuxium_nexus_v2_http_failures_total');
    }
    options.logger.info('service.request_completed', {
      durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
      method: stableMethod(request.method),
      requestId,
      route,
      status,
    });
  }
}

function refuseRequest(
  options: ServiceServerOptions,
  metrics: MetricRegistry,
  request: IncomingMessage,
  response: ServerResponse,
  code: 'SERVICE_CAPACITY_EXHAUSTED' | 'SERVICE_RATE_LIMIT_EXCEEDED' | 'SERVICE_SHUTTING_DOWN',
): void {
  const requestId = randomUUID();
  const startedAt = performance.now();
  const status = code === 'SERVICE_RATE_LIMIT_EXCEEDED' ? 429 : 503;
  metrics.increment('galuxium_nexus_v2_http_requests_refused_total');
  if (status >= 500) {
    metrics.increment('galuxium_nexus_v2_http_failures_total');
  }
  if (code === 'SERVICE_RATE_LIMIT_EXCEEDED') {
    metrics.increment('galuxium_nexus_v2_http_requests_rate_limited_total');
    response.setHeader('retry-after', '1');
  }
  response.setHeader('connection', 'close');
  response.setHeader('x-request-id', requestId);
  jsonResponse(response, status, {
    code,
    message:
      code === 'SERVICE_CAPACITY_EXHAUSTED'
        ? 'The service has reached its in-flight request limit.'
        : code === 'SERVICE_RATE_LIMIT_EXCEEDED'
          ? 'The service request-rate limit has been reached.'
          : 'The service is shutting down.',
    requestId,
  });
  options.logger.warn('service.request_refused', {
    reason: code,
    requestId,
  });
  options.logger.info('service.request_completed', {
    durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
    method: stableMethod(request.method),
    requestId,
    route: 'admission_refused',
    status,
  });
}

export function createServiceServer(options: ServiceServerOptions): ServiceServer {
  if (options.host !== '127.0.0.1') {
    throw new Error(`Development service ${options.service} must bind to 127.0.0.1`);
  }
  if (!Number.isSafeInteger(options.port) || options.port < 4160 || options.port > 4169) {
    throw new Error(`Development service ${options.service} port is outside 4160-4169`);
  }
  const maximumConnections = validateBoundedInteger(
    options.maximumConnections ?? DEFAULT_MAXIMUM_CONNECTIONS,
    'Service connection limit',
    1,
    1_024,
  );
  const maximumInFlightRequests = validateBoundedInteger(
    options.maximumInFlightRequests ?? DEFAULT_MAXIMUM_IN_FLIGHT_REQUESTS,
    'Service in-flight request limit',
    1,
    1_024,
  );
  const maximumRequestsPerSecond = validateBoundedInteger(
    options.maximumRequestsPerSecond ?? DEFAULT_MAXIMUM_REQUESTS_PER_SECOND,
    'Service request rate limit',
    1,
    10_000,
  );
  const requestDeadlineMs = options.requestDeadlineMs ?? 5_000;
  validateBoundedInteger(requestDeadlineMs, 'Service request deadline', 1, 30_000);
  const shutdownGraceMs = validateBoundedInteger(
    options.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS,
    'Service shutdown grace period',
    1,
    30_000,
  );

  const metrics = options.metrics ?? new MetricRegistry();
  defineServiceMetrics(metrics);
  const activeHandlers = new Set<Promise<void>>();
  const activeSockets = new Set<Socket>();
  const shutdownController = new AbortController();
  const requestRateAdmission = createRequestRateAdmission(maximumRequestsPerSecond);
  let inFlightRequests = 0;
  let state: 'closed' | 'closing' | 'created' | 'listening' | 'starting' = 'created';
  let closePromise: Promise<void> | undefined;

  const server = createServer((request, response) => {
    if (state === 'closing' || state === 'closed') {
      refuseRequest(options, metrics, request, response, 'SERVICE_SHUTTING_DOWN');
      return;
    }
    if (!requestRateAdmission.admit()) {
      refuseRequest(options, metrics, request, response, 'SERVICE_RATE_LIMIT_EXCEEDED');
      return;
    }
    if (inFlightRequests >= maximumInFlightRequests) {
      refuseRequest(options, metrics, request, response, 'SERVICE_CAPACITY_EXHAUSTED');
      return;
    }

    inFlightRequests += 1;
    metrics.set('galuxium_nexus_v2_http_requests_in_flight', inFlightRequests);
    const handling = handleServiceRequest(
      options,
      metrics,
      request,
      response,
      shutdownController.signal,
    ).catch((error: unknown) => {
      // This is the terminal safety boundary for failures in logging or response
      // serialization itself. The catch handler is attached synchronously, so a
      // malformed request target can never become an unhandled rejection.
      try {
        options.logger.error('service.request_handler_rejected', { error });
        if (canWriteResponse(response)) {
          jsonResponse(response, 500, {
            code: 'INTERNAL_ERROR',
            message: 'The service could not complete the request.',
          });
        } else if (!response.writableEnded) {
          response.destroy();
        }
      } catch {
        // A logger or response-stream failure at this terminal boundary cannot
        // be made safe by retrying either operation. Close only this response.
        if (!response.destroyed) {
          response.destroy();
        }
      }
    });
    activeHandlers.add(handling);
    void handling.then(() => {
      activeHandlers.delete(handling);
      inFlightRequests -= 1;
      metrics.set('galuxium_nexus_v2_http_requests_in_flight', inFlightRequests);
    });
  });

  server.headersTimeout = 6_000;
  server.keepAliveTimeout = 5_000;
  server.maxConnections = maximumConnections;
  server.maxHeadersCount = 64;
  server.maxRequestsPerSocket = 100;
  server.requestTimeout = requestDeadlineMs;
  server.on('connection', (socket) => {
    activeSockets.add(socket);
    metrics.set('galuxium_nexus_v2_http_connections_active', activeSockets.size);
    socket.once('close', () => {
      activeSockets.delete(socket);
      metrics.set('galuxium_nexus_v2_http_connections_active', activeSockets.size);
    });
  });
  server.on('drop', () => {
    metrics.increment('galuxium_nexus_v2_http_connections_dropped_total');
  });

  return {
    metrics,
    listen: async () => {
      if (state !== 'created') {
        throw new Error('Service server can only start once.');
      }
      state = 'starting';
      try {
        await new Promise<void>((resolve, reject) => {
          const onError = (error: Error): void => {
            server.off('listening', onListening);
            reject(error);
          };
          const onListening = (): void => {
            server.off('error', onError);
            resolve();
          };
          server.once('error', onError);
          server.once('listening', onListening);
          server.listen(options.port, options.host);
        });
        state = 'listening';
      } catch (error) {
        state = 'created';
        throw error;
      }
      options.logger.info('service.listening', {
        host: options.host,
        port: options.port,
      });
    },
    close: () => {
      closePromise ??= (async () => {
        if (state === 'closed') {
          return;
        }
        state = 'closing';
        shutdownController.abort(new RequestCancellationError('SERVICE_SHUTTING_DOWN'));

        const serverClosed = new Promise<void>((resolve, reject) => {
          if (!server.listening) {
            resolve();
            return;
          }
          server.close((error) => {
            if (error === undefined) {
              resolve();
            } else {
              reject(error);
            }
          });
          server.closeIdleConnections();
        });
        const handlersSettled = Promise.allSettled([...activeHandlers]).then(() => undefined);
        let timer: NodeJS.Timeout | undefined;
        const graceExpired = new Promise<'expired'>((resolve) => {
          timer = setTimeout(() => {
            resolve('expired');
          }, shutdownGraceMs);
        });
        const graceful = Promise.all([serverClosed, handlersSettled]).then(
          () => 'closed' as const,
          () => 'failed' as const,
        );
        const outcome = await Promise.race([graceful, graceExpired]);
        if (timer !== undefined) {
          clearTimeout(timer);
        }
        if (outcome !== 'closed') {
          options.logger.warn('service.shutdown_forced', {
            activeRequests: activeHandlers.size,
            activeSockets: activeSockets.size,
            reason: outcome,
          });
          server.closeAllConnections();
          for (const socket of activeSockets) {
            socket.destroy();
          }
        }
        state = 'closed';
        options.logger.info('service.stopped');
      })();
      return closePromise;
    },
  };
}
