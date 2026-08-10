import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPOSITORY_NAME = 'galuxium-nexus-v2';
export const REQUIRED_NODE_VERSION = '24.18.0';
export const REQUIRED_NPM_VERSION = '11.16.0';
export const REQUIRED_POSTGRES_VERSION = '16.14';
export const REQUIRED_REDIS_VERSION = '8.10.0';
export const REQUIRED_TYPESCRIPT_VERSION = '6.0.3';
export const SERVICE_VERSION = '0.1.0';
export const HOST = '127.0.0.1';
export const PORT_BLOCK = Object.freeze(Array.from({ length: 10 }, (_, index) => 4160 + index));

export const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const PORTS_ENV_PATH = path.join(REPOSITORY_ROOT, 'ports.env');
export const DEV_ROOT = path.join(REPOSITORY_ROOT, '.dev');
export const DEV_PATHS = Object.freeze({
  root: DEV_ROOT,
  cache: path.join(DEV_ROOT, 'cache'),
  logs: path.join(DEV_ROOT, 'logs'),
  pids: path.join(DEV_ROOT, 'pids'),
  playwrightProfile: path.join(DEV_ROOT, 'pw-profile'),
  postgres: path.join(DEV_ROOT, 'postgres'),
  postgresData: path.join(DEV_ROOT, 'postgres', 'data'),
  postgresSocket: path.join(DEV_ROOT, 'postgres', 'socket'),
  redis: path.join(DEV_ROOT, 'redis'),
  secrets: path.join(DEV_ROOT, 'secrets'),
  tmp: path.join(DEV_ROOT, 'tmp'),
});

export const POSTGRES = Object.freeze({
  database: 'galuxium_nexus_v2',
  ownerPasswordFile: path.join(DEV_PATHS.secrets, 'postgres-owner-password'),
  ownerRole: 'galuxium_nexus_v2_owner',
  role: 'galuxium_nexus_v2',
  passwordFile: path.join(DEV_PATHS.secrets, 'postgres-password'),
});

export const REDIS_DATABASE_INDEX = 6;

export const EXPECTED_PORTS = Object.freeze({
  PORT_0: 4160,
  PORT_1: 4161,
  PORT_2: 4162,
  PORT_3: 4163,
  PORT_5: 4165,
  PORT_6: 4166,
  PORT_7: 4167,
});

export const SERVICE_DEFINITIONS = Object.freeze([
  Object.freeze({
    name: 'gateway',
    kind: 'node',
    port: EXPECTED_PORTS.PORT_0,
    entry: path.join(REPOSITORY_ROOT, 'services/gateway/dist/src/server.js'),
    readinessPath: '/readyz',
  }),
  Object.freeze({
    name: 'reconciler',
    kind: 'node',
    port: EXPECTED_PORTS.PORT_1,
    entry: path.join(REPOSITORY_ROOT, 'services/reconciler/dist/src/server.js'),
    readinessPath: '/readyz',
  }),
  Object.freeze({
    name: 'admin',
    kind: 'node',
    port: EXPECTED_PORTS.PORT_2,
    entry: path.join(REPOSITORY_ROOT, 'apps/admin/dist/src/server.js'),
    readinessPath: '/readyz',
  }),
  Object.freeze({
    name: 'fake-provider',
    kind: 'node',
    port: EXPECTED_PORTS.PORT_3,
    entry: path.join(REPOSITORY_ROOT, 'services/fake-provider/dist/src/server.js'),
    readinessPath: '/readyz',
  }),
  Object.freeze({
    name: 'postgres',
    kind: 'postgres',
    port: EXPECTED_PORTS.PORT_5,
  }),
  Object.freeze({
    name: 'redis',
    kind: 'redis',
    port: EXPECTED_PORTS.PORT_6,
  }),
  Object.freeze({
    name: 'metrics',
    kind: 'node',
    port: EXPECTED_PORTS.PORT_7,
    entry: path.join(REPOSITORY_ROOT, 'services/metrics/dist/src/server.js'),
    readinessPath: '/readyz',
    metricsPath: '/metrics',
  }),
]);

export const SERVICE_BY_NAME = new Map(
  SERVICE_DEFINITIONS.map((service) => [service.name, service]),
);
export const SERVICE_BY_PORT = new Map(
  SERVICE_DEFINITIONS.map((service) => [service.port, service]),
);

export const START_ORDER = Object.freeze([
  'postgres',
  'redis',
  'fake-provider',
  'gateway',
  'reconciler',
  'admin',
  'metrics',
]);
export const STOP_ORDER = Object.freeze([...START_ORDER].reverse());

export const STARTUP_TIMEOUT_MS = 30_000;
// A readiness request may fan out through the metrics service to every other
// readiness surface.  Keep the client deadline above the services' 5 second
// request deadline so machine contention produces a truthful 503 rather than
// a false "unreachable" result from an impatient health client.
export const READINESS_REQUEST_TIMEOUT_MS = 6_000;
export const SHUTDOWN_TIMEOUT_MS = 10_000;
export const POSTGRES_SHUTDOWN_TIMEOUT_MS = 20_000;
export const COMMAND_TIMEOUT_MS = 5_000;
export const MAX_HEALTH_BODY_BYTES = 64 * 1024;

export function serviceLogPath(serviceName) {
  return path.join(DEV_PATHS.logs, `${serviceName}.log`);
}

export function pidPath(serviceName) {
  return path.join(DEV_PATHS.pids, `${serviceName}.pid`);
}

export function metadataPath(serviceName) {
  return path.join(DEV_PATHS.pids, `${serviceName}.meta.json`);
}

export function serviceUrl(service, pathname = service.readinessPath) {
  return `http://${HOST}:${service.port}${pathname}`;
}
