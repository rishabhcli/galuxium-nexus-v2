import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { once } from 'node:events';

import {
  DEV_PATHS,
  HOST,
  POSTGRES,
  REDIS_DATABASE_INDEX,
  REPOSITORY_ROOT,
  SERVICE_VERSION,
  serviceLogPath,
  STARTUP_TIMEOUT_MS,
} from './constants.mjs';
import { execute, safeEnvironment } from './command.mjs';
import { DevContractError } from './errors.mjs';
import { assertRegularFileInsideRepository, atomicWrite } from './filesystem.mjs';
import { BoundedLogWriter } from './log-supervisor.mjs';
import {
  createProcessBirthIdentity,
  inspectProcess,
  processBirthIdentityArgument,
  writeOwnershipRecord,
} from './ownership.mjs';
import { waitForReadiness } from './readiness.mjs';
import { stopOwnershipRecord } from './down.mjs';

const REDIS_CONFIG_PATH = path.join(DEV_PATHS.redis, 'redis.conf');
const LOG_SUPERVISOR_ENTRY = path.join(REPOSITORY_ROOT, 'tooling', 'dev', 'log-supervisor.mjs');

async function appendLog(serviceName, value) {
  const writer = new BoundedLogWriter(serviceLogPath(serviceName));
  await writer.initialize();
  try {
    await writer.write(value);
  } finally {
    await writer.close();
  }
}

export async function validateCompiledEntries(services) {
  await assertRegularFileInsideRepository(LOG_SUPERVISOR_ENTRY);
  for (const service of services) {
    if (service.kind === 'node') {
      await assertRegularFileInsideRepository(service.entry);
    }
  }
}

async function spawnOwnedProcess({ args, argvNeedles, env, executable, runId, service }) {
  const birthIdentity = createProcessBirthIdentity();
  const birthArgument = processBirthIdentityArgument(birthIdentity);
  const configPath = path.join(
    DEV_PATHS.tmp,
    `supervisor.${service.name}.${runId}.${birthIdentity}.json`,
  );
  const logPath = serviceLogPath(service.name);
  const supervisorConfig = {
    args,
    birthIdentity,
    env,
    executable,
    logPath,
    redactionFilePaths: [POSTGRES.passwordFile, POSTGRES.ownerPasswordFile],
    repository: 'galuxium-nexus-v2',
    repositoryRoot: REPOSITORY_ROOT,
    schemaVersion: 1,
    service: service.name,
  };
  await atomicWrite(configPath, `${JSON.stringify(supervisorConfig)}\n`);
  let child;
  try {
    child = spawn(process.execPath, [LOG_SUPERVISOR_ENTRY, configPath, birthArgument], {
      cwd: REPOSITORY_ROOT,
      detached: true,
      env: safeEnvironment({ TMPDIR: DEV_PATHS.tmp }),
      shell: false,
      stdio: 'ignore',
      windowsHide: true,
    });
    await Promise.race([
      once(child, 'spawn'),
      once(child, 'error').then(([error]) => Promise.reject(error)),
    ]);
  } catch (error) {
    await fs.rm(configPath, { force: true });
    throw error;
  }

  let inspected;
  let inspectionFailure;
  for (let attempt = 0; attempt < 20 && !inspected; attempt += 1) {
    try {
      const candidate = await inspectProcess(child.pid);
      if (candidate?.command.includes(birthArgument)) {
        inspected = candidate;
      }
    } catch (error) {
      inspectionFailure = error;
    }
    if (!inspected) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  if (!inspected) {
    if (child.exitCode !== null || child.signalCode !== null) {
      await fs.rm(configPath, { force: true });
      throw new DevContractError(
        'DEV_PROCESS_DID_NOT_START',
        `${service.name} exited before exact ownership could be recorded. Inspect ${logPath}.`,
        { birthIdentity, pid: child.pid },
        { cause: inspectionFailure },
      );
    }
    throw new DevContractError(
      'DEV_PROCESS_IDENTITY_CLEANUP_UNPROVEN',
      `${service.name} PID ${String(child.pid)} could not be exactly inspected after spawn; no unverified signal was sent and failure attribution is retained.`,
      { birthIdentity, configPath, pid: child.pid },
      { cause: inspectionFailure },
    );
  }

  const transientRecord = {
    argvNeedles: [LOG_SUPERVISOR_ENTRY, birthArgument],
    birthIdentity,
    kernelBirthIdentity: inspected.kernelBirthIdentity ?? null,
    pid: child.pid,
    processGroupId: inspected.processGroupId,
    runId,
    service: service.name,
    startedAtEpochMs: inspected.startedAtEpochMs,
    supervisorConfigPath: configPath,
  };
  try {
    const record = await writeOwnershipRecord({
      ...transientRecord,
      targetArgvNeedles: argvNeedles,
      targetExecutable: executable,
    });
    child.unref();
    return { child, record };
  } catch (error) {
    try {
      await stopOwnershipRecord(transientRecord);
      await fs.rm(configPath, { force: true });
    } catch (cleanupError) {
      throw new DevContractError(
        'DEV_OWNERSHIP_WRITE_CLEANUP_UNPROVEN',
        `Ownership recording failed for ${service.name}, and bounded repeatedly-verified teardown could not prove exit. Failure attribution was retained.`,
        {
          birthIdentity,
          cleanupError: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
          pid: child.pid,
          startupError: error instanceof Error ? error.message : String(error),
        },
        { cause: cleanupError },
      );
    }
    throw error;
  }
}

function nodeEnvironment(service, runId) {
  return safeEnvironment({
    APP_ENV: 'development',
    DATABASE_HOST: HOST,
    DATABASE_NAME: POSTGRES.database,
    DATABASE_PASSWORD_FILE: POSTGRES.passwordFile,
    DATABASE_PORT: '4165',
    DATABASE_USER: POSTGRES.role,
    DEV_RUN_ID: runId,
    FAKE_PROVIDER_BASE_URL: `http://${HOST}:4163`,
    HOST,
    METRICS_HOST: HOST,
    METRICS_PORT: '4167',
    NODE_ENV: 'development',
    PORT: String(service.port),
    REDIS_DB: String(REDIS_DATABASE_INDEX),
    REDIS_URL: `redis://${HOST}:4166/${REDIS_DATABASE_INDEX}`,
    SERVICE_NAME: service.name,
    SERVICE_VERSION,
    TMPDIR: DEV_PATHS.tmp,
  });
}

export async function startNodeService(service, { runId, tools }) {
  const started = await spawnOwnedProcess({
    args: [service.entry],
    argvNeedles: [service.entry],
    env: nodeEnvironment(service, runId),
    executable: process.execPath,
    runId,
    service,
  });
  await Promise.race([
    waitForReadiness(service, { timeoutMs: STARTUP_TIMEOUT_MS, tools }),
    once(started.child, 'exit').then(([code, signal]) => {
      throw new DevContractError(
        'DEV_SERVICE_EXITED_DURING_START',
        `${service.name} exited before readiness (code=${code}, signal=${signal}). Inspect ${serviceLogPath(service.name)}.`,
      );
    }),
  ]);
  return started.record;
}

async function ensurePostgresCluster(tools) {
  let initialize = false;
  try {
    const dataDirectory = await fs.lstat(DEV_PATHS.postgresData);
    if (dataDirectory.isSymbolicLink() || !dataDirectory.isDirectory()) {
      throw new DevContractError(
        'DEV_POSTGRES_DATA_UNSAFE',
        `PostgreSQL data path is not a regular directory: ${DEV_PATHS.postgresData}`,
      );
    }
    const majorVersion = (
      await fs.readFile(path.join(DEV_PATHS.postgresData, 'PG_VERSION'), 'utf8')
    ).trim();
    if (majorVersion !== '16') {
      throw new DevContractError(
        'DEV_POSTGRES_DATA_VERSION',
        `PostgreSQL data directory requires major version 16, found ${majorVersion}.`,
      );
    }
  } catch (error) {
    if (error instanceof DevContractError) {
      throw error;
    }
    if (error?.code === 'ENOENT') {
      try {
        const entries = await fs.readdir(DEV_PATHS.postgresData);
        if (entries.length > 0) {
          throw new DevContractError(
            'DEV_POSTGRES_DATA_PARTIAL',
            'PostgreSQL data exists without PG_VERSION; refusing to delete or overwrite it.',
          );
        }
      } catch (readError) {
        if (readError instanceof DevContractError) {
          throw readError;
        }
        if (readError?.code !== 'ENOENT') {
          throw readError;
        }
      }
      initialize = true;
    } else {
      throw error;
    }
  }

  if (!initialize) {
    return;
  }
  const result = await execute(
    tools.initdb,
    [
      `--pgdata=${DEV_PATHS.postgresData}`,
      '--encoding=UTF8',
      '--locale=C',
      `--username=${POSTGRES.ownerRole}`,
      '--auth-local=scram-sha-256',
      '--auth-host=scram-sha-256',
      `--pwfile=${POSTGRES.ownerPasswordFile}`,
    ],
    { cwd: REPOSITORY_ROOT, timeout: 60_000 },
  );
  await appendLog('postgres', `${result.stdout}${result.stderr}`);
}

async function waitForPostgresServer(service, tools, ownerPassword) {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const result = await execute(
      tools.pg_isready,
      ['-h', HOST, '-p', String(service.port), '-U', POSTGRES.ownerRole, '-d', 'postgres'],
      {
        allowExitCodes: [0, 1, 2, 3],
        env: safeEnvironment({ PGPASSWORD: ownerPassword }),
        sensitiveValues: [ownerPassword],
        timeout: 2_000,
      },
    );
    if (result.exitCode === 0) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new DevContractError(
    'DEV_POSTGRES_START_TIMEOUT',
    `PostgreSQL did not accept connections within ${STARTUP_TIMEOUT_MS} ms. Inspect ${serviceLogPath(service.name)}.`,
  );
}

export function postgresBootstrapSql() {
  return [
    '\\set ON_ERROR_STOP 1',
    '\\set QUIET 1',
    // Defense in depth with PGOPTIONS below: the password-bearing generated
    // DDL must never be emitted through statement or error-statement logging.
    `SET log_statement = 'none';`,
    `SET log_min_error_statement = 'panic';`,
    '\\getenv runtime_password GALUXIUM_NEXUS_V2_RUNTIME_PASSWORD',
    `SELECT format('CREATE ROLE %I WITH LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 20', '${POSTGRES.role}', :'runtime_password')`,
    `WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${POSTGRES.role}') \\gexec`,
    `SELECT format('ALTER ROLE %I WITH LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 20', '${POSTGRES.role}', :'runtime_password') \\gexec`,
    `SELECT format('CREATE DATABASE %I WITH OWNER %I', '${POSTGRES.database}', '${POSTGRES.ownerRole}')`,
    `WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = '${POSTGRES.database}') \\gexec`,
    `ALTER DATABASE ${POSTGRES.database} OWNER TO ${POSTGRES.ownerRole};`,
    `REVOKE ALL ON DATABASE ${POSTGRES.database} FROM PUBLIC;`,
    `REVOKE ALL ON DATABASE ${POSTGRES.database} FROM ${POSTGRES.role};`,
    `GRANT CONNECT ON DATABASE ${POSTGRES.database} TO ${POSTGRES.role};`,
    `REVOKE CONNECT, TEMPORARY ON DATABASE postgres FROM PUBLIC;`,
    `REVOKE CONNECT, TEMPORARY ON DATABASE postgres FROM ${POSTGRES.role};`,
    `REVOKE CONNECT, TEMPORARY ON DATABASE template1 FROM PUBLIC;`,
    `REVOKE CONNECT, TEMPORARY ON DATABASE template1 FROM ${POSTGRES.role};`,
    '',
  ].join('\n');
}

export function postgresBootstrapEnvironment(ownerPassword, password) {
  return safeEnvironment({
    GALUXIUM_NEXUS_V2_RUNTIME_PASSWORD: password,
    PGCONNECT_TIMEOUT: '2',
    PGOPTIONS:
      '-c log_statement=none -c log_min_error_statement=panic -c log_duration=off -c log_min_duration_statement=-1',
    PGPASSWORD: ownerPassword,
  });
}

async function ensurePostgresDatabase(service, tools, ownerPassword, password) {
  const environment = postgresBootstrapEnvironment(ownerPassword, password);
  const bootstrapPath = path.join(
    DEV_PATHS.tmp,
    `postgres-bootstrap.${process.pid}.${crypto.randomUUID()}.sql`,
  );
  await atomicWrite(bootstrapPath, postgresBootstrapSql());
  try {
    await execute(
      tools.psql,
      [
        '-X',
        '--no-password',
        '-h',
        HOST,
        '-p',
        String(service.port),
        '-U',
        POSTGRES.ownerRole,
        '-d',
        'postgres',
        '-f',
        bootstrapPath,
      ],
      { env: environment, sensitiveValues: [ownerPassword, password] },
    );
  } finally {
    await fs.rm(bootstrapPath, { force: true });
  }

  const posture = await execute(
    tools.psql,
    [
      '-X',
      '--no-password',
      '-h',
      HOST,
      '-p',
      String(service.port),
      '-U',
      POSTGRES.ownerRole,
      '-d',
      'postgres',
      '-A',
      '-t',
      '-F',
      '|',
      '-v',
      'ON_ERROR_STOP=1',
      '-c',
      `SELECT pg_get_userbyid(d.datdba), r.rolcanlogin, r.rolsuper, r.rolcreatedb, r.rolcreaterole, r.rolinherit, r.rolreplication, r.rolbypassrls, r.rolconnlimit, pg_has_role('${POSTGRES.role}', '${POSTGRES.ownerRole}', 'MEMBER'), has_database_privilege('${POSTGRES.role}', '${POSTGRES.database}', 'CONNECT'), has_database_privilege('${POSTGRES.role}', '${POSTGRES.database}', 'TEMPORARY'), has_database_privilege('${POSTGRES.role}', 'postgres', 'CONNECT'), has_database_privilege('${POSTGRES.role}', 'postgres', 'TEMPORARY'), has_database_privilege('${POSTGRES.role}', 'template1', 'CONNECT'), has_database_privilege('${POSTGRES.role}', 'template1', 'TEMPORARY') FROM pg_database d CROSS JOIN pg_roles r WHERE d.datname = '${POSTGRES.database}' AND r.rolname = '${POSTGRES.role}';`,
    ],
    { env: environment, sensitiveValues: [ownerPassword, password] },
  );
  const expectedPosture = `${POSTGRES.ownerRole}|t|f|f|f|f|f|f|20|f|t|f|f|f|f|f`;
  if (posture.stdout.trim() !== expectedPosture) {
    throw new DevContractError(
      'DEV_POSTGRES_LEAST_PRIVILEGE',
      'PostgreSQL runtime role or database ownership does not match the least-privilege development contract.',
      { expected: expectedPosture, received: posture.stdout.trim() },
    );
  }
}

export function postgresServerArguments(service) {
  return [
    '-D',
    DEV_PATHS.postgresData,
    '-h',
    HOST,
    '-p',
    String(service.port),
    '-k',
    DEV_PATHS.postgresSocket,
    '-c',
    'password_encryption=scram-sha-256',
    '-c',
    'max_connections=50',
    '-c',
    'shared_buffers=64MB',
    '-c',
    'fsync=on',
    '-c',
    'synchronous_commit=on',
    '-c',
    'full_page_writes=on',
    '-c',
    'timezone=UTC',
    '-c',
    'ssl=off',
    '-c',
    'log_statement=none',
    '-c',
    'log_min_error_statement=error',
    '-c',
    'log_duration=off',
    '-c',
    'log_min_duration_statement=-1',
  ];
}

export async function startPostgres(service, { ownerPassword, password, runId, tools }) {
  await ensurePostgresCluster(tools);
  const args = postgresServerArguments(service);
  const started = await spawnOwnedProcess({
    args,
    argvNeedles: [DEV_PATHS.postgresData, String(service.port)],
    env: safeEnvironment({ TMPDIR: DEV_PATHS.tmp }),
    executable: tools.postgres,
    runId,
    service,
  });
  await Promise.race([
    (async () => {
      await waitForPostgresServer(service, tools, ownerPassword);
      await ensurePostgresDatabase(service, tools, ownerPassword, password);
      await waitForReadiness(service, { timeoutMs: STARTUP_TIMEOUT_MS, tools });
    })(),
    once(started.child, 'exit').then(([code, signal]) => {
      throw new DevContractError(
        'DEV_POSTGRES_EXITED_DURING_START',
        `PostgreSQL exited before readiness (code=${code}, signal=${signal}). Inspect ${serviceLogPath(service.name)}.`,
      );
    }),
  ]);
  return started.record;
}

async function writeRedisConfiguration(service) {
  const config = [
    `bind ${HOST}`,
    'protected-mode yes',
    `port ${service.port}`,
    'daemonize no',
    'supervised no',
    `pidfile ${path.join(DEV_PATHS.redis, 'redis.pid')}`,
    `dir ${DEV_PATHS.redis}`,
    'dbfilename cache.rdb',
    'save ""',
    'appendonly no',
    'databases 16',
    'maxmemory 128mb',
    'maxmemory-policy noeviction',
    'logfile ""',
    'loglevel notice',
    '',
  ].join('\n');
  await atomicWrite(REDIS_CONFIG_PATH, config);
}

export async function startRedis(service, { runId, tools }) {
  await writeRedisConfiguration(service);
  const started = await spawnOwnedProcess({
    args: [REDIS_CONFIG_PATH],
    // Redis intentionally rewrites its process title after startup. These
    // stable title fields remain attributable after that rewrite.
    argvNeedles: ['redis-server', `${HOST}:${service.port}`],
    env: safeEnvironment({ TMPDIR: DEV_PATHS.tmp }),
    executable: tools['redis-server'],
    runId,
    service,
  });
  await Promise.race([
    waitForReadiness(service, { timeoutMs: STARTUP_TIMEOUT_MS, tools }),
    once(started.child, 'exit').then(([code, signal]) => {
      throw new DevContractError(
        'DEV_REDIS_EXITED_DURING_START',
        `Redis exited before readiness (code=${code}, signal=${signal}). Inspect ${serviceLogPath(service.name)}.`,
      );
    }),
  ]);
  return started.record;
}

export function createRunId() {
  return crypto.randomUUID();
}
