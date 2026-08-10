import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  redisCliVersionOutputMatches,
  redisServerVersionOutputMatches,
} from '../ci/provision-native.mjs';
import { extractExpectedVersion } from '../dependencies/verify.mjs';
import { runBoundedCommand } from '../pinned-runtime.mjs';

class FakeChild extends EventEmitter {
  constructor(onKill = () => {}) {
    super();
    this.onKill = onKill;
    this.signals = [];
    this.stderr = new PassThrough();
    this.stdout = new PassThrough();
    this.unrefCalls = 0;
  }

  kill(signal) {
    this.signals.push(signal);
    this.onKill(signal, this);
    return true;
  }

  unref() {
    this.unrefCalls += 1;
  }
}

function commandFor(child, options = {}) {
  return runBoundedCommand('fake-command', [], {
    killWaitMs: 20,
    maximumOutputBytes: 64,
    spawnImplementation: () => child,
    terminationGraceMs: 20,
    timeoutMs: 20,
    ...options,
  });
}

function expectListenersCleaned(child) {
  expect(child.listenerCount('close')).toBe(0);
  expect(child.listenerCount('error')).toBe(0);
  expect(child.stdout.listenerCount('data')).toBe(0);
  expect(child.stderr.listenerCount('data')).toBe(0);
}

afterEach(() => {
  vi.useRealTimers();
});

describe('bounded exact-child subprocesses', () => {
  it('collects bounded output and clears its listeners after success', async () => {
    const child = new FakeChild();
    const resultPromise = commandFor(child);
    child.stdout.write('ready');
    child.stderr.write('notice');
    child.emit('close', 0, null);

    await expect(resultPromise).resolves.toEqual({
      code: 0,
      signal: null,
      stderr: 'notice',
      stdout: 'ready',
    });
    expect(child.signals).toEqual([]);
    expectListenersCleaned(child);
  });

  it('rejects a timeout even when the SIGTERM handler exits zero', async () => {
    vi.useFakeTimers();
    const child = new FakeChild((signal, target) => {
      if (signal === 'SIGTERM') {
        target.emit('close', 0, null);
      }
    });
    const resultPromise = commandFor(child);
    const rejection = expect(resultPromise).rejects.toMatchObject({
      code: 'SUBPROCESS_TIMEOUT',
    });

    await vi.advanceTimersByTimeAsync(20);
    await rejection;
    expect(child.signals).toEqual(['SIGTERM']);
    expectListenersCleaned(child);
  });

  it('escalates an ignored SIGTERM to SIGKILL for only that exact child', async () => {
    vi.useFakeTimers();
    const child = new FakeChild((signal, target) => {
      if (signal === 'SIGKILL') {
        target.emit('close', null, 'SIGKILL');
      }
    });
    const resultPromise = commandFor(child);
    const rejection = expect(resultPromise).rejects.toMatchObject({
      code: 'SUBPROCESS_TIMEOUT',
    });

    await vi.advanceTimersByTimeAsync(40);
    await rejection;
    expect(child.signals).toEqual(['SIGTERM', 'SIGKILL']);
    expectListenersCleaned(child);
  });

  it('settles after the bounded SIGKILL wait when a fake child never closes', async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    const resultPromise = commandFor(child);
    const rejection = expect(resultPromise).rejects.toMatchObject({
      code: 'SUBPROCESS_TIMEOUT',
    });

    await vi.advanceTimersByTimeAsync(60);
    await rejection;
    expect(child.signals).toEqual(['SIGTERM', 'SIGKILL']);
    expect(child.unrefCalls).toBe(1);
    expectListenersCleaned(child);
  });

  it('terminates and cleans up after the combined output cap is exceeded', async () => {
    const child = new FakeChild((signal, target) => {
      if (signal === 'SIGTERM') {
        target.emit('close', 0, null);
      }
    });
    const resultPromise = commandFor(child, { maximumOutputBytes: 4 });
    const rejection = expect(resultPromise).rejects.toMatchObject({
      code: 'SUBPROCESS_OUTPUT_LIMIT',
    });
    child.stdout.write('12345');

    await rejection;
    expect(child.signals).toEqual(['SIGTERM']);
    expectListenersCleaned(child);
  });
});

describe('exact Redis version parsing', () => {
  it('accepts only the expected server and CLI identities with a version delimiter', () => {
    expect(redisServerVersionOutputMatches('Redis server v=8.10.0')).toBe(true);
    expect(redisServerVersionOutputMatches('Redis server v=8.10.0 sha=abc bits=64')).toBe(true);
    expect(redisCliVersionOutputMatches('redis-cli 8.10.0')).toBe(true);
    expect(redisCliVersionOutputMatches('redis-cli 8.10.0\n')).toBe(true);
  });

  it('refuses suffixes, longer versions, and unanchored identities in the provisioner', () => {
    expect(redisServerVersionOutputMatches('Redis server v=8.10.0-rc1 sha=abc')).toBe(false);
    expect(redisServerVersionOutputMatches('prefix Redis server v=8.10.0')).toBe(false);
    expect(redisCliVersionOutputMatches('redis-cli 8.10.0.1')).toBe(false);
    expect(redisCliVersionOutputMatches('redis-cli 8.10.0-rc1')).toBe(false);
  });

  it('refuses Redis suffixes and unanchored identities in dependency evidence parsing', () => {
    expect(extractExpectedVersion('redis-server', 'Redis server v=8.10.0 sha=abc')).toBe('8.10.0');
    expect(extractExpectedVersion('redis-cli', 'redis-cli 8.10.0')).toBe('8.10.0');
    expect(extractExpectedVersion('redis-server', 'Redis server v=8.10.0-rc1')).toBeNull();
    expect(extractExpectedVersion('redis-cli', 'redis-cli 8.10.0.1')).toBeNull();
    expect(extractExpectedVersion('redis-cli', 'prefix redis-cli 8.10.0')).toBeNull();
  });
});
