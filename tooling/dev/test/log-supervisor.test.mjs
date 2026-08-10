import fs from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEV_PATHS, REPOSITORY_NAME, REPOSITORY_ROOT, serviceLogPath } from '../constants.mjs';
import {
  BoundedLogWriter,
  createStreamingRedactor,
  registerSignalForwarders,
  validateSupervisorConfiguration,
} from '../log-supervisor.mjs';

const BIRTH_IDENTITY = '12345678-1234-4123-8123-123456789abc';
const testPaths = [];

beforeEach(async () => {
  await fs.mkdir(DEV_PATHS.tmp, { mode: 0o700, recursive: true });
});

afterEach(async () => {
  await Promise.all(testPaths.splice(0).map((targetPath) => fs.rm(targetPath, { force: true })));
});

describe('bounded supervised log capture', () => {
  it('redacts a secret split across arbitrary output chunks', () => {
    const secret = 'test-only-secret-split-across-chunks';
    const redactor = createStreamingRedactor([secret]);
    const output = [
      redactor.push(Buffer.from('prefix test-only-secret-split-')),
      redactor.push(Buffer.from('across-chunks suffix')),
      redactor.flush(),
    ].join('');

    expect(output).toContain('[REDACTED]');
    expect(output).not.toContain(secret);
  });

  it('forwards the actual signal name even though Node signal events have no arguments', () => {
    const runtimeProcess = new EventEmitter();
    const forwardSignal = vi.fn();
    const remove = registerSignalForwarders(runtimeProcess, forwardSignal);

    runtimeProcess.emit('SIGINT');
    runtimeProcess.emit('SIGTERM');
    remove();

    expect(forwardSignal).toHaveBeenNthCalledWith(1, 'SIGINT');
    expect(forwardSignal).toHaveBeenNthCalledWith(2, 'SIGTERM');
    expect(runtimeProcess.listenerCount('SIGINT')).toBe(0);
    expect(runtimeProcess.listenerCount('SIGTERM')).toBe(0);
  });

  it('keeps both the live and single rotated file within a hard byte ceiling', async () => {
    const logPath = path.join(DEV_PATHS.tmp, `bounded-log-${process.pid}.log`);
    testPaths.push(logPath, `${logPath}.1`);
    const writer = new BoundedLogWriter(logPath, { maximumBytes: 128 });
    await writer.initialize();
    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        writer.write(`${String(index).padStart(3, '0')}:${'x'.repeat(92)}\n`),
      ),
    );
    await writer.close();

    const [current, rotated] = await Promise.all([fs.lstat(logPath), fs.lstat(`${logPath}.1`)]);
    expect(current.size).toBeLessThanOrEqual(128);
    expect(rotated.size).toBeLessThanOrEqual(128);
    const siblings = (await fs.readdir(DEV_PATHS.tmp)).filter((entry) =>
      entry.startsWith(path.basename(logPath)),
    );
    expect(siblings.sort()).toEqual([path.basename(logPath), `${path.basename(logPath)}.1`]);
  });

  it('caps an individual oversized write instead of allocating an oversized log', async () => {
    const logPath = path.join(DEV_PATHS.tmp, `oversized-log-${process.pid}.log`);
    testPaths.push(logPath, `${logPath}.1`);
    const writer = new BoundedLogWriter(logPath, { maximumBytes: 64 });
    await writer.initialize();
    await writer.write('sensitive-looking-output'.repeat(100));
    await writer.close();

    await expect(fs.lstat(logPath)).resolves.toMatchObject({ size: 64 });
  });

  it('honors a byte ceiling smaller than the truncation marker itself', async () => {
    const logPath = path.join(DEV_PATHS.tmp, `tiny-log-${process.pid}.log`);
    testPaths.push(logPath, `${logPath}.1`);
    const writer = new BoundedLogWriter(logPath, { maximumBytes: 8 });
    await writer.initialize();
    await writer.write('x'.repeat(100));
    await writer.close();

    await expect(fs.lstat(logPath)).resolves.toMatchObject({ size: 8 });
  });

  it('accepts only the exact service log and repository contract', () => {
    const configuration = {
      args: ['--test'],
      birthIdentity: BIRTH_IDENTITY,
      env: { PATH: '/usr/bin' },
      executable: '/usr/bin/true',
      logPath: serviceLogPath('redis'),
      redactionFilePaths: [],
      repository: REPOSITORY_NAME,
      repositoryRoot: REPOSITORY_ROOT,
      schemaVersion: 1,
      service: 'redis',
    };

    expect(validateSupervisorConfiguration(configuration, BIRTH_IDENTITY)).toBe(configuration);
    expect(() =>
      validateSupervisorConfiguration(
        { ...configuration, logPath: path.join(DEV_PATHS.tmp, 'redirected.log') },
        BIRTH_IDENTITY,
      ),
    ).toThrow(expect.objectContaining({ code: 'DEV_LOG_SUPERVISOR_CONFIG_INVALID' }));
  });
});
