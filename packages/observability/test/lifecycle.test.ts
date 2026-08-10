import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

import {
  createIdempotentCleanup,
  LifecycleError,
  runUntilSignalled,
  type SignalSource,
} from '../src/lifecycle.js';
import { createLogger, type LogRecord } from '../src/logger.js';

function harness(): {
  readonly logger: ReturnType<typeof createLogger>;
  readonly logs: readonly LogRecord[];
} {
  const logs: LogRecord[] = [];
  return {
    logger: createLogger({
      minimumLevel: 'debug',
      service: 'lifecycle-test',
      write: (line) => logs.push(JSON.parse(line) as LogRecord),
    }),
    logs,
  };
}

function signalSource(emitter: EventEmitter): SignalSource {
  return emitter;
}

describe('createIdempotentCleanup', () => {
  it('runs every cleanup with all-settled semantics and reuses one result', async () => {
    const testHarness = harness();
    const first = vi.fn(() => {
      throw new Error('private cleanup failure detail');
    });
    const second = vi.fn(async () => Promise.resolve());
    const cleanup = createIdempotentCleanup(
      [
        { close: first, name: 'first-resource' },
        { close: second, name: 'second-resource' },
      ],
      testHarness.logger,
    );

    const firstCall = cleanup();
    const secondCall = cleanup();
    expect(secondCall).toBe(firstCall);
    await expect(firstCall).rejects.toMatchObject({ code: 'SERVICE_CLEANUP_FAILED' });
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(testHarness.logs)).not.toContain('private cleanup failure detail');
  });
});

describe('runUntilSignalled', () => {
  it('removes both signal listeners after one bounded shutdown', async () => {
    const testHarness = harness();
    const emitter = new EventEmitter();
    const close = vi.fn(async () => Promise.resolve());
    const running = runUntilSignalled(
      { close, listen: vi.fn(async () => Promise.resolve()) },
      testHarness.logger,
      { shutdownTimeoutMs: 100, signalSource: signalSource(emitter) },
    );
    await vi.waitFor(() => {
      expect(emitter.listenerCount('SIGINT')).toBe(1);
      expect(emitter.listenerCount('SIGTERM')).toBe(1);
    });

    emitter.emit('SIGTERM');
    await expect(running).resolves.toBeUndefined();

    expect(close).toHaveBeenCalledTimes(1);
    expect(emitter.listenerCount('SIGINT')).toBe(0);
    expect(emitter.listenerCount('SIGTERM')).toBe(0);
  });

  it('rejects a shutdown that ignores its deadline and still removes listeners', async () => {
    const testHarness = harness();
    const emitter = new EventEmitter();
    const running = runUntilSignalled(
      {
        close: async () => new Promise<never>(() => undefined),
        listen: async () => Promise.resolve(),
      },
      testHarness.logger,
      { shutdownTimeoutMs: 20, signalSource: signalSource(emitter) },
    );
    await vi.waitFor(() => {
      expect(emitter.listenerCount('SIGINT')).toBe(1);
    });

    emitter.emit('SIGINT');

    await expect(running).rejects.toBeInstanceOf(LifecycleError);
    expect(emitter.listenerCount('SIGINT')).toBe(0);
    expect(emitter.listenerCount('SIGTERM')).toBe(0);
  });

  it('rolls back a failed listen before preserving the startup failure', async () => {
    const testHarness = harness();
    const startupError = new Error('private bind failure detail');
    const close = vi.fn(async () => Promise.resolve());

    await expect(
      runUntilSignalled(
        {
          close,
          listen: async () => Promise.reject(startupError),
        },
        testHarness.logger,
        { shutdownTimeoutMs: 100, signalSource: signalSource(new EventEmitter()) },
      ),
    ).rejects.toBe(startupError);
    expect(close).toHaveBeenCalledTimes(1);
  });
});
