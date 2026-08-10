import { beforeEach, describe, expect, it, vi } from 'vitest';

const filesystemMocks = vi.hoisted(() => ({ ensureDevTree: vi.fn() }));
const listenerMocks = vi.hoisted(() => ({ listBlockListeners: vi.fn() }));
const ownershipMocks = vi.hoisted(() => ({
  acquireOrchestratorLock: vi.fn(),
  readOwnershipRecord: vi.fn(),
  removeOwnershipRecord: vi.fn(),
  verifyOwnership: vi.fn(),
}));

vi.mock('../filesystem.mjs', () => filesystemMocks);
vi.mock('../listeners.mjs', () => listenerMocks);
vi.mock('../ownership.mjs', () => ownershipMocks);

const { down, stopOwnershipRecord } = await import('../down.mjs');

function record(service = 'redis') {
  return {
    pid: 987_650,
    runId: '01234567-89ab-cdef-0123-456789abcdef',
    service,
    supervisorConfigPath: `/test/supervisor.${service}.json`,
  };
}

function processControl() {
  let now = 0;
  return {
    kill: vi.fn(),
    now: () => now,
    sleep: vi.fn(async (milliseconds) => {
      now += milliseconds;
    }),
  };
}

describe('exact-owned shutdown', () => {
  beforeEach(() => {
    filesystemMocks.ensureDevTree.mockReset().mockResolvedValue(undefined);
    listenerMocks.listBlockListeners.mockReset().mockResolvedValue([]);
    ownershipMocks.acquireOrchestratorLock.mockReset().mockResolvedValue(vi.fn());
    ownershipMocks.readOwnershipRecord.mockReset().mockResolvedValue(undefined);
    ownershipMocks.removeOwnershipRecord.mockReset().mockResolvedValue(undefined);
    ownershipMocks.verifyOwnership.mockReset();
  });

  it('reverifies ownership until graceful exit and then removes attribution', async () => {
    const control = processControl();
    ownershipMocks.verifyOwnership
      .mockResolvedValueOnce({ owned: true })
      .mockResolvedValueOnce({ owned: true })
      .mockResolvedValueOnce({ owned: false, reason: 'not-running' });

    await expect(stopOwnershipRecord(record(), { processControl: control })).resolves.toMatchObject(
      { forced: false, service: 'redis' },
    );

    expect(control.kill).toHaveBeenCalledExactlyOnceWith(987_650, 'SIGTERM');
    expect(ownershipMocks.verifyOwnership).toHaveBeenCalledTimes(3);
    expect(ownershipMocks.removeOwnershipRecord).toHaveBeenCalledWith('redis', {
      supervisorConfigPath: '/test/supervisor.redis.json',
    });
  });

  it('uses only reverified SIGTERM and SIGINT and never SIGKILLs a supervisor', async () => {
    const control = processControl();
    ownershipMocks.verifyOwnership.mockImplementation(async () =>
      control.kill.mock.calls.some(([, signal]) => signal === 'SIGINT')
        ? { owned: false, reason: 'not-running' }
        : { owned: true },
    );

    await expect(stopOwnershipRecord(record(), { processControl: control })).resolves.toMatchObject(
      { forced: true, service: 'redis' },
    );

    expect(control.kill).toHaveBeenNthCalledWith(1, 987_650, 'SIGTERM');
    expect(control.kill).toHaveBeenNthCalledWith(2, 987_650, 'SIGINT');
    expect(control.kill).not.toHaveBeenCalledWith(987_650, 'SIGKILL');
  });

  // Replaces an earlier test that required identity drift *while waiting for
  // exit* to fail closed and retain attribution. That requirement was proven
  // invalid in practice: every non-owned reason means a different process now
  // holds the PID, which is exactly the evidence that the recorded process
  // exited. The old behaviour turned real successful shutdowns into
  // DEV_DOWN_OWNERSHIP_CHANGED_WHILE_WAITING and left a stale record naming a
  // PID owned by an unrelated process. Observed on a real `make test-e2e` run:
  // "PID 11742 for admin changed identity while waiting for exact-owned exit",
  // where `ps -p 11742` showed no process at all afterwards. The strictness that
  // prevents harm — never signalling a PID that is not verifiably ours — is
  // asserted by the two tests below instead.
  it.each([
    'birth-identity-changed',
    'pid-reused',
    'process-group-changed',
    'kernel-birth-identity-changed',
    'command-changed',
  ])('treats %s while awaiting exit as proof the recorded process is gone', async (reason) => {
    const control = processControl();
    ownershipMocks.verifyOwnership
      .mockResolvedValueOnce({ owned: true })
      .mockResolvedValueOnce({ owned: false, reason });

    await expect(stopOwnershipRecord(record(), { processControl: control })).resolves.toMatchObject(
      { forced: false, service: 'redis' },
    );

    // Exactly one signal: the PID is no longer ours, so a second signal could
    // only ever reach an unrelated process.
    expect(control.kill).toHaveBeenCalledExactlyOnceWith(987_650, 'SIGTERM');
    expect(control.kill).not.toHaveBeenCalledWith(987_650, 'SIGINT');
    expect(ownershipMocks.removeOwnershipRecord).toHaveBeenCalledWith('redis', {
      supervisorConfigPath: '/test/supervisor.redis.json',
    });
  });

  it('refuses to signal a PID whose identity drifted before the signal', async () => {
    const control = processControl();
    ownershipMocks.verifyOwnership.mockResolvedValue({
      owned: false,
      reason: 'birth-identity-changed',
    });

    await expect(stopOwnershipRecord(record(), { processControl: control })).rejects.toMatchObject({
      code: 'DEV_DOWN_OWNERSHIP_MISMATCH',
    });

    expect(control.kill).not.toHaveBeenCalled();
    expect(ownershipMocks.removeOwnershipRecord).not.toHaveBeenCalled();
  });

  it('still reports a stuck process that stays exact-owned through both signals', async () => {
    const control = processControl();
    ownershipMocks.verifyOwnership.mockResolvedValue({ owned: true });

    await expect(stopOwnershipRecord(record(), { processControl: control })).rejects.toMatchObject({
      code: 'DEV_DOWN_PROCESS_STUCK',
    });

    expect(control.kill).toHaveBeenNthCalledWith(1, 987_650, 'SIGTERM');
    expect(control.kill).toHaveBeenNthCalledWith(2, 987_650, 'SIGINT');
    expect(control.kill).not.toHaveBeenCalledWith(987_650, 'SIGKILL');
    expect(ownershipMocks.removeOwnershipRecord).not.toHaveBeenCalled();
  });

  it('is idempotent across repeated fully-down orchestration', async () => {
    await expect(down({ quiet: true })).resolves.toEqual([]);
    await expect(down({ quiet: true })).resolves.toEqual([]);

    expect(ownershipMocks.acquireOrchestratorLock).toHaveBeenCalledTimes(2);
    expect(ownershipMocks.readOwnershipRecord).toHaveBeenCalledTimes(14);
    expect(ownershipMocks.verifyOwnership).not.toHaveBeenCalled();
  });
});
