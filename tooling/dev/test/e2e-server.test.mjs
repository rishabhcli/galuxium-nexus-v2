import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

import { e2eServer } from '../e2e-server.mjs';

function fakeProcess() {
  const runtimeProcess = new EventEmitter();
  runtimeProcess.exitCode = undefined;
  runtimeProcess.pid = 4242;
  runtimeProcess.stderr = { write: vi.fn() };
  runtimeProcess.stdout = { write: vi.fn() };
  return runtimeProcess;
}

function lifecycleRecorder() {
  const records = [];
  return {
    records,
    writeLifecycleAction: vi.fn(async (value) => {
      records.push(value);
    }),
  };
}

describe('Playwright web-server lifecycle', () => {
  it('tears down a runtime started here when initial health fails', async () => {
    const downAction = vi.fn().mockResolvedValue(undefined);
    const runtimeProcess = fakeProcess();
    const { writeLifecycleAction } = lifecycleRecorder();

    await expect(
      e2eServer({
        downAction,
        healthAction: vi.fn().mockRejectedValue(new Error('initial health failed')),
        runtimeProcess,
        upAction: vi.fn().mockResolvedValue({ alreadyRunning: false, runId: 'run-a' }),
        writeLifecycleAction,
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
    const { writeLifecycleAction } = lifecycleRecorder();
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
        writeLifecycleAction,
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
    const { records, writeLifecycleAction } = lifecycleRecorder();
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
      writeLifecycleAction,
    });

    expect(downAction).not.toHaveBeenCalled();
    expect(timerControl.clearInterval).toHaveBeenCalledWith(42);
    expect(runtimeProcess.stdout.write).toHaveBeenCalledWith(
      '[dev:e2e-server] stopping reason=SIGTERM\n',
    );
    // A reused topology must never be recorded as a teardown this process owns.
    expect(records.at(-1)).toMatchObject({ phase: 'left-running', startedHere: false });
  });

  it('records a completed teardown of the topology it started', async () => {
    const runtimeProcess = fakeProcess();
    const { records, writeLifecycleAction } = lifecycleRecorder();
    const timerControl = {
      clearInterval: vi.fn(),
      setInterval: vi.fn(() => {
        queueMicrotask(() => runtimeProcess.emit('SIGTERM', 'SIGTERM'));
        return 43;
      }),
    };

    await e2eServer({
      downAction: vi.fn().mockResolvedValue(undefined),
      healthAction: vi.fn().mockResolvedValue(undefined),
      runtimeProcess,
      timerControl,
      upAction: vi.fn().mockResolvedValue({ alreadyRunning: false, runId: 'run-owned' }),
      writeLifecycleAction,
    });

    expect(records[0]).toMatchObject({ phase: 'ready', runId: 'run-owned', startedHere: true });
    expect(records.at(-1)).toMatchObject({
      phase: 'torn-down',
      runId: 'run-owned',
      startedHere: true,
    });
    expect(records.at(-1)?.teardownCompletedAt).toEqual(expect.any(String));
    expect(runtimeProcess.stdout.write).toHaveBeenCalledWith(
      '[dev:e2e-server] PASS stopped the topology it started.\n',
    );
  });

  it('surfaces both the server failure and the teardown failure without hiding either', async () => {
    const runtimeProcess = fakeProcess();
    const { records, writeLifecycleAction } = lifecycleRecorder();

    const failure = await e2eServer({
      downAction: vi.fn().mockRejectedValue(new Error('metrics would not stop')),
      healthAction: vi.fn().mockRejectedValue(new Error('initial health failed')),
      runtimeProcess,
      upAction: vi.fn().mockResolvedValue({ alreadyRunning: false, runId: 'run-both' }),
      writeLifecycleAction,
    }).catch((error) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure.errors.map((error) => error.message)).toEqual([
      'initial health failed',
      'metrics would not stop',
    ]);
    expect(records.at(-1)).toMatchObject({ phase: 'teardown-failed', startedHere: true });
  });

  it('records and rethrows a failed teardown instead of reporting a clean stop', async () => {
    const runtimeProcess = fakeProcess();
    const { records, writeLifecycleAction } = lifecycleRecorder();
    const timerControl = {
      clearInterval: vi.fn(),
      setInterval: vi.fn(() => {
        queueMicrotask(() => runtimeProcess.emit('SIGTERM', 'SIGTERM'));
        return 44;
      }),
    };

    await expect(
      e2eServer({
        downAction: vi.fn().mockRejectedValue(new Error('one owned PID would not stop')),
        healthAction: vi.fn().mockResolvedValue(undefined),
        runtimeProcess,
        timerControl,
        upAction: vi.fn().mockResolvedValue({ alreadyRunning: false, runId: 'run-stuck' }),
        writeLifecycleAction,
      }),
    ).rejects.toThrow('one owned PID would not stop');

    expect(records.at(-1)).toMatchObject({
      phase: 'teardown-failed',
      startedHere: true,
      teardownError: 'one owned PID would not stop',
    });
    expect(runtimeProcess.stdout.write).not.toHaveBeenCalledWith(
      '[dev:e2e-server] PASS stopped the topology it started.\n',
    );
  });
});
