import { describe, expect, it, vi } from 'vitest';

import { TEARDOWN_PROOF_TIMEOUT_MS, assertPlaywrightTeardown } from '../run-playwright-owned.mjs';

function clock(startMs = 0) {
  let current = startMs;
  return {
    now: () => current,
    sleep: vi.fn(async (milliseconds) => {
      current += milliseconds;
    }),
  };
}

function audit(sequence) {
  const queue = [...sequence];
  return vi.fn(async () => {
    const next = queue.length > 1 ? queue.shift() : queue[0];
    return { listeners: Array.from({ length: next.listeners }), records: new Map(next.records) };
  });
}

const OWNED_TEARDOWN = Object.freeze({
  phase: 'torn-down',
  runId: 'run-owned',
  startedHere: true,
  teardownCompletedAt: '2026-08-10T20:00:00.000Z',
});

describe('Playwright webServer teardown proof', () => {
  it('accepts a recorded owned teardown with an empty port block', async () => {
    const timing = clock();

    await expect(
      assertPlaywrightTeardown({
        auditListeners: audit([{ listeners: 0, records: [] }]),
        now: timing.now,
        readLifecycle: vi.fn().mockResolvedValue(OWNED_TEARDOWN),
        sleep: timing.sleep,
      }),
    ).resolves.toMatchObject({ runId: 'run-owned' });
  });

  it('waits for a teardown still in flight rather than failing on the first sample', async () => {
    // The previous implementation sampled once, immediately after Playwright
    // returned, and reported 7 listeners and 7 ownership records while the
    // webServer was still shutting down.
    const timing = clock();
    const readLifecycle = vi
      .fn()
      .mockResolvedValueOnce({ phase: 'ready', runId: 'run-owned', startedHere: true })
      .mockResolvedValueOnce({ phase: 'ready', runId: 'run-owned', startedHere: true })
      .mockResolvedValue(OWNED_TEARDOWN);

    await expect(
      assertPlaywrightTeardown({
        auditListeners: audit([
          { listeners: 7, records: [['gateway', {}]] },
          { listeners: 3, records: [['gateway', {}]] },
          { listeners: 0, records: [] },
        ]),
        now: timing.now,
        readLifecycle,
        sleep: timing.sleep,
      }),
    ).resolves.toMatchObject({ phase: 'torn-down' });

    expect(timing.sleep).toHaveBeenCalled();
  });

  it('refuses when the webServer reused a topology it did not start', async () => {
    const timing = clock();

    await expect(
      assertPlaywrightTeardown({
        auditListeners: audit([{ listeners: 0, records: [] }]),
        now: timing.now,
        readLifecycle: vi.fn().mockResolvedValue({ ...OWNED_TEARDOWN, startedHere: false }),
        sleep: timing.sleep,
      }),
    ).rejects.toThrow(/reused a topology it did not start/u);
  });

  it('refuses immediately when the webServer recorded a failed teardown', async () => {
    const timing = clock();

    await expect(
      assertPlaywrightTeardown({
        auditListeners: audit([{ listeners: 7, records: [['gateway', {}]] }]),
        now: timing.now,
        readLifecycle: vi.fn().mockResolvedValue({
          phase: 'teardown-failed',
          runId: 'run-owned',
          startedHere: true,
          teardownError: 'metrics PID remained exact-owned',
        }),
        sleep: timing.sleep,
      }),
    ).rejects.toThrow(/teardownError=metrics PID remained exact-owned/u);

    // Terminal failure must not burn the whole timeout budget.
    expect(timing.sleep).not.toHaveBeenCalled();
  });

  it('refuses when no lifecycle record exists, so a webServer that never ran cannot pass', async () => {
    const timing = clock();

    await expect(
      assertPlaywrightTeardown({
        auditListeners: audit([{ listeners: 0, records: [] }]),
        now: timing.now,
        readLifecycle: vi.fn().mockResolvedValue(undefined),
        sleep: timing.sleep,
      }),
    ).rejects.toThrow(/lifecycle=absent/u);
  });

  it('refuses when listeners never drain before the stated deadline', async () => {
    const timing = clock();

    await expect(
      assertPlaywrightTeardown({
        auditListeners: audit([{ listeners: 7, records: [['gateway', {}]] }]),
        now: timing.now,
        readLifecycle: vi.fn().mockResolvedValue({ phase: 'ready', startedHere: true }),
        sleep: timing.sleep,
      }),
    ).rejects.toThrow(
      new RegExp(
        `did not prove it stopped the topology it started within ${String(TEARDOWN_PROOF_TIMEOUT_MS)}ms`,
        'u',
      ),
    );

    expect(timing.now()).toBeGreaterThanOrEqual(TEARDOWN_PROOF_TIMEOUT_MS);
  });

  it('refuses a recorded teardown that left ownership records behind', async () => {
    const timing = clock();

    await expect(
      assertPlaywrightTeardown({
        auditListeners: audit([{ listeners: 0, records: [['metrics', {}]] }]),
        now: timing.now,
        readLifecycle: vi.fn().mockResolvedValue(OWNED_TEARDOWN),
        sleep: timing.sleep,
      }),
    ).rejects.toThrow(/ownershipRecords=1/u);
  });
});
