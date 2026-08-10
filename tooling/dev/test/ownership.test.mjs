import path from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const commandMocks = vi.hoisted(() => ({
  execute: vi.fn(),
  findExecutable: vi.fn(),
}));
const filesystemMocks = vi.hoisted(() => ({
  atomicWrite: vi.fn(),
}));
const fsMocks = vi.hoisted(() => ({
  lstat: vi.fn(),
  open: vi.fn(),
  readFile: vi.fn(),
  rm: vi.fn(),
}));

vi.mock('node:fs/promises', () => ({ default: fsMocks }));
vi.mock('../command.mjs', () => commandMocks);
vi.mock('../filesystem.mjs', () => filesystemMocks);

const { REPOSITORY_NAME, REPOSITORY_ROOT, SERVICE_BY_NAME, metadataPath, pidPath } =
  await import('../constants.mjs');
const { listenerBelongsToRecord, loadVerifiedOwnershipRecords, verifyOwnership } =
  await import('../ownership.mjs');

const PID = 987601;
const PROCESS_GROUP_ID = 987601;
const RUN_ID = '01234567-89ab-cdef-0123-456789abcdef';
const BIRTH_IDENTITY = '12345678-1234-4123-8123-123456789abc';
const START_TIME_TEXT = 'Sun Aug 09 22:40:19 2026';
const STARTED_AT_EPOCH_MS = Date.parse(START_TIME_TEXT);
const SUPERVISOR_ENTRY = path.join(REPOSITORY_ROOT, 'tooling', 'dev', 'log-supervisor.mjs');
const SUPERVISOR_COMMAND = `${process.execPath} ${SUPERVISOR_ENTRY} /tmp/config --dev-birth-identity=${BIRTH_IDENTITY}`;

function missingFileError() {
  return Object.assign(new Error('missing test fixture'), { code: 'ENOENT' });
}

function mockProcessInspection({
  command = SUPERVISOR_COMMAND,
  exitCode = 0,
  processGroupId = PROCESS_GROUP_ID,
  startTimeText = START_TIME_TEXT,
} = {}) {
  commandMocks.execute.mockImplementation(async (_executable, args) => {
    if (args.at(-1) === 'command=') {
      return { exitCode, stderr: '', stdout: exitCode === 0 ? `${command}\n` : '' };
    }
    if (args.at(-1) === 'lstart=') {
      return { exitCode, stderr: '', stdout: exitCode === 0 ? `${startTimeText}\n` : '' };
    }
    return {
      exitCode,
      stderr: '',
      stdout: exitCode === 0 ? `${PID} 1 ${processGroupId}\n` : '',
    };
  });
}

function ownershipRecord({ argvNeedles = [SUPERVISOR_ENTRY] } = {}) {
  return {
    argvNeedles,
    birthIdentity: BIRTH_IDENTITY,
    expectedPorts: [4166],
    kernelBirthIdentity: null,
    kind: 'redis',
    pid: PID,
    processGroupId: PROCESS_GROUP_ID,
    repository: REPOSITORY_NAME,
    repositoryRoot: REPOSITORY_ROOT,
    runId: RUN_ID,
    schemaVersion: 2,
    service: 'redis',
    startedAtEpochMs: STARTED_AT_EPOCH_MS,
    supervised: true,
    supervisorConfigPath: path.join(
      REPOSITORY_ROOT,
      '.dev',
      'tmp',
      `supervisor.redis.${RUN_ID}.${BIRTH_IDENTITY}.json`,
    ),
    targetArgvNeedles: ['redis-server', '127.0.0.1:4166'],
    targetExecutable: '/opt/homebrew/bin/redis-server',
  };
}

function mockSingleRedisRecord(record) {
  fsMocks.readFile.mockImplementation(async (targetPath) => {
    if (targetPath === pidPath('redis')) {
      return `${record.pid}\n`;
    }
    if (targetPath === metadataPath('redis')) {
      return `${JSON.stringify(record)}\n`;
    }
    throw missingFileError();
  });
  fsMocks.lstat.mockRejectedValue(missingFileError());
  fsMocks.rm.mockResolvedValue(undefined);
}

describe('ownership process identity', () => {
  beforeEach(() => {
    commandMocks.execute.mockReset();
    commandMocks.findExecutable.mockReset();
    filesystemMocks.atomicWrite.mockReset();
    fsMocks.lstat.mockReset();
    fsMocks.open.mockReset();
    fsMocks.readFile.mockReset();
    fsMocks.rm.mockReset();

    commandMocks.findExecutable.mockResolvedValue('/bin/ps');
  });

  it('recognizes the exact supervised process birth marker', async () => {
    mockProcessInspection();

    await expect(verifyOwnership(ownershipRecord())).resolves.toMatchObject({
      inspected: { command: SUPERVISOR_COMMAND },
      owned: true,
    });
  });

  it('refuses a PID whose start time proves that the PID was reused', async () => {
    mockProcessInspection({ startTimeText: 'Sun Aug 09 22:40:20 2026' });

    await expect(verifyOwnership(ownershipRecord())).resolves.toMatchObject({
      owned: false,
      reason: 'pid-reused',
    });
  });

  it('refuses a PID whose command no longer matches the ownership record', async () => {
    mockProcessInspection({
      command: `/usr/bin/sleep 600 --dev-birth-identity=${BIRTH_IDENTITY}`,
    });

    await expect(verifyOwnership(ownershipRecord())).resolves.toMatchObject({
      owned: false,
      reason: 'command-changed',
    });
  });

  it('refuses a same-second PID collision with a different exact birth marker', async () => {
    mockProcessInspection({
      command: `${process.execPath} ${SUPERVISOR_ENTRY} /tmp/config --dev-birth-identity=87654321-4321-4321-8321-cba987654321`,
    });

    await expect(verifyOwnership(ownershipRecord())).resolves.toMatchObject({
      owned: false,
      reason: 'birth-identity-changed',
    });
  });

  it('reverifies the supervisor before attributing even a same-PID listener', async () => {
    mockProcessInspection({ command: '/usr/bin/reused-process' });

    await expect(listenerBelongsToRecord(PID, ownershipRecord())).resolves.toBe(false);
  });

  it('removes ownership files only when the recorded PID is not running', async () => {
    const record = ownershipRecord();
    mockSingleRedisRecord(record);
    mockProcessInspection({ exitCode: 1 });

    await expect(loadVerifiedOwnershipRecords({ removeStale: true })).resolves.toEqual(new Map());
    expect(fsMocks.rm).toHaveBeenCalledTimes(3);
    expect(fsMocks.rm).toHaveBeenCalledWith(pidPath('redis'), { force: true });
    expect(fsMocks.rm).toHaveBeenCalledWith(metadataPath('redis'), { force: true });
    expect(fsMocks.rm).toHaveBeenCalledWith(record.supervisorConfigPath, { force: true });
  });

  it.each([
    {
      inspection: {
        command: `/usr/bin/sleep 600 --dev-birth-identity=${BIRTH_IDENTITY}`,
      },
      reason: 'command-changed',
    },
    {
      inspection: { startTimeText: 'Sun Aug 09 22:40:20 2026' },
      reason: 'pid-reused',
    },
  ])('preserves the record and refuses recovery for $reason', async ({ inspection, reason }) => {
    const record = ownershipRecord();
    mockSingleRedisRecord(record);
    mockProcessInspection(inspection);

    await expect(loadVerifiedOwnershipRecords({ removeStale: true })).rejects.toMatchObject({
      code: 'DEV_OWNERSHIP_MISMATCH',
      details: { reason },
    });
    expect(fsMocks.rm).not.toHaveBeenCalled();
  });

  it('keeps every fixture inside the declared service map', () => {
    expect(SERVICE_BY_NAME.get('redis')).toMatchObject({ kind: 'redis', port: 4166 });
  });
});
