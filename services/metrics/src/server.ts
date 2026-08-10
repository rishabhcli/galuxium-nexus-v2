import {
  createLogger,
  createServiceServer,
  fetchServiceReadiness,
  MetricRegistry,
  parseDevelopmentServiceEnvironment,
  runUntilSignalled,
} from '@galuxium-nexus-v2/observability';

const EXPECTED_SERVICE = { name: 'metrics', port: 4167 } as const;

const DEPENDENCIES = [
  { name: 'gateway', url: 'http://127.0.0.1:4160/readyz' },
  { name: 'reconciler', url: 'http://127.0.0.1:4161/readyz' },
  { name: 'admin', url: 'http://127.0.0.1:4162/readyz' },
  { name: 'fake-provider', url: 'http://127.0.0.1:4163/readyz' },
] as const;

async function assertReady(
  dependency: (typeof DEPENDENCIES)[number],
  signal: AbortSignal,
): Promise<void> {
  const readiness = await fetchServiceReadiness({
    expectedService: dependency.name,
    signal,
    url: dependency.url,
  });
  if (readiness.status !== 'ready') {
    throw new Error('The dependency readiness response was not ready.');
  }
}

async function main(): Promise<void> {
  const config = parseDevelopmentServiceEnvironment(process.env, EXPECTED_SERVICE);
  const logger = createLogger({
    minimumLevel: config.logLevel,
    service: config.serviceName,
  });
  const metrics = new MetricRegistry();
  metrics.defineGauge(
    'galuxium_nexus_v2_foundation_dependencies_expected',
    'Number of foundation service dependencies expected by the metrics endpoint.',
  );
  metrics.set('galuxium_nexus_v2_foundation_dependencies_expected', DEPENDENCIES.length);

  const server = createServiceServer({
    host: config.host,
    logger,
    metrics,
    port: config.port,
    readinessChecks: DEPENDENCIES.map((dependency) => ({
      name: dependency.name,
      check: (signal) => assertReady(dependency, signal),
    })),
    route: ({ request, requestId, url }) => {
      if (request.method === 'GET' && url.pathname === '/') {
        return {
          body: JSON.stringify({
            metrics: '/metrics',
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
  await runUntilSignalled(server, logger);
}

await main().catch((error: unknown) => {
  const logger = createLogger({ service: EXPECTED_SERVICE.name });
  logger.error('service.start_failed', { error });
  process.exitCode = 1;
});
