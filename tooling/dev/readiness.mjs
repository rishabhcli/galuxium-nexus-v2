import {
  HOST,
  MAX_HEALTH_BODY_BYTES,
  POSTGRES,
  READINESS_REQUEST_TIMEOUT_MS,
  REDIS_DATABASE_INDEX,
  REQUIRED_POSTGRES_VERSION,
  REQUIRED_REDIS_VERSION,
  SERVICE_VERSION,
  serviceUrl,
} from './constants.mjs';
import { execute, findExecutable, safeEnvironment } from './command.mjs';
import { DevContractError, errorMessage } from './errors.mjs';
import { readCanonicalDevSecretFile } from './filesystem.mjs';

const PROMETHEUS_SAMPLE =
  /^[a-zA-Z_:][a-zA-Z0-9_:]*(?:\{[^\r\n}]*\})?\s+(?:[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?)$/mu;
const REQUIRED_POSTGRES_VERSION_NUMBER = '160014';

async function readBoundedResponseBody(response, serviceName) {
  const declaredLength = response.headers.get('content-length');
  if (declaredLength !== null) {
    if (!/^[0-9]+$/u.test(declaredLength) || Number(declaredLength) > MAX_HEALTH_BODY_BYTES) {
      throw new DevContractError(
        'DEV_HEALTH_BODY_TOO_LARGE',
        `${serviceName} declared an unsafe readiness response size.`,
      );
    }
  }
  if (response.body === null) {
    return '';
  }
  const reader = response.body.getReader();
  const chunks = [];
  let receivedBytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      receivedBytes += value.byteLength;
      if (receivedBytes > MAX_HEALTH_BODY_BYTES) {
        await reader.cancel('readiness body limit exceeded');
        throw new DevContractError(
          'DEV_HEALTH_BODY_TOO_LARGE',
          `${serviceName} returned more than ${MAX_HEALTH_BODY_BYTES} bytes from its readiness surface.`,
        );
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  if (declaredLength !== null && Number(declaredLength) !== receivedBytes) {
    throw new DevContractError(
      'DEV_HEALTH_BODY_LENGTH',
      `${serviceName} readiness response length did not match its Content-Length.`,
    );
  }
  return Buffer.concat(chunks, receivedBytes).toString('utf8');
}

async function fetchBounded(url, serviceName, timeoutMs = READINESS_REQUEST_TIMEOUT_MS) {
  let response;
  try {
    response = await fetch(url, {
      cache: 'no-store',
      headers: { accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new DevContractError(
      'DEV_HEALTH_HTTP_UNREACHABLE',
      `${serviceName} readiness request failed: ${errorMessage(error)}`,
      undefined,
      { cause: error },
    );
  }
  let body;
  try {
    body = await readBoundedResponseBody(response, serviceName);
  } catch (error) {
    if (error instanceof DevContractError) {
      throw error;
    }
    throw new DevContractError(
      'DEV_HEALTH_HTTP_BODY',
      `${serviceName} readiness response body could not be read safely.`,
      undefined,
      { cause: error },
    );
  }
  return { body, response };
}

export async function checkHttpReadiness(service, timeoutMs = READINESS_REQUEST_TIMEOUT_MS) {
  const url = serviceUrl(service);
  const { body, response } = await fetchBounded(url, service.name, timeoutMs);
  if (response.status !== 200) {
    throw new DevContractError(
      'DEV_HEALTH_HTTP_STATUS',
      `${service.name} readiness returned HTTP ${response.status}, expected 200.`,
    );
  }
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().includes('application/json')) {
    throw new DevContractError(
      'DEV_HEALTH_CONTENT_TYPE',
      `${service.name} readiness must return application/json.`,
      { contentType },
    );
  }
  let value;
  try {
    value = JSON.parse(body);
  } catch (error) {
    throw new DevContractError(
      'DEV_HEALTH_JSON',
      `${service.name} readiness returned malformed JSON.`,
      undefined,
      { cause: error },
    );
  }
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    value.status !== 'ready' ||
    value.service !== service.name ||
    value.version !== SERVICE_VERSION
  ) {
    throw new DevContractError(
      'DEV_HEALTH_SCHEMA',
      `${service.name} readiness did not satisfy the versioned local readiness contract.`,
      {
        receivedArray: Array.isArray(value),
        receivedObject: typeof value === 'object' && value !== null,
        serviceMatches: value?.service === service.name,
        statusMatches: value?.status === 'ready',
        versionMatches: value?.version === SERVICE_VERSION,
      },
    );
  }
  return {
    detail: `HTTP 200 service=${value.service} version=${value.version}`,
    service: service.name,
  };
}

export async function checkPostgresReadiness(
  service,
  tools = undefined,
  timeoutMs = READINESS_REQUEST_TIMEOUT_MS,
) {
  const password = await readCanonicalDevSecretFile(POSTGRES.passwordFile);
  const psql = tools?.psql ?? (await findExecutable('psql'));
  const result = await execute(
    psql,
    [
      '-X',
      '--no-password',
      '-h',
      HOST,
      '-p',
      String(service.port),
      '-U',
      POSTGRES.role,
      '-d',
      POSTGRES.database,
      '-A',
      '-t',
      '-F',
      '|',
      '-v',
      'ON_ERROR_STOP=1',
      '-c',
      `SELECT current_database(), current_user, current_setting('server_version_num'), host(inet_server_addr()), inet_server_port()::text, pg_get_userbyid(d.datdba), r.rolcanlogin, r.rolsuper, r.rolcreatedb, r.rolcreaterole, r.rolinherit, r.rolreplication, r.rolbypassrls, r.rolconnlimit, pg_has_role(current_user, '${POSTGRES.ownerRole}', 'MEMBER'), has_database_privilege(current_user, current_database(), 'CONNECT'), has_database_privilege(current_user, current_database(), 'TEMPORARY'), has_database_privilege(current_user, 'postgres', 'CONNECT'), has_database_privilege(current_user, 'postgres', 'TEMPORARY'), has_database_privilege(current_user, 'template1', 'CONNECT'), has_database_privilege(current_user, 'template1', 'TEMPORARY') FROM pg_database d CROSS JOIN pg_roles r WHERE d.datname = current_database() AND r.rolname = current_user;`,
    ],
    {
      env: safeEnvironment({
        PGCONNECT_TIMEOUT: '2',
        PGPASSWORD: password,
      }),
      sensitiveValues: [password],
      timeout: timeoutMs,
    },
  );
  const [
    database,
    role,
    version,
    address,
    port,
    databaseOwner,
    canLogin,
    superuser,
    canCreateDatabase,
    canCreateRole,
    inherits,
    canReplicate,
    bypassesRowSecurity,
    connectionLimit,
    ownsOwnerRole,
    appDatabaseConnect,
    appDatabaseTemporary,
    postgresDatabaseConnect,
    postgresDatabaseTemporary,
    templateDatabaseConnect,
    templateDatabaseTemporary,
  ] = result.stdout.trim().split('|');
  if (
    database !== POSTGRES.database ||
    role !== POSTGRES.role ||
    version !== REQUIRED_POSTGRES_VERSION_NUMBER ||
    address !== HOST ||
    port !== String(service.port) ||
    databaseOwner !== POSTGRES.ownerRole ||
    canLogin !== 't' ||
    superuser !== 'f' ||
    canCreateDatabase !== 'f' ||
    canCreateRole !== 'f' ||
    inherits !== 'f' ||
    canReplicate !== 'f' ||
    bypassesRowSecurity !== 'f' ||
    connectionLimit !== '20' ||
    ownsOwnerRole !== 'f' ||
    appDatabaseConnect !== 't' ||
    appDatabaseTemporary !== 'f' ||
    postgresDatabaseConnect !== 'f' ||
    postgresDatabaseTemporary !== 'f' ||
    templateDatabaseConnect !== 'f' ||
    templateDatabaseTemporary !== 'f'
  ) {
    throw new DevContractError(
      'DEV_POSTGRES_IDENTITY',
      'PostgreSQL accepted a query but did not match the required namespace, version, address, and port.',
      {
        address,
        bypassesRowSecurity,
        canCreateDatabase,
        canCreateRole,
        canLogin,
        canReplicate,
        connectionLimit,
        database,
        appDatabaseConnect,
        appDatabaseTemporary,
        databaseOwner,
        inherits,
        ownsOwnerRole,
        port,
        postgresDatabaseConnect,
        postgresDatabaseTemporary,
        role,
        superuser,
        templateDatabaseConnect,
        templateDatabaseTemporary,
        version,
      },
    );
  }
  return {
    detail: `query=ok database=${database} owner=${databaseOwner} role=${role} least_privilege=ok database_scope=ok version=${REQUIRED_POSTGRES_VERSION}`,
    service: service.name,
  };
}

export async function checkRedisReadiness(
  service,
  tools = undefined,
  timeoutMs = READINESS_REQUEST_TIMEOUT_MS,
) {
  const redisCli = tools?.['redis-cli'] ?? (await findExecutable('redis-cli'));
  const commonArguments = [
    '-h',
    HOST,
    '-p',
    String(service.port),
    '-n',
    String(REDIS_DATABASE_INDEX),
    '--raw',
  ];
  const [ping, serverInfo, clientInfo] = await Promise.all([
    execute(redisCli, [...commonArguments, 'PING'], {
      timeout: timeoutMs,
    }),
    execute(redisCli, [...commonArguments, 'INFO', 'server'], {
      timeout: timeoutMs,
    }),
    execute(redisCli, [...commonArguments, 'CLIENT', 'INFO'], {
      timeout: timeoutMs,
    }),
  ]);
  const versionMatch = /^redis_version:([^\r\n]+)$/mu.exec(serverInfo.stdout);
  const databaseMatch = /(?:^|\s)db=(\d+)(?:\s|$)/u.exec(clientInfo.stdout);
  if (
    ping.stdout.trim() !== 'PONG' ||
    versionMatch?.[1] !== REQUIRED_REDIS_VERSION ||
    Number.parseInt(databaseMatch?.[1] ?? '', 10) !== REDIS_DATABASE_INDEX
  ) {
    throw new DevContractError(
      'DEV_REDIS_IDENTITY',
      'Redis responded but did not match the required version and logical database.',
      {
        database: databaseMatch?.[1] ?? null,
        ping: ping.stdout.trim(),
        version: versionMatch?.[1] ?? null,
      },
    );
  }
  return {
    detail: `PING=PONG db=${REDIS_DATABASE_INDEX} version=${REQUIRED_REDIS_VERSION}`,
    service: service.name,
  };
}

export async function checkMetricsSurface(service, timeoutMs = READINESS_REQUEST_TIMEOUT_MS) {
  const url = serviceUrl(service, service.metricsPath);
  const { body, response } = await fetchBounded(url, service.name, timeoutMs);
  if (response.status !== 200) {
    throw new DevContractError(
      'DEV_METRICS_HTTP_STATUS',
      `metrics exposition returned HTTP ${response.status}, expected 200.`,
    );
  }
  const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
  if (
    !contentType.includes('text/plain') &&
    !contentType.includes('application/openmetrics-text')
  ) {
    throw new DevContractError(
      'DEV_METRICS_CONTENT_TYPE',
      'Metrics must use a Prometheus/OpenMetrics content type.',
      { contentType },
    );
  }
  if (!body.endsWith('\n') || !PROMETHEUS_SAMPLE.test(body)) {
    throw new DevContractError(
      'DEV_METRICS_EXPOSITION_INVALID',
      'Metrics endpoint returned no valid Prometheus sample or lacked the required trailing newline.',
    );
  }
  return {
    detail: `HTTP 200 prometheus_bytes=${Buffer.byteLength(body, 'utf8')}`,
    service: `${service.name}:exposition`,
  };
}

export async function checkServiceReadiness(
  service,
  tools = undefined,
  timeoutMs = READINESS_REQUEST_TIMEOUT_MS,
) {
  if (service.kind === 'postgres') {
    return checkPostgresReadiness(service, tools, timeoutMs);
  }
  if (service.kind === 'redis') {
    return checkRedisReadiness(service, tools, timeoutMs);
  }
  const startedAt = Date.now();
  const readiness = await checkHttpReadiness(service, timeoutMs);
  if (service.metricsPath) {
    const remainingMs = Math.max(1, timeoutMs - (Date.now() - startedAt));
    const metrics = await checkMetricsSurface(service, remainingMs);
    return {
      detail: `${readiness.detail}; ${metrics.detail}`,
      service: service.name,
    };
  }
  return readiness;
}

export async function waitForReadiness(service, { timeoutMs, tools = undefined } = {}) {
  const deadline = Date.now() + timeoutMs;
  let delayMs = 50;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const remainingMs = Math.max(1, deadline - Date.now());
      return await checkServiceReadiness(
        service,
        tools,
        Math.min(READINESS_REQUEST_TIMEOUT_MS, remainingMs),
      );
    } catch (error) {
      lastError = error;
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(delayMs, remainingMs)));
      delayMs = Math.min(delayMs * 2, 500);
    }
  }
  throw new DevContractError(
    'DEV_READINESS_TIMEOUT',
    `${service.name} did not become ready within ${timeoutMs} ms.`,
    { lastError: errorMessage(lastError) },
    { cause: lastError },
  );
}
