import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { COMMAND_TIMEOUT_MS } from './constants.mjs';
import { DevContractError } from './errors.mjs';

const execFileAsync = promisify(execFile);

function sanitizedCommandCause(error, sanitize) {
  const cause = new Error('External command execution failed.');
  cause.name = 'CommandExecutionError';
  const code = error?.code;
  if (typeof code === 'number' || typeof code === 'string') {
    cause.code = sanitize(String(code));
  }
  if (typeof error?.signal === 'string') {
    cause.signal = sanitize(error.signal);
  }
  cause.killed = error?.killed === true;
  return cause;
}

export function safeEnvironment(overrides = {}) {
  const environment = {};
  for (const name of ['HOME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'PATH', 'TZ']) {
    if (typeof process.env[name] === 'string') {
      environment[name] = process.env[name];
    }
  }
  return { ...environment, ...overrides };
}

export async function findExecutable(name) {
  const pathValue = process.env.PATH ?? '';
  for (const directory of pathValue.split(path.delimiter)) {
    if (!directory) {
      continue;
    }
    const candidate = path.join(directory, name);
    try {
      await fs.access(candidate, fsConstants.X_OK);
      return await fs.realpath(candidate);
    } catch {
      // Keep searching PATH. A missing candidate is expected.
    }
  }
  throw new DevContractError(
    'DEV_TOOL_MISSING',
    `Required executable '${name}' was not found on PATH.`,
  );
}

export async function execute(
  executable,
  args,
  {
    allowExitCodes = [0],
    cwd,
    env,
    maxBuffer = 1024 * 1024,
    sensitiveValues = [],
    timeout = COMMAND_TIMEOUT_MS,
  } = {},
) {
  const sanitize = (value) =>
    sensitiveValues.reduce(
      (result, sensitiveValue) =>
        typeof sensitiveValue === 'string' && sensitiveValue.length > 0
          ? result.replaceAll(sensitiveValue, '[REDACTED]')
          : result,
      typeof value === 'string' ? value : '',
    );
  const renderedCommand = sanitize([executable, ...args].join(' '));
  try {
    const result = await execFileAsync(executable, args, {
      cwd,
      encoding: 'utf8',
      env: env ?? safeEnvironment(),
      maxBuffer,
      timeout,
      windowsHide: true,
    });
    return {
      exitCode: 0,
      stderr: sanitize(result.stderr),
      stdout: sanitize(result.stdout),
    };
  } catch (error) {
    const exitCode = typeof error?.code === 'number' ? error.code : undefined;
    const safeCause = sanitizedCommandCause(error, sanitize);
    if (exitCode !== undefined && allowExitCodes.includes(exitCode)) {
      return {
        exitCode,
        stderr: sanitize(error.stderr),
        stdout: sanitize(error.stdout),
      };
    }
    if (error?.killed || error?.code === 'ETIMEDOUT') {
      throw new DevContractError(
        'DEV_COMMAND_TIMEOUT',
        `Command timed out after ${timeout} ms: ${renderedCommand}`,
        undefined,
        { cause: safeCause },
      );
    }
    throw new DevContractError(
      'DEV_COMMAND_FAILED',
      `Command failed: ${renderedCommand}`,
      {
        exitCode: exitCode ?? null,
        stderr: sanitize(error?.stderr).trim(),
        stdout: sanitize(error?.stdout).trim(),
      },
      { cause: safeCause },
    );
  }
}
