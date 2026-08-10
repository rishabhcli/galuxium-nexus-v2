import { beforeEach, describe, expect, it, vi } from 'vitest';

const commandMocks = vi.hoisted(() => ({
  execute: vi.fn(),
  findExecutable: vi.fn(),
}));
const ownershipMocks = vi.hoisted(() => ({
  listenerBelongsToRecord: vi.fn(),
  loadVerifiedOwnershipRecords: vi.fn(),
}));

vi.mock('../command.mjs', () => commandMocks);
vi.mock('../ownership.mjs', () => ownershipMocks);

const { auditBlockListeners } = await import('../listeners.mjs');

describe('foreign listener refusal', () => {
  beforeEach(() => {
    commandMocks.execute.mockReset();
    commandMocks.findExecutable.mockReset();
    ownershipMocks.listenerBelongsToRecord.mockReset();
    ownershipMocks.loadVerifiedOwnershipRecords.mockReset();

    commandMocks.findExecutable.mockResolvedValue('/usr/sbin/lsof');
    ownershipMocks.loadVerifiedOwnershipRecords.mockResolvedValue(new Map());
  });

  it('refuses a foreign allocated-port listener without signalling any PID', async () => {
    commandMocks.execute.mockResolvedValue({
      exitCode: 0,
      stderr: '',
      stdout: 'p987654\ncforeign-node\nn127.0.0.1:4160\n',
    });
    const signalSpy = vi.spyOn(process, 'kill').mockReturnValue(true);

    await expect(auditBlockListeners()).rejects.toMatchObject({
      code: 'DEV_FOREIGN_PORT_OCCUPIED',
      details: {
        command: 'foreign-node',
        pid: 987654,
        port: 4160,
      },
    });
    expect(signalSpy).not.toHaveBeenCalled();
    expect(ownershipMocks.listenerBelongsToRecord).not.toHaveBeenCalled();
    expect(ownershipMocks.loadVerifiedOwnershipRecords).toHaveBeenCalledWith();
  });

  it('never requests stale-record removal from a read-only listener or health audit', async () => {
    commandMocks.execute.mockResolvedValue({ exitCode: 1, stderr: '', stdout: '' });

    await auditBlockListeners();

    expect(ownershipMocks.loadVerifiedOwnershipRecords).toHaveBeenCalledExactlyOnceWith();
  });

  it('refuses a foreign listener on an unallocated reserved port without signalling it', async () => {
    commandMocks.execute.mockResolvedValue({
      exitCode: 0,
      stderr: '',
      stdout: 'p987655\ncforeign-node\nn127.0.0.1:4169\n',
    });
    const signalSpy = vi.spyOn(process, 'kill').mockReturnValue(true);

    await expect(auditBlockListeners()).rejects.toMatchObject({
      code: 'DEV_RESERVED_PORT_OCCUPIED',
      details: {
        command: 'foreign-node',
        pid: 987655,
        port: 4169,
      },
    });
    expect(signalSpy).not.toHaveBeenCalled();
  });
});
