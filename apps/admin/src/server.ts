import {
  createLogger,
  createServiceServer,
  fetchServiceReadiness,
  parseDevelopmentServiceEnvironment,
  runUntilSignalled,
  type Logger,
} from '@galuxium-nexus-v2/observability';

const EXPECTED_SERVICE = { name: 'admin', port: 4162 } as const;

interface DependencyStatus {
  readonly name: string;
  readonly ready: boolean;
}

const DEPENDENCIES = [
  { name: 'Gateway', service: 'gateway', url: 'http://127.0.0.1:4160/readyz' },
  { name: 'Reconciler', service: 'reconciler', url: 'http://127.0.0.1:4161/readyz' },
] as const;

async function inspectDependency(
  dependency: (typeof DEPENDENCIES)[number],
  signal: AbortSignal,
  logger: Logger,
): Promise<DependencyStatus> {
  try {
    const readiness = await fetchServiceReadiness({
      expectedService: dependency.service,
      signal,
      url: dependency.url,
    });
    return { name: dependency.name, ready: readiness.status === 'ready' };
  } catch (error) {
    logger.warn('admin.dependency_check_failed', {
      dependency: dependency.name,
      error,
    });
    return { name: dependency.name, ready: false };
  }
}

async function inspectDependencies(
  signal: AbortSignal,
  logger: Logger,
): Promise<readonly DependencyStatus[]> {
  return Promise.all(
    DEPENDENCIES.map((dependency) => inspectDependency(dependency, signal, logger)),
  );
}

const stylesheet = `
:root { color-scheme: dark; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; background: #0b0d10; color: #f4f7fa; }
main { width: min(64rem, calc(100% - 2rem)); margin: 0 auto; padding: 4rem 0; }
.eyebrow { color: #9aa7b4; letter-spacing: .12em; text-transform: uppercase; }
h1 { max-width: 18ch; font: 600 clamp(2rem, 7vw, 5rem)/.96 system-ui, sans-serif; margin: 1rem 0 2rem; }
.notice { border-left: .35rem solid #f2bd4a; background: #18150d; padding: 1rem 1.25rem; max-width: 50rem; }
dl { display: grid; grid-template-columns: minmax(10rem, 1fr) 2fr; max-width: 46rem; margin-top: 2.5rem; border-top: 1px solid #303840; }
dt, dd { margin: 0; padding: .85rem 0; border-bottom: 1px solid #303840; }
dd { text-align: right; }
.ready::before { content: "Ready — "; color: #78dba9; }
.not-ready::before { content: "Not ready — "; color: #ff8c82; }
a { color: #a8c7ff; }
@media (max-width: 36rem) { dl { grid-template-columns: 1fr; } dd { text-align: left; padding-top: 0; } }
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { scroll-behavior: auto !important; } }
`;

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function renderPage(statuses: readonly DependencyStatus[], requestId: string): string {
  const rows = statuses
    .map(
      (status) =>
        `<dt>${escapeHtml(status.name)}</dt><dd class="${status.ready ? 'ready' : 'not-ready'}">${status.ready ? 'dependency check passed' : 'dependency check failed'}</dd>`,
    )
    .join('');
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Development service status</title>
  <link rel="stylesheet" href="/styles.css">
</head>
<body>
  <main>
    <p class="eyebrow">Development foundation</p>
    <h1>Hard budget control plane</h1>
    <p class="notice"><strong>Not yet in production.</strong> This surface reports real local dependency health only. Budget authorization and ledger workflows are not implemented yet.</p>
    <h2>Dependency readiness</h2>
    <dl>${rows}</dl>
    <p>Request ID: <code>${escapeHtml(requestId)}</code></p>
  </main>
</body>
</html>`;
}

async function main(): Promise<void> {
  const config = parseDevelopmentServiceEnvironment(process.env, EXPECTED_SERVICE);
  const logger = createLogger({
    minimumLevel: config.logLevel,
    service: config.serviceName,
  });
  const readinessChecks = DEPENDENCIES.map((dependency) => ({
    name: dependency.name.toLowerCase(),
    check: async (signal: AbortSignal) => {
      const result = await inspectDependency(dependency, signal, logger);
      if (!result.ready) {
        throw new Error(`${dependency.name} is not ready`);
      }
    },
  }));
  const server = createServiceServer({
    host: config.host,
    logger,
    port: config.port,
    readinessChecks,
    route: async ({ request, requestId, signal, url }) => {
      if (request.method === 'GET' && url.pathname === '/styles.css') {
        return {
          body: stylesheet,
          headers: {
            'content-type': 'text/css; charset=utf-8',
            'x-content-type-options': 'nosniff',
          },
          status: 200,
        };
      }

      if (request.method === 'GET' && url.pathname === '/api/status') {
        const dependencies = await inspectDependencies(signal, logger);
        const ready = dependencies.every((dependency) => dependency.ready);
        return {
          body: JSON.stringify({
            dependencies,
            productionStatus: 'not yet in production',
            requestId,
            status: ready ? 'ready' : 'not_ready',
          }),
          headers: {
            'content-type': 'application/json; charset=utf-8',
            'x-content-type-options': 'nosniff',
          },
          status: ready ? 200 : 503,
        };
      }

      if (request.method === 'GET' && url.pathname === '/') {
        const dependencies = await inspectDependencies(signal, logger);
        return {
          body: renderPage(dependencies, requestId),
          headers: {
            'content-security-policy':
              "default-src 'none'; style-src 'self'; base-uri 'none'; frame-ancestors 'none'",
            'content-type': 'text/html; charset=utf-8',
            'referrer-policy': 'no-referrer',
            'x-content-type-options': 'nosniff',
            'x-frame-options': 'DENY',
          },
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
