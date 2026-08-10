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

const LINUX_BOOT_ID = '3f2b8c14-9d5e-4a71-8b06-2c7d15e9f4a3';
const LINUX_START_TICKS = '5551234';

/**
 * Builds a `/proc/<pid>/stat` line whose field 22 is the process start tick.
 *
 * The parser slices from just past the `)` that terminates the comm field, so
 * the resulting array starts at field 3 and the start tick lands at index 19.
 */
function linuxStatLine(startTicks) {
  const fieldsAfterComm = Array.from({ length: 40 }, (_, index) => String(index));
  fieldsAfterComm[19] = startTicks;
  return `${String(PID)} (node) ${fieldsAfterComm.join(' ')}\n`;
}

/**
 * Models the two `/proc` reads that `linuxKernelBirthIdentity` performs.
 *
 * Without this, the mocked `readFile` resolved `undefined` for those paths and
 * the identity suite crashed inside the kernel-identity probe on the Linux CI
 * runner while passing on macOS, where the probe returns early. Every test here
 * must observe the same behaviour on both platforms.
 */
async function readFileFixture(targetPath, records = new Map()) {
  if (records.has(targetPath)) {
    return records.get(targetPath);
  }
  if (targetPath === '/proc/sys/kernel/random/boot_id') {
    return `${LINUX_BOOT_ID}\n`;
  }
  if (targetPath === `/proc/${String(PID)}/stat`) {
    return linuxStatLine(LINUX_START_TICKS);
  }
  throw missingFileError();
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
  const records = new Map([
    [pidPath('redis'), `${record.pid}\n`],
    [metadataPath('redis'), `${JSON.stringify(record)}\n`],
  ]);
  fsMocks.readFile.mockImplementation(async (targetPath) => readFileFixture(targetPath, records));
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
    fsMocks.readFile
      .mockReset()
      .mockImplementation(async (targetPath) => readFileFixture(targetPath));
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

  it('refuses a PID whose recorded kernel birth identity no longer matches', async () => {
    mockProcessInspection();
    // Differs from the modelled Linux value and from the `undefined` a non-Linux
    // host reports, so the refusal is observed identically on both platforms.
    const record = {
      ...ownershipRecord(),
      kernelBirthIdentity: `linux:${LINUX_BOOT_ID}:${String(Number(LINUX_START_TICKS) + 1)}`,
    };

    await expect(verifyOwnership(record)).resolves.toMatchObject({
      owned: false,
      reason: 'kernel-birth-identity-changed',
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
