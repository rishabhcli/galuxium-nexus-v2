import { realpath } from 'node:fs/promises';
import { join } from 'node:path';

import { createLedgerHealthProbe, type LedgerHealthProbe } from '@galuxium-nexus-v2/ledger';
import {
  createLogger,
  createIdempotentCleanup,
  createServiceServer,
  parseDevelopmentServiceEnvironment,
  parseFoundationDependencyEnvironment,
  readCanonicalSecretFile,
  repositoryRootFromServiceModule,
  runUntilSignalled,
  type CloseableService,
  type Logger,
  type ServiceServer,
} from '@galuxium-nexus-v2/observability';
import { createClient, type RedisClientType } from 'redis';

const EXPECTED_SERVICE = { name: 'gateway', port: 4160 } as const;

interface Dependencies {
  close(): Promise<void>;
  readonly ledger: LedgerHealthProbe;
  readonly redis: RedisClientType;
}

async function createDependencies(logger: Logger): Promise<Dependencies> {
  const parsed = parseFoundationDependencyEnvironment(process.env);
  const repositoryRoot = await realpath(
    repositoryRootFromServiceModule(import.meta.url, EXPECTED_SERVICE.name),
  );
  const expectedPasswordFile = join(repositoryRoot, '.dev', 'secrets', 'postgres-password');
  const password = await readCanonicalSecretFile({
    expectedPath: expectedPasswordFile,
    path: parsed.databasePasswordFile,
  });
  const ledger = createLedgerHealthProbe({
    expectedDatabase: parsed.databaseName,
    expectedRole: parsed.databaseUser,
    host: parsed.databaseHost,
    // dev:health checks gateway directly while admin and metrics also traverse
    // this readiness edge. Keep the fan-out bounded, but above that declared
    // maximum concurrency so a truthful health sweep cannot self-deny.
    maximumConnections: 8,
    password,
    port: parsed.databasePort,
    user: parsed.databaseUser,
  });
  let redis: RedisClientType | undefined;
  const close = createIdempotentCleanup(
    [
      {
        name: 'redis',
        close: () => {
          if (redis?.isOpen === true) {
            redis.destroy();
          }
        },
      },
      { name: 'postgres-ledger', close: () => ledger.close() },
    ],
    logger,
  );

  try {
    redis = createClient({
      database: parsed.redisDatabase,
      socket: {
        connectTimeout: 2_000,
        reconnectStrategy: false,
      },
      url: parsed.redisUrl,
    });
    redis.on('error', (error: Error) => {
      logger.warn('gateway.redis_error', { error });
    });
    await redis.connect();
    return { close, ledger, redis };
  } catch (error) {
    try {
      await close();
    } catch (cleanupError) {
      logger.error('gateway.dependency_startup_rollback_failed', { error: cleanupError });
    }
    throw error;
  }
}

async function main(): Promise<void> {
  const config = parseDevelopmentServiceEnvironment(process.env, EXPECTED_SERVICE);
  const logger = createLogger({
    minimumLevel: config.logLevel,
    service: config.serviceName,
  });
  const dependencies = await createDependencies(logger);
  let server: ServiceServer | undefined;
  const close = createIdempotentCleanup(
    [
      {
        name: 'http-server',
        close: async () => server?.close(),
      },
      { name: 'dependencies', close: () => dependencies.close() },
    ],
    logger,
  );

  try {
    server = createServiceServer({
      host: config.host,
      logger,
      port: config.port,
      readinessChecks: [
        { name: 'postgres-ledger', check: (signal) => dependencies.ledger.check(signal) },
        {
          name: 'redis-coordination',
          check: async (signal) => {
            if (
              !dependencies.redis.isReady ||
              (await dependencies.redis
                .withCommandOptions({
                  abortSignal: signal,
                  timeout: 1_500,
                })
                .ping()) !== 'PONG'
            ) {
              throw new Error('Redis coordination dependency is not ready');
            }
          },
        },
      ],
      route: ({ request, requestId, url }) => {
        if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/status')) {
          return {
            body: JSON.stringify({
              code: 'FOUNDATION_ONLY',
              message:
                'The development service is healthy; budget authorization is not implemented yet.',
              productionStatus: 'not yet in production',
              requestId,
            }),
            headers: { 'content-type': 'application/json; charset=utf-8' },
            status: 200,
          };
        }
        return undefined;
      },
      service: config.serviceName,
      version: config.serviceVersion,
    });

    const lifecycle: CloseableService = {
      listen: () => server?.listen() ?? Promise.reject(new Error('HTTP server is unavailable.')),
      close,
    };
    await runUntilSignalled(lifecycle, logger);
  } catch (error) {
    try {
      await close();
    } catch (cleanupError) {
      logger.error('gateway.service_startup_rollback_failed', { error: cleanupError });
    }
    throw error;
  }
}

await main().catch((error: unknown) => {
  const logger = createLogger({ service: EXPECTED_SERVICE.name });
  logger.error('service.start_failed', { error });
  process.exitCode = 1;
});
