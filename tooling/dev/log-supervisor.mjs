import { spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';

import { REPOSITORY_NAME, REPOSITORY_ROOT, SERVICE_BY_NAME, serviceLogPath } from './constants.mjs';
import { isMain } from './cli.mjs';
import { DevContractError, errorMessage } from './errors.mjs';
import { assertInsideRepository } from './filesystem.mjs';
import { processBirthIdentityArgument } from './ownership.mjs';

export const MAX_SERVICE_LOG_BYTES = 5 * 1024 * 1024;
const MAX_CONFIG_BYTES = 128 * 1024;
const MAX_CAPTURE_BUFFER_BYTES = 64 * 1024;
const REDACTION_MARKER = '[REDACTED]';

function redactText(value, redactions) {
  return redactions.reduce(
    (result, redaction) => result.replaceAll(redaction, REDACTION_MARKER),
    value,
  );
}

function isPlainRecord(value) {
  return (
    value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype
  );
}

function validateStringArray(value, { maximumItems, maximumLength }) {
  return (
    Array.isArray(value) &&
    value.length <= maximumItems &&
    value.every((entry) => typeof entry === 'string' && entry.length <= maximumLength)
  );
}

export function validateSupervisorConfiguration(value, expectedBirthIdentity) {
  const service = SERVICE_BY_NAME.get(value?.service);
  if (
    !service ||
    value?.schemaVersion !== 1 ||
    value?.repository !== REPOSITORY_NAME ||
    value?.repositoryRoot !== REPOSITORY_ROOT ||
    value?.birthIdentity !== expectedBirthIdentity ||
    typeof value?.executable !== 'string' ||
    !path.isAbsolute(value.executable) ||
    !validateStringArray(value?.args, { maximumItems: 128, maximumLength: 8_192 }) ||
    !validateStringArray(value?.redactionFilePaths, { maximumItems: 8, maximumLength: 4_096 }) ||
    value?.logPath !== serviceLogPath(service.name) ||
    !isPlainRecord(value?.env) ||
    Object.keys(value.env).length > 128 ||
    Object.entries(value.env).some(
      ([key, entry]) =>
        !/^[A-Z_][A-Z0-9_]*$/u.test(key) || typeof entry !== 'string' || entry.length > 8_192,
    )
  ) {
    throw new DevContractError(
      'DEV_LOG_SUPERVISOR_CONFIG_INVALID',
      'The log supervisor configuration does not match the closed runtime contract.',
    );
  }
  assertInsideRepository(value.logPath);
  for (const redactionPath of value.redactionFilePaths) {
    assertInsideRepository(redactionPath);
  }
  return value;
}

async function readPrivateRegularFile(targetPath, maximumBytes) {
  assertInsideRepository(targetPath);
  const handle = await fs.open(targetPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat();
    if (
      !metadata.isFile() ||
      metadata.size < 1 ||
      metadata.size > maximumBytes ||
      (metadata.mode & 0o077) !== 0
    ) {
      throw new DevContractError(
        'DEV_LOG_SUPERVISOR_INPUT_UNSAFE',
        `Supervisor input must be a bounded private regular file: ${targetPath}`,
      );
    }
    const contents = Buffer.alloc(metadata.size);
    const { bytesRead } = await handle.read(contents, 0, contents.length, 0);
    if (bytesRead !== metadata.size) {
      throw new DevContractError(
        'DEV_LOG_SUPERVISOR_INPUT_CHANGED',
        `Supervisor input changed while being read: ${targetPath}`,
      );
    }
    return contents.toString('utf8');
  } finally {
    await handle.close();
  }
}

async function readRedactionValues(paths) {
  const values = [];
  for (const targetPath of paths) {
    const value = (await readPrivateRegularFile(targetPath, 4_096)).trim();
    if (value.length > 0) {
      values.push(value);
    }
  }
  return [...new Set(values)].sort((left, right) => right.length - left.length);
}

export function createStreamingRedactor(values) {
  const redactions = [
    ...new Set(values.filter((value) => typeof value === 'string' && value.length > 0)),
  ].sort((left, right) => right.length - left.length);
  const decoder = new StringDecoder('utf8');
  const retainedCharacters = Math.max(0, ...redactions.map((value) => value.length - 1));
  let pending = '';

  function redact(value) {
    return redactText(value, redactions);
  }

  return {
    flush() {
      pending += decoder.end();
      const output = redact(pending);
      pending = '';
      return output;
    },
    push(chunk) {
      pending += decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      const redacted = redact(pending);
      if (redacted.length <= retainedCharacters) {
        return '';
      }
      const emitLength = redacted.length - retainedCharacters;
      const output = redacted.slice(0, emitLength);
      pending = redacted.slice(emitLength);
      return output;
    },
  };
}

export function registerSignalForwarders(runtimeProcess, forwardSignal) {
  const onInterrupt = () => forwardSignal('SIGINT');
  const onTerminate = () => forwardSignal('SIGTERM');
  runtimeProcess.on('SIGINT', onInterrupt);
  runtimeProcess.on('SIGTERM', onTerminate);
  return () => {
    runtimeProcess.removeListener('SIGINT', onInterrupt);
    runtimeProcess.removeListener('SIGTERM', onTerminate);
  };
}

async function assertSafeExistingLog(targetPath, maximumBytes) {
  let handle;
  try {
    handle = await fs.open(targetPath, fsConstants.O_RDWR | fsConstants.O_NOFOLLOW);
    const metadata = await handle.stat();
    if (!metadata.isFile()) {
      throw new DevContractError(
        'DEV_UNSAFE_LOG_PATH',
        `Service log must be a regular non-symlink file: ${targetPath}`,
      );
    }
    if (metadata.size > maximumBytes) {
      await handle.truncate(maximumBytes);
    }
    await handle.chmod(0o600);
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw error;
    }
  } finally {
    await handle?.close();
  }
}

export class BoundedLogWriter {
  constructor(logPath, { maximumBytes = MAX_SERVICE_LOG_BYTES } = {}) {
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
      throw new DevContractError('DEV_LOG_LIMIT_INVALID', 'Service log limit must be positive.');
    }
    assertInsideRepository(logPath);
    this.logPath = logPath;
    this.maximumBytes = maximumBytes;
    this.rotatedPath = `${logPath}.1`;
    this.handle = undefined;
    this.size = 0;
    this.closing = false;
    this.writeChain = Promise.resolve();
  }

  async initialize() {
    await assertSafeExistingLog(this.logPath, this.maximumBytes);
    await assertSafeExistingLog(this.rotatedPath, this.maximumBytes);
    await this.openCurrent();
  }

  async openCurrent() {
    this.handle = await fs.open(
      this.logPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_APPEND | fsConstants.O_NOFOLLOW,
      0o600,
    );
    const metadata = await this.handle.stat();
    if (!metadata.isFile() || metadata.size > this.maximumBytes || (metadata.mode & 0o077) !== 0) {
      await this.handle.close();
      this.handle = undefined;
      throw new DevContractError(
        'DEV_UNSAFE_LOG_PATH',
        `Service log changed during bounded capture: ${this.logPath}`,
      );
    }
    this.size = metadata.size;
  }

  async rotate() {
    await this.handle?.close();
    this.handle = undefined;
    await assertSafeExistingLog(this.rotatedPath, this.maximumBytes);
    await fs.rm(this.rotatedPath, { force: true });
    try {
      await fs.rename(this.logPath, this.rotatedPath);
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        throw error;
      }
    }
    await this.openCurrent();
  }

  async write(value) {
    if (!this.handle || this.closing) {
      throw new DevContractError('DEV_LOG_WRITER_CLOSED', 'Cannot write to a closed log writer.');
    }
    const input = Buffer.isBuffer(value) ? Buffer.from(value) : Buffer.from(value, 'utf8');
    const operation = this.writeChain.then(() => this.writeBytes(input));
    this.writeChain = operation;
    return operation;
  }

  async writeBytes(input) {
    let bytes = input;
    if (bytes.length > this.maximumBytes) {
      const marker = Buffer.from('[dev:log] output chunk truncated to bounded tail\n', 'utf8');
      if (marker.length >= this.maximumBytes) {
        bytes = marker.subarray(0, this.maximumBytes);
      } else {
        const tailLength = this.maximumBytes - marker.length;
        bytes = Buffer.concat([marker, bytes.subarray(bytes.length - tailLength)]);
      }
    }
    if (this.size + bytes.length > this.maximumBytes) {
      await this.rotate();
    }
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesWritten } = await this.handle.write(bytes, offset, bytes.length - offset, null);
      if (bytesWritten < 1) {
        throw new DevContractError(
          'DEV_LOG_WRITE_INCOMPLETE',
          'The bounded log writer could not make forward progress.',
        );
      }
      offset += bytesWritten;
    }
    this.size += offset;
  }

  async close() {
    this.closing = true;
    let writeError;
    try {
      await this.writeChain;
    } catch (error) {
      writeError = error;
    } finally {
      await this.handle?.close();
      this.handle = undefined;
    }
    if (writeError) {
      throw writeError;
    }
  }
}

async function readSupervisorConfiguration(configPath, birthIdentity) {
  const raw = await readPrivateRegularFile(configPath, MAX_CONFIG_BYTES);
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new DevContractError(
      'DEV_LOG_SUPERVISOR_CONFIG_JSON',
      'The log supervisor configuration is not valid JSON.',
      undefined,
      { cause: error },
    );
  }
  return validateSupervisorConfiguration(parsed, birthIdentity);
}

async function captureTarget(configuration) {
  const redactionValues = await readRedactionValues(configuration.redactionFilePaths);
  const redactor = createStreamingRedactor(redactionValues);
  const writer = new BoundedLogWriter(configuration.logPath);
  await writer.initialize();
  await writer.write(
    `\n--- dev:supervisor service=${configuration.service} at=${new Date().toISOString()} ---\n`,
  );

  const combined = new PassThrough({ highWaterMark: MAX_CAPTURE_BUFFER_BYTES });
  const child = spawn(configuration.executable, configuration.args, {
    cwd: REPOSITORY_ROOT,
    detached: false,
    env: configuration.env,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let pendingSignal;
  const forwardSignal = (signal) => {
    if (child.exitCode === null && child.signalCode === null) {
      try {
        child.kill(signal);
      } catch (error) {
        if (error?.code !== 'ESRCH') {
          void writer
            .write(
              redactText(
                `[dev:supervisor] signal-forward-error ${errorMessage(error)}\n`,
                redactionValues,
              ),
            )
            .catch(() => undefined);
        }
      }
    } else {
      pendingSignal = signal;
    }
  };
  const removeSignalForwarders = registerSignalForwarders(process, forwardSignal);

  child.stdout.pipe(combined, { end: false });
  child.stderr.pipe(combined, { end: false });
  let openStreams = 2;
  const closeCombined = () => {
    openStreams -= 1;
    if (openStreams === 0) {
      combined.end();
    }
  };
  child.stdout.once('end', closeCombined);
  child.stderr.once('end', closeCombined);

  const capture = (async () => {
    for await (const chunk of combined) {
      const safe = redactor.push(chunk);
      if (safe.length > 0) {
        await writer.write(safe);
      }
    }
    const tail = redactor.flush();
    if (tail.length > 0) {
      await writer.write(tail);
    }
  })();

  const targetOutcome = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  let captureError;
  const watchedCapture = capture.catch((error) => {
    captureError = error;
    child.stdout.unpipe(combined);
    child.stderr.unpipe(combined);
    combined.end();
    // The ChildProcess object remains exact until its exit event is reaped.
    // If termination cannot be delivered, keep this supervisor alive awaiting
    // targetOutcome so the repository retains a verifiable group leader.
    if (child.exitCode === null && child.signalCode === null) {
      try {
        child.kill('SIGTERM');
      } catch {
        // The exact-owned shutdown orchestrator can reverify and retry.
      }
    }
  });
  let outcome;
  try {
    outcome = await targetOutcome;
    if (pendingSignal) {
      forwardSignal(pendingSignal);
    }
    await watchedCapture;
    if (captureError) {
      throw captureError;
    }
    await writer.write(
      `[dev:supervisor] target-exit code=${String(outcome.code)} signal=${String(outcome.signal)}\n`,
    );
  } catch (error) {
    child.stdout.unpipe(combined);
    child.stderr.unpipe(combined);
    combined.end();
    await watchedCapture;
    await writer.write(
      redactText(`[dev:supervisor] target-failure ${errorMessage(error)}\n`, redactionValues),
    );
    throw error;
  } finally {
    removeSignalForwarders();
    await writer.close();
  }
  if (outcome.signal !== null) {
    process.exitCode = 1;
  } else {
    process.exitCode = outcome.code ?? 1;
  }
}

export async function runLogSupervisor(argv = process.argv.slice(2)) {
  const [configPath, rawBirthArgument, ...extra] = argv;
  const prefix = '--dev-birth-identity=';
  if (
    !configPath ||
    !rawBirthArgument?.startsWith(prefix) ||
    extra.length > 0 ||
    !path.isAbsolute(configPath)
  ) {
    throw new DevContractError(
      'DEV_LOG_SUPERVISOR_ARGUMENTS',
      'The log supervisor requires one absolute config path and one process birth identity.',
    );
  }
  assertInsideRepository(configPath);
  const birthIdentity = rawBirthArgument.slice(prefix.length);
  processBirthIdentityArgument(birthIdentity);
  const configuration = await readSupervisorConfiguration(configPath, birthIdentity);
  await captureTarget(configuration);
}

if (isMain(import.meta.url)) {
  try {
    await runLogSupervisor();
  } catch (error) {
    process.stderr.write(`[DEV_LOG_SUPERVISOR_FAILED] ${errorMessage(error)}\n`);
    process.exitCode = 1;
  }
}
