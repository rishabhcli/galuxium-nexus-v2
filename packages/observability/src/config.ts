import { z } from 'zod';

import type { LogLevel } from './logger.js';

const environmentSchema = z
  .object({
    DEV_RUN_ID: z.string().min(1).max(128),
    HOST: z.literal('127.0.0.1'),
    LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
    NODE_ENV: z.literal('development'),
    PORT: z.coerce.number().int().min(4160).max(4169),
    SERVICE_NAME: z.string().min(1).max(64),
    SERVICE_VERSION: z.string().regex(/^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?$/),
  })
  .strict();

const foundationDependencyEnvironmentSchema = z
  .object({
    DATABASE_HOST: z.literal('127.0.0.1'),
    DATABASE_NAME: z.literal('galuxium_nexus_v2'),
    DATABASE_PASSWORD_FILE: z.string().min(1).max(4_096),
    DATABASE_PORT: z.literal('4165'),
    DATABASE_USER: z.literal('galuxium_nexus_v2'),
    REDIS_DB: z.literal('6'),
    REDIS_URL: z.literal('redis://127.0.0.1:4166/6'),
  })
  .strict();

export interface DevelopmentServiceConfig {
  readonly devRunId: string;
  readonly host: '127.0.0.1';
  readonly logLevel: LogLevel;
  readonly port: number;
  readonly serviceName: string;
  readonly serviceVersion: string;
}

export interface FoundationDependencyConfig {
  readonly databaseHost: '127.0.0.1';
  readonly databaseName: 'galuxium_nexus_v2';
  readonly databasePasswordFile: string;
  readonly databasePort: 4165;
  readonly databaseUser: 'galuxium_nexus_v2';
  readonly redisDatabase: 6;
  readonly redisUrl: 'redis://127.0.0.1:4166/6';
}

export function parseDevelopmentServiceEnvironment(
  environment: NodeJS.ProcessEnv,
  expected: { readonly name: string; readonly port: number },
): DevelopmentServiceConfig {
  const candidate = {
    DEV_RUN_ID: environment['DEV_RUN_ID'],
    HOST: environment['HOST'],
    LOG_LEVEL: environment['LOG_LEVEL'],
    NODE_ENV: environment['NODE_ENV'],
    PORT: environment['PORT'],
    SERVICE_NAME: environment['SERVICE_NAME'],
    SERVICE_VERSION: environment['SERVICE_VERSION'],
  };
  const parsed = environmentSchema.parse(candidate);
  if (parsed.SERVICE_NAME !== expected.name) {
    throw new Error(
      `Service identity mismatch: expected ${expected.name}, received ${parsed.SERVICE_NAME}`,
    );
  }
  if (parsed.PORT !== expected.port) {
    throw new Error(`Service port mismatch: expected ${String(expected.port)}`);
  }
  return {
    devRunId: parsed.DEV_RUN_ID,
    host: parsed.HOST,
    logLevel: parsed.LOG_LEVEL,
    port: parsed.PORT,
    serviceName: parsed.SERVICE_NAME,
    serviceVersion: parsed.SERVICE_VERSION,
  };
}

export function parseFoundationDependencyEnvironment(
  environment: NodeJS.ProcessEnv,
): FoundationDependencyConfig {
  const parsed = foundationDependencyEnvironmentSchema.parse({
    DATABASE_HOST: environment['DATABASE_HOST'],
    DATABASE_NAME: environment['DATABASE_NAME'],
    DATABASE_PASSWORD_FILE: environment['DATABASE_PASSWORD_FILE'],
    DATABASE_PORT: environment['DATABASE_PORT'],
    DATABASE_USER: environment['DATABASE_USER'],
    REDIS_DB: environment['REDIS_DB'],
    REDIS_URL: environment['REDIS_URL'],
  });
  return {
    databaseHost: parsed.DATABASE_HOST,
    databaseName: parsed.DATABASE_NAME,
    databasePasswordFile: parsed.DATABASE_PASSWORD_FILE,
    databasePort: 4165,
    databaseUser: parsed.DATABASE_USER,
    redisDatabase: 6,
    redisUrl: parsed.REDIS_URL,
  };
}
