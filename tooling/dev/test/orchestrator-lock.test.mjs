import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { acquireOrchestratorLock } from '../ownership.mjs';

const STARTED_AT_EPOCH_MS = Date.parse('Sun Aug 09 22:40:19 2026');
const FIRST_TOKEN = '11111111-1111-4111-8111-111111111111';
const SECOND_TOKEN = '22222222-2222-4222-8222-222222222222';
const STALE_TOKEN = '33333333-3333-4333-8333-333333333333';
const temporaryDirectories = [];

async function makeLockPath() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'galuxium-lock-test-'));
  temporaryDirectories.push(directory);
  return path.join(directory, 'orchestrator.lock');
}

function currentInspection(pid = process.pid) {
  return {
    command: 'test process',
    kernelBirthIdentity: undefined,
    parentPid: 1,
    pid,
    processGroupId: pid,
    rawStartTime: 'Sun Aug 09 22:40:19 2026',
    startedAtEpochMs: STARTED_AT_EPOCH_MS,
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { force: true, recursive: true })),
  );
});

describe('orchestrator lock atomic claim', () => {
  it('admits exactly one of two deterministic simultaneous contenders', async () => {
    const lockPath = await makeLockPath();
    const options = (token) => ({
      inspectProcessAction: async () => currentInspection(),
      lockPath,
      token,
    });

    const outcomes = await Promise.allSettled([
      acquireOrchestratorLock('contender-a', options(FIRST_TOKEN)),
      acquireOrchestratorLock('contender-b', options(SECOND_TOKEN)),
    ]);
    const winner = outcomes.find((outcome) => outcome.status === 'fulfilled');
    const loser = outcomes.find((outcome) => outcome.status === 'rejected');

    expect(winner).toBeDefined();
    expect(loser).toMatchObject({
      reason: { code: 'DEV_ORCHESTRATOR_BUSY' },
      status: 'rejected',
    });
    await winner.value();
    await expect(fs.lstat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('atomically elects one winner while two contenders replace the same stale inode', async () => {
    const lockPath = await makeLockPath();
    const staleCandidate = `${lockPath}.claim.${STALE_TOKEN}`;
    const stale = {
      kernelBirthIdentity: null,
      operation: 'stale-operation',
      pid: 999_999,
      repository: 'galuxium-nexus-v2',
      startedAtEpochMs: STARTED_AT_EPOCH_MS,
      token: STALE_TOKEN,
    };
    await fs.writeFile(staleCandidate, `${JSON.stringify(stale)}\n`, {
      flag: 'wx',
      mode: 0o600,
    });
    await fs.link(staleCandidate, lockPath);

    const inspectProcessAction = async (pid) =>
      pid === process.pid ? currentInspection() : undefined;
    const outcomes = await Promise.allSettled([
      acquireOrchestratorLock('takeover-a', {
        inspectProcessAction,
        lockPath,
        token: FIRST_TOKEN,
      }),
      acquireOrchestratorLock('takeover-b', {
        inspectProcessAction,
        lockPath,
        token: SECOND_TOKEN,
      }),
    ]);
    const winners = outcomes.filter((outcome) => outcome.status === 'fulfilled');
    const losers = outcomes.filter((outcome) => outcome.status === 'rejected');

    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(losers[0].reason).toMatchObject({ code: 'DEV_ORCHESTRATOR_BUSY' });
    await winners[0].value();
  });

  it('does not take over after one transient missing-process inspection', async () => {
    const lockPath = await makeLockPath();
    const release = await acquireOrchestratorLock('active-owner', {
      inspectProcessAction: async () => currentInspection(),
      lockPath,
      token: FIRST_TOKEN,
    });
    let inspections = 0;
    const inspectProcessAction = async () => {
      inspections += 1;
      return inspections === 2 ? undefined : currentInspection();
    };
    const sleepAction = vi.fn().mockResolvedValue(undefined);

    await expect(
      acquireOrchestratorLock('transient-contender', {
        inspectProcessAction,
        lockPath,
        sleepAction,
        token: SECOND_TOKEN,
      }),
    ).rejects.toMatchObject({ code: 'DEV_ORCHESTRATOR_BUSY' });

    expect(sleepAction).toHaveBeenCalledExactlyOnceWith(5);
    await release();
  });
});
