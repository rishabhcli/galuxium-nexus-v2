import { describe, expect, it } from 'vitest';

import { execute, safeEnvironment } from '../command.mjs';

function reachableStrings(value, seen = new WeakSet()) {
  if (typeof value === 'string') {
    return [value];
  }
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) {
    return [];
  }
  if (seen.has(value)) {
    return [];
  }
  seen.add(value);
  const strings = [];
  for (const key of Reflect.ownKeys(value)) {
    strings.push(String(key));
    let child;
    try {
      child = value[key];
    } catch {
      continue;
    }
    strings.push(...reachableStrings(child, seen));
  }
  return strings;
}

describe('bounded command output redaction', () => {
  it('removes declared in-memory secrets from successful output', async () => {
    const secret = 'test-only-success-secret-that-must-not-escape';
    const result = await execute(
      process.execPath,
      [
        '-e',
        "process.stdout.write(process.env.TEST_SECRET ?? ''); process.stderr.write(process.env.TEST_SECRET ?? '');",
      ],
      {
        env: safeEnvironment({ TEST_SECRET: secret }),
        sensitiveValues: [secret],
      },
    );

    expect(result).toEqual({
      exitCode: 0,
      stderr: '[REDACTED]',
      stdout: '[REDACTED]',
    });
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it('removes declared in-memory secrets from failed command evidence', async () => {
    const secret = 'test-only-secret-that-must-not-escape';
    let failure;
    try {
      await execute(
        process.execPath,
        ['-e', "process.stderr.write(process.env.TEST_SECRET ?? ''); process.exitCode = 2;"],
        {
          env: safeEnvironment({ TEST_SECRET: secret }),
          sensitiveValues: [secret],
        },
      );
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({
      code: 'DEV_COMMAND_FAILED',
      details: { stderr: '[REDACTED]' },
    });
    expect(reachableStrings(failure).join('\n')).not.toContain(secret);
    expect(failure?.cause).toMatchObject({ name: 'CommandExecutionError' });
  });

  it('redacts declared secrets from a failed command argv rendering', async () => {
    const secret = 'test-only-argv-secret-that-must-not-escape';

    await expect(
      execute(process.execPath, ['-e', 'process.exit(2)', secret], {
        sensitiveValues: [secret],
      }),
    ).rejects.toMatchObject({
      code: 'DEV_COMMAND_FAILED',
      message: expect.not.stringContaining(secret),
    });
  });

  it('redacts declared secrets from a timed-out command argv rendering', async () => {
    const secret = 'test-only-timeout-secret-that-must-not-escape';

    await expect(
      execute(process.execPath, ['-e', 'setTimeout(() => {}, 10_000)', secret], {
        sensitiveValues: [secret],
        timeout: 25,
      }),
    ).rejects.toMatchObject({
      code: 'DEV_COMMAND_TIMEOUT',
      message: expect.not.stringContaining(secret),
    });
  });
});
