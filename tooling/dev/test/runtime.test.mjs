import { EventEmitter } from 'node:events';
import path from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const BIRTH_IDENTITY = '12345678-1234-4123-8123-123456789abc';
const BIRTH_ARGUMENT = `--dev-birth-identity=${BIRTH_IDENTITY}`;
const childProcessMocks = vi.hoisted(() => ({
  spawn: vi.fn(),
}));
const downMocks = vi.hoisted(() => ({
  stopOwnershipRecord: vi.fn(),
}));
const filesystemMocks = vi.hoisted(() => ({
  assertRegularFileInsideRepository: vi.fn(),
  atomicWrite: vi.fn(),
}));
const fsMocks = vi.hoisted(() => ({
  lstat: vi.fn(),
  readFile: vi.fn(),
  readdir: vi.fn(),
  rm: vi.fn(),
}));
const ownershipMocks = vi.hoisted(() => ({
  createProcessBirthIdentity: vi.fn(),
  inspectProcess: vi.fn(),
  processBirthIdentityArgument: vi.fn(),
  writeOwnershipRecord: vi.fn(),
}));
const readinessMocks = vi.hoisted(() => ({
  waitForReadiness: vi.fn(),
}));

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal()),
  spawn: childProcessMocks.spawn,
}));
vi.mock('node:fs/promises', () => ({ default: fsMocks }));
vi.mock('../down.mjs', () => downMocks);
vi.mock('../filesystem.mjs', () => filesystemMocks);
vi.mock('../log-supervisor.mjs', () => ({ BoundedLogWriter: class {} }));
vi.mock('../ownership.mjs', () => ownershipMocks);
vi.mock('../readiness.mjs', () => readinessMocks);

const { POSTGRES, REPOSITORY_ROOT, SERVICE_BY_NAME } = await import('../constants.mjs');
const { postgresBootstrapEnvironment, postgresBootstrapSql, postgresServerArguments, startRedis } =
  await import('../runtime.mjs');
const SUPERVISOR_ENTRY = path.join(REPOSITORY_ROOT, 'tooling', 'dev', 'log-supervisor.mjs');

describe('supervised runtime contract', () => {
  beforeEach(() => {
    childProcessMocks.spawn.mockReset();
    downMocks.stopOwnershipRecord.mockReset();
    filesystemMocks.assertRegularFileInsideRepository.mockReset();
    filesystemMocks.atomicWrite.mockReset();
    fsMocks.lstat.mockReset();
    fsMocks.readFile.mockReset();
    fsMocks.readdir.mockReset();
    fsMocks.rm.mockReset();
    ownershipMocks.createProcessBirthIdentity.mockReset();
    ownershipMocks.inspectProcess.mockReset();
    ownershipMocks.processBirthIdentityArgument.mockReset();
    ownershipMocks.writeOwnershipRecord.mockReset();
    readinessMocks.waitForReadiness.mockReset();

    const child = new EventEmitter();
    child.exitCode = null;
    child.pid = 987_602;
    child.signalCode = null;
    child.unref = vi.fn();
    childProcessMocks.spawn.mockImplementation(() => {
      queueMicrotask(() => child.emit('spawn'));
      return child;
    });
    downMocks.stopOwnershipRecord.mockResolvedValue({ forced: false, service: 'redis' });
    filesystemMocks.atomicWrite.mockResolvedValue(undefined);
    fsMocks.rm.mockResolvedValue(undefined);
    ownershipMocks.createProcessBirthIdentity.mockReturnValue(BIRTH_IDENTITY);
    ownershipMocks.processBirthIdentityArgument.mockReturnValue(BIRTH_ARGUMENT);
    ownershipMocks.inspectProcess.mockResolvedValue({
      command: `${process.execPath} ${SUPERVISOR_ENTRY} /test/config ${BIRTH_ARGUMENT}`,
      kernelBirthIdentity: undefined,
      parentPid: 1,
      pid: child.pid,
      processGroupId: child.pid,
      rawStartTime: 'Sun Aug 09 22:40:19 2026',
      startedAtEpochMs: Date.parse('Sun Aug 09 22:40:19 2026'),
    });
    ownershipMocks.writeOwnershipRecord.mockImplementation(async (record) => record);
    readinessMocks.waitForReadiness.mockResolvedValue({ service: 'redis' });
  });

  it('provisions least privilege and suppresses password-bearing DDL logs', () => {
    const sql = postgresBootstrapSql();
    const environment = postgresBootstrapEnvironment('owner-test-value', 'runtime-test-value');
    const serverArguments = postgresServerArguments(SERVICE_BY_NAME.get('postgres'));

    expect(POSTGRES.ownerRole).toBe('galuxium_nexus_v2_owner');
    expect(POSTGRES.role).toBe('galuxium_nexus_v2');
    expect(sql).toContain('GALUXIUM_NEXUS_V2_RUNTIME_PASSWORD');
    expect(sql).toContain("SET log_statement = 'none'");
    expect(sql).toContain("SET log_min_error_statement = 'panic'");
    expect(sql).toContain('NOSUPERUSER');
    expect(sql).toContain('NOCREATEDB');
    expect(sql).toContain('NOCREATEROLE');
    expect(sql).toContain('NOINHERIT');
    expect(sql).toContain('NOREPLICATION');
    expect(sql).toContain('NOBYPASSRLS');
    expect(sql).toContain(`OWNER %I', '${POSTGRES.database}', '${POSTGRES.ownerRole}'`);
    expect(sql).toContain(`GRANT CONNECT ON DATABASE ${POSTGRES.database} TO ${POSTGRES.role}`);
    expect(sql).toContain(`REVOKE CONNECT, TEMPORARY ON DATABASE postgres FROM ${POSTGRES.role}`);
    expect(sql).toContain(`REVOKE CONNECT, TEMPORARY ON DATABASE template1 FROM ${POSTGRES.role}`);
    expect(sql).not.toContain('runtime-test-value');
    expect(sql).not.toContain(POSTGRES.passwordFile);
    expect(environment.PGOPTIONS).toContain('log_statement=none');
    expect(environment.PGOPTIONS).toContain('log_min_error_statement=panic');
    expect(serverArguments).toEqual(expect.arrayContaining(['log_statement=none']));
    expect(serverArguments).toEqual(expect.arrayContaining(['log_min_error_statement=error']));
  });

  it('retains attribution and never directly signals when ownership recording cleanup is unproven', async () => {
    const signalSpy = vi.spyOn(process, 'kill').mockReturnValue(true);
    ownershipMocks.writeOwnershipRecord.mockRejectedValueOnce(new Error('metadata write failed'));
    downMocks.stopOwnershipRecord.mockRejectedValueOnce(
      Object.assign(new Error('birth identity changed'), {
        code: 'DEV_DOWN_OWNERSHIP_MISMATCH',
      }),
    );

    await expect(
      startRedis(SERVICE_BY_NAME.get('redis'), {
        runId: '01234567-89ab-cdef-0123-456789abcdef',
        tools: { 'redis-server': '/opt/homebrew/bin/redis-server' },
      }),
    ).rejects.toMatchObject({
      code: 'DEV_OWNERSHIP_WRITE_CLEANUP_UNPROVEN',
      details: { birthIdentity: BIRTH_IDENTITY, pid: 987_602 },
    });

    expect(signalSpy).not.toHaveBeenCalled();
    expect(downMocks.stopOwnershipRecord).toHaveBeenCalledOnce();
  });

  it('records the supervisor birth marker and a separate target attribution contract', async () => {
    const service = SERVICE_BY_NAME.get('redis');
    const runId = '01234567-89ab-cdef-0123-456789abcdef';

    await startRedis(service, {
      runId,
      tools: { 'redis-server': '/opt/homebrew/bin/redis-server' },
    });

    expect(ownershipMocks.writeOwnershipRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        argvNeedles: [SUPERVISOR_ENTRY, BIRTH_ARGUMENT],
        birthIdentity: BIRTH_IDENTITY,
        runId,
        service: 'redis',
        targetArgvNeedles: ['redis-server', '127.0.0.1:4166'],
        targetExecutable: '/opt/homebrew/bin/redis-server',
      }),
    );
    expect(childProcessMocks.spawn).toHaveBeenCalledWith(
      process.execPath,
      [SUPERVISOR_ENTRY, expect.stringContaining('supervisor.redis.'), BIRTH_ARGUMENT],
      expect.objectContaining({ detached: true, shell: false, stdio: 'ignore' }),
    );

    const supervisorWrite = filesystemMocks.atomicWrite.mock.calls.find(([targetPath]) =>
      String(targetPath).includes('supervisor.redis.'),
    );
    const config = JSON.parse(supervisorWrite[1]);
    expect(config).toMatchObject({
      args: [`${REPOSITORY_ROOT}/.dev/redis/redis.conf`],
      birthIdentity: BIRTH_IDENTITY,
      executable: '/opt/homebrew/bin/redis-server',
      service: 'redis',
    });
    expect(JSON.stringify(config)).not.toContain('owner-test-value');
    expect(JSON.stringify(config)).not.toContain('runtime-test-value');
  });
});
