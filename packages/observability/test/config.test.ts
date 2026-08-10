import { describe, expect, it } from 'vitest';

import {
  parseDevelopmentServiceEnvironment,
  parseFoundationDependencyEnvironment,
} from '../src/config.js';

const EXPECTED_IDENTITY = {
  name: 'metrics',
  port: 4167,
} as const;

const VALID_ENVIRONMENT = {
  DEV_RUN_ID: 'development-run-0001',
  HOST: '127.0.0.1',
  LOG_LEVEL: 'warn',
  NODE_ENV: 'development',
  PORT: '4167',
  SERVICE_NAME: 'metrics',
  SERVICE_VERSION: '0.1.0',
} satisfies NodeJS.ProcessEnv;

function environmentWith(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { ...VALID_ENVIRONMENT, ...overrides };
}

describe('parseDevelopmentServiceEnvironment', () => {
  it('accepts only the expected service identity on its exact allocated loopback address', () => {
    expect(parseDevelopmentServiceEnvironment(environmentWith(), EXPECTED_IDENTITY)).toEqual({
      devRunId: 'development-run-0001',
      host: '127.0.0.1',
      logLevel: 'warn',
      port: 4167,
      serviceName: 'metrics',
      serviceVersion: '0.1.0',
    });
  });

  it('defaults the optional log level without weakening any required identity field', () => {
    expect(
      parseDevelopmentServiceEnvironment(
        environmentWith({ LOG_LEVEL: undefined }),
        EXPECTED_IDENTITY,
      ),
    ).toMatchObject({
      host: '127.0.0.1',
      logLevel: 'info',
      port: 4167,
      serviceName: 'metrics',
    });
  });

  it.each(['localhost', '0.0.0.0', '::1', '', undefined])(
    'refuses non-exact loopback host %j',
    (host) => {
      expect(() =>
        parseDevelopmentServiceEnvironment(environmentWith({ HOST: host }), EXPECTED_IDENTITY),
      ).toThrow();
    },
  );

  it.each(['gateway', 'Metrics', '', undefined])(
    'refuses wrong or missing service identity %j',
    (serviceName) => {
      expect(() =>
        parseDevelopmentServiceEnvironment(
          environmentWith({ SERVICE_NAME: serviceName }),
          EXPECTED_IDENTITY,
        ),
      ).toThrow();
    },
  );

  it.each(['4160', '4161', '4162', '4163', '4165', '4166', '4168', '4169'])(
    'refuses in-block port %s when it is not allocated to the expected service',
    (port) => {
      expect(() =>
        parseDevelopmentServiceEnvironment(environmentWith({ PORT: port }), EXPECTED_IDENTITY),
      ).toThrow(`Service port mismatch: expected ${String(EXPECTED_IDENTITY.port)}`);
    },
  );

  it.each(['4159', '4170', '4167.5', 'not-a-port', '', undefined])(
    'refuses out-of-block, non-integral, or missing port %j',
    (port) => {
      expect(() =>
        parseDevelopmentServiceEnvironment(environmentWith({ PORT: port }), EXPECTED_IDENTITY),
      ).toThrow();
    },
  );

  it.each([
    ['unknown log level', { LOG_LEVEL: 'trace' }],
    ['wrong environment', { NODE_ENV: 'production' }],
    ['unversioned service', { SERVICE_VERSION: 'latest' }],
    ['missing run identity', { DEV_RUN_ID: undefined }],
  ] as const)('refuses %s configuration values', (_description, override) => {
    expect(() =>
      parseDevelopmentServiceEnvironment(environmentWith(override), EXPECTED_IDENTITY),
    ).toThrow();
  });
});

describe('parseFoundationDependencyEnvironment', () => {
  const validEnvironment = {
    DATABASE_HOST: '127.0.0.1',
    DATABASE_NAME: 'galuxium_nexus_v2',
    DATABASE_PASSWORD_FILE: '/repository/galuxium-nexus-v2/.dev/secrets/postgres-password',
    DATABASE_PORT: '4165',
    DATABASE_USER: 'galuxium_nexus_v2',
    REDIS_DB: '6',
    REDIS_URL: 'redis://127.0.0.1:4166/6',
  } satisfies NodeJS.ProcessEnv;

  it('accepts only the exact repository PostgreSQL and Redis namespaces', () => {
    expect(parseFoundationDependencyEnvironment(validEnvironment)).toEqual({
      databaseHost: '127.0.0.1',
      databaseName: 'galuxium_nexus_v2',
      databasePasswordFile: '/repository/galuxium-nexus-v2/.dev/secrets/postgres-password',
      databasePort: 4165,
      databaseUser: 'galuxium_nexus_v2',
      redisDatabase: 6,
      redisUrl: 'redis://127.0.0.1:4166/6',
    });
  });

  it.each([
    ['Redis host alias', { REDIS_URL: 'redis://localhost:4166/6' }],
    ['Redis credentials', { REDIS_URL: 'redis://user:password@127.0.0.1:4166/6' }],
    ['Redis query', { REDIS_URL: 'redis://127.0.0.1:4166/6?token=private' }],
    ['Redis database URL', { REDIS_URL: 'redis://127.0.0.1:4166/5' }],
    ['Redis database field', { REDIS_DB: '5' }],
    ['PostgreSQL port', { DATABASE_PORT: '5432' }],
  ] as const)('refuses %s drift', (_description, override) => {
    expect(() =>
      parseFoundationDependencyEnvironment({ ...validEnvironment, ...override }),
    ).toThrow();
  });
});
