import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

import { e2eServer } from '../e2e-server.mjs';

function fakeProcess() {
  const runtimeProcess = new EventEmitter();
  runtimeProcess.exitCode = undefined;
  runtimeProcess.stderr = { write: vi.fn() };
  runtimeProcess.stdout = { write: vi.fn() };
  return runtimeProcess;
}

describe('Playwright web-server lifecycle', () => {
  it('tears down a runtime started here when initial health fails', async () => {
    const downAction = vi.fn().mockResolvedValue(undefined);
    const runtimeProcess = fakeProcess();

    await expect(
      e2eServer({
        downAction,
        healthAction: vi.fn().mockRejectedValue(new Error('initial health failed')),
        runtimeProcess,
        upAction: vi.fn().mockResolvedValue({ alreadyRunning: false, runId: 'run-a' }),
      }),
    ).rejects.toThrow('initial health failed');

    expect(downAction).toHaveBeenCalledOnce();
    expect(runtimeProcess.listenerCount('SIGINT')).toBe(0);
    expect(runtimeProcess.listenerCount('SIGTERM')).toBe(0);
  });

  it('tears down once after a monitored health failure and clears signal listeners', async () => {
    const downAction = vi.fn().mockResolvedValue(undefined);
    const healthAction = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('monitor failed'));
    const runtimeProcess = fakeProcess();
    const timerControl = {
      clearInterval: vi.fn(),
      setInterval: vi.fn((callback) => {
        queueMicrotask(callback);
        return 41;
      }),
    };

    await expect(
      e2eServer({
        downAction,
        healthAction,
        runtimeProcess,
        timerControl,
        upAction: vi.fn().mockResolvedValue({ alreadyRunning: false, runId: 'run-b' }),
      }),
    ).resolves.toBeUndefined();

    expect(runtimeProcess.exitCode).toBe(1);
    expect(downAction).toHaveBeenCalledOnce();
    expect(timerControl.clearInterval).toHaveBeenCalledWith(41);
    expect(runtimeProcess.listenerCount('SIGINT')).toBe(0);
    expect(runtimeProcess.listenerCount('SIGTERM')).toBe(0);
  });

  it('does not stop a healthy pre-existing runtime when the web server receives a signal', async () => {
    const downAction = vi.fn();
    const runtimeProcess = fakeProcess();
    const timerControl = {
      clearInterval: vi.fn(),
      setInterval: vi.fn(() => {
        queueMicrotask(() => runtimeProcess.emit('SIGTERM', 'SIGTERM'));
        return 42;
      }),
    };

    await e2eServer({
      downAction,
      healthAction: vi.fn().mockResolvedValue(undefined),
      runtimeProcess,
      timerControl,
      upAction: vi.fn().mockResolvedValue({ alreadyRunning: true, runId: 'run-existing' }),
    });

    expect(downAction).not.toHaveBeenCalled();
    expect(timerControl.clearInterval).toHaveBeenCalledWith(42);
    expect(runtimeProcess.stdout.write).toHaveBeenCalledWith(
      '[dev:e2e-server] stopping reason=SIGTERM\n',
    );
  });
});
