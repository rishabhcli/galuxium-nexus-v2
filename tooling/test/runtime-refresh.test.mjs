import { describe, expect, it, vi } from 'vitest';

import { refreshBuiltTopology } from '../runtime-refresh.mjs';

function output() {
  return { write: vi.fn() };
}

describe('built topology refresh lifecycle', () => {
  it('runs the exact preflight/down/preflight/up/health sequence', async () => {
    const downAction = vi.fn().mockResolvedValue(undefined);
    const healthAction = vi.fn().mockResolvedValue(undefined);
    const preflightAction = vi.fn().mockResolvedValue(undefined);
    const upAction = vi.fn().mockResolvedValue({ alreadyRunning: false, runId: 'fresh-run' });
    const stopRunAction = vi.fn();

    await expect(
      refreshBuiltTopology({
        downAction,
        healthAction,
        output: output(),
        preflightAction,
        stopRunAction,
        upAction,
      }),
    ).resolves.toEqual({ alreadyRunning: false, runId: 'fresh-run' });

    expect(preflightAction).toHaveBeenCalledTimes(2);
    expect(downAction).toHaveBeenCalledOnce();
    expect(upAction).toHaveBeenCalledOnce();
    expect(healthAction).toHaveBeenCalledOnce();
  });

  it('performs a second exact teardown when post-start health fails', async () => {
    const downAction = vi.fn().mockResolvedValue(undefined);
    const stopRunAction = vi.fn().mockResolvedValue(undefined);

    await expect(
      refreshBuiltTopology({
        downAction,
        healthAction: vi.fn().mockRejectedValue(new Error('health failed')),
        output: output(),
        preflightAction: vi.fn().mockResolvedValue(undefined),
        stopRunAction,
        upAction: vi.fn().mockResolvedValue({ alreadyRunning: false, runId: 'failed-run' }),
      }),
    ).rejects.toThrow('health failed');

    expect(downAction).toHaveBeenCalledOnce();
    expect(stopRunAction).toHaveBeenCalledExactlyOnceWith('failed-run');
  });

  it('does not tear down a pre-existing run that won the inter-operation race', async () => {
    const downAction = vi.fn().mockResolvedValue(undefined);

    await expect(
      refreshBuiltTopology({
        downAction,
        healthAction: vi.fn(),
        output: output(),
        preflightAction: vi.fn().mockResolvedValue(undefined),
        stopRunAction: vi.fn(),
        upAction: vi.fn().mockResolvedValue({ alreadyRunning: true, runId: 'other-run' }),
      }),
    ).rejects.toThrow('pre-existing topology');

    expect(downAction).toHaveBeenCalledOnce();
  });

  it('reports both startup and cleanup failures without claiming teardown', async () => {
    const downAction = vi.fn().mockResolvedValue(undefined);

    await expect(
      refreshBuiltTopology({
        downAction,
        healthAction: vi.fn().mockRejectedValue(new Error('health failed')),
        output: output(),
        preflightAction: vi.fn().mockResolvedValue(undefined),
        stopRunAction: vi.fn().mockRejectedValue(new Error('cleanup failed')),
        upAction: vi.fn().mockResolvedValue({ alreadyRunning: false, runId: 'failed-run' }),
      }),
    ).rejects.toMatchObject({
      errors: [
        expect.objectContaining({ message: 'health failed' }),
        expect.objectContaining({ message: 'cleanup failed' }),
      ],
      message: 'Runtime refresh failed and exact-owned teardown could not be proven complete.',
    });
  });
});
