import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

import { pipeBoundedResponse } from './bounded-download.mjs';

export const PINNED_NODE_VERSION = '24.18.0';
export const PINNED_NPM_VERSION = '11.16.0';

const DEFAULT_SUBPROCESS_TIMEOUT_MS = 15 * 60_000;
const DEFAULT_TERMINATION_GRACE_MS = 1_000;
const DEFAULT_KILL_WAIT_MS = 1_000;
const VERSION_PROBE_TIMEOUT_MS = 10_000;
const VERSION_OUTPUT_LIMIT_BYTES = 16 * 1024;

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEV_ROOT = path.join(REPOSITORY_ROOT, '.dev');
const CACHE_ROOT = path.join(DEV_ROOT, 'cache');
const TEMPORARY_ROOT = path.join(DEV_ROOT, 'tmp');

const ARTIFACTS = Object.freeze({
  'darwin-arm64': Object.freeze({
    archive: 'node-v24.18.0-darwin-arm64.tar.gz',
    sha256: 'e1a97e14c99c803e96c7339403282ea05a499c32f8d83defe9ef5ec66f979ed1',
    tarFlag: '-xzf',
  }),
  'darwin-x64': Object.freeze({
    archive: 'node-v24.18.0-darwin-x64.tar.gz',
    sha256: 'dfd0dbd3e721503434df7b7205e719f61b3a3a31b2bcf9729b8b91fea240f080',
    tarFlag: '-xzf',
  }),
  'linux-arm64': Object.freeze({
    archive: 'node-v24.18.0-linux-arm64.tar.xz',
    sha256: '58c9520501f6ae2b52d5b210444e24b9d0c029a58c5011b797bc1fe7105886f6',
    tarFlag: '-xJf',
  }),
  'linux-x64': Object.freeze({
    archive: 'node-v24.18.0-linux-x64.tar.xz',
    sha256: '55aa7153f9d88f28d765fcdad5ae6945b5c0f98a36881703817e4c450fa76742',
    tarFlag: '-xJf',
  }),
});

function selectedArtifact() {
  const key = `${process.platform}-${process.arch}`;
  const artifact = ARTIFACTS[key];
  if (artifact === undefined) {
    throw new Error(
      `No pinned Node artifact is admitted for ${key}. Supported bootstrap targets: ${Object.keys(ARTIFACTS).join(', ')}.`,
    );
  }
  return artifact;
}

function assertInsideRepository(targetPath) {
  const relative = path.relative(REPOSITORY_ROOT, path.resolve(targetPath));
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Refusing a runtime path outside this repository: ${targetPath}`);
  }
}

async function ensureDirectory(targetPath) {
  assertInsideRepository(targetPath);
  try {
    const metadata = await fs.lstat(targetPath);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new Error(`Pinned runtime path must be a real directory: ${targetPath}`);
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw error;
    }
    await fs.mkdir(targetPath, { mode: 0o700, recursive: true });
  }
}

function positiveInteger(value, label, { allowZero = false } = {}) {
  if (!Number.isSafeInteger(value) || (allowZero ? value < 0 : value <= 0)) {
    throw new Error(`${label} must be ${allowZero ? 'a non-negative' : 'a positive'} integer.`);
  }
  return value;
}

function subprocessError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/**
 * Spawn one exact child with a hard deadline and bounded output collection.
 * Termination deliberately targets only the returned ChildProcess: SIGTERM,
 * a bounded grace period, then SIGKILL. Ordinary non-zero exits are returned
 * to callers; timeout/output-limit/spawn failures reject.
 */
export function runBoundedCommand(executable, args, options = {}) {
  const timeoutMs = positiveInteger(
    options.timeoutMs ?? DEFAULT_SUBPROCESS_TIMEOUT_MS,
    'Subprocess timeout',
  );
  const terminationGraceMs = positiveInteger(
    options.terminationGraceMs ?? DEFAULT_TERMINATION_GRACE_MS,
    'Subprocess termination grace',
    { allowZero: true },
  );
  const killWaitMs = positiveInteger(
    options.killWaitMs ?? DEFAULT_KILL_WAIT_MS,
    'Subprocess SIGKILL wait',
    { allowZero: true },
  );
  const maximumOutputBytes = positiveInteger(
    options.maximumOutputBytes ?? Number.MAX_SAFE_INTEGER,
    'Subprocess output limit',
  );
  const spawnImplementation = options.spawnImplementation ?? spawn;
  if (typeof executable !== 'string' || executable.length === 0) {
    throw new Error('Subprocess executable must be a non-empty string.');
  }
  if (!Array.isArray(args) || !args.every((argument) => typeof argument === 'string')) {
    throw new Error('Subprocess arguments must be an array of strings.');
  }
  if (typeof spawnImplementation !== 'function') {
    throw new Error('Subprocess spawn implementation must be a function.');
  }

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnImplementation(executable, args, {
        cwd: options.cwd ?? REPOSITORY_ROOT,
        env: options.env ?? process.env,
        shell: false,
        stdio: options.stdio ?? ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      reject(error);
      return;
    }

    let deadlineTimer;
    let terminationTimer;
    let killWaitTimer;
    let settled = false;
    let terminatingFailure;
    let outputBytes = 0;
    const stdoutChunks = [];
    const stderrChunks = [];

    const removeOutputListeners = () => {
      child.stdout?.removeListener('data', onStdout);
      child.stderr?.removeListener('data', onStderr);
    };

    const discardRemainingOutput = () => {
      removeOutputListeners();
      child.stdout?.resume();
      child.stderr?.resume();
    };

    const cleanup = () => {
      clearTimeout(deadlineTimer);
      clearTimeout(terminationTimer);
      clearTimeout(killWaitTimer);
      child.removeListener('error', onError);
      child.removeListener('close', onClose);
      removeOutputListeners();
    };

    const settle = (error, result) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      if (error === undefined) {
        resolve(result);
      } else {
        reject(error);
      }
    };

    const forceKill = () => {
      if (settled) {
        return;
      }
      try {
        child.kill('SIGKILL');
      } catch {
        // The bounded kill-wait below remains authoritative even if the exact
        // process disappeared between the timeout and this signal attempt.
      }
      if (!settled) {
        killWaitTimer = setTimeout(() => {
          if (settled) {
            return;
          }
          child.stdout?.destroy();
          child.stderr?.destroy();
          child.unref?.();
          settle(terminatingFailure);
        }, killWaitMs);
      }
    };

    const terminate = (failure) => {
      if (settled || terminatingFailure !== undefined) {
        return;
      }
      terminatingFailure = failure;
      clearTimeout(deadlineTimer);
      discardRemainingOutput();
      try {
        child.kill('SIGTERM');
      } catch {
        // Continue to the exact-child SIGKILL phase; the child may have raced
        // with this signal without its close event having been delivered yet.
      }
      if (!settled) {
        terminationTimer = setTimeout(forceKill, terminationGraceMs);
      }
    };

    const appendOutput = (chunks, chunk) => {
      if (settled || terminatingFailure !== undefined) {
        return;
      }
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      outputBytes += bytes.length;
      if (outputBytes > maximumOutputBytes) {
        terminate(
          subprocessError(
            'SUBPROCESS_OUTPUT_LIMIT',
            `Subprocess output exceeded its ${String(maximumOutputBytes)} byte safety limit: ${executable}`,
          ),
        );
        return;
      }
      chunks.push(bytes);
    };

    function onStdout(chunk) {
      appendOutput(stdoutChunks, chunk);
    }

    function onStderr(chunk) {
      appendOutput(stderrChunks, chunk);
    }

    function onError(error) {
      if (terminatingFailure === undefined) {
        settle(error);
      }
    }

    function onClose(code, signal) {
      if (terminatingFailure !== undefined) {
        settle(terminatingFailure);
        return;
      }
      settle(undefined, {
        code,
        signal,
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
      });
    }

    child.stdout?.on('data', onStdout);
    child.stderr?.on('data', onStderr);
    child.on('error', onError);
    child.on('close', onClose);
    deadlineTimer = setTimeout(() => {
      terminate(
        subprocessError(
          'SUBPROCESS_TIMEOUT',
          `Subprocess timed out after ${String(timeoutMs)} ms: ${executable}`,
        ),
      );
    }, timeoutMs);
  });
}

async function run(executable, args, options = {}) {
  const result = await runBoundedCommand(executable, args, {
    ...options,
    stdio: options.stdio ?? 'inherit',
    timeoutMs: options.timeoutMs ?? DEFAULT_SUBPROCESS_TIMEOUT_MS,
  });
  if (result.code !== 0) {
    throw new Error(
      `${executable} exited unsuccessfully (${result.code === null ? `signal ${result.signal}` : `code ${String(result.code)}`}).`,
    );
  }
}

async function capture(executable, args) {
  const result = await runBoundedCommand(executable, args, {
    maximumOutputBytes: VERSION_OUTPUT_LIMIT_BYTES,
    stdio: ['ignore', 'pipe', 'inherit'],
    timeoutMs: VERSION_PROBE_TIMEOUT_MS,
  });
  if (result.code !== 0) {
    throw new Error(
      `${executable} exited unsuccessfully (${result.code === null ? `signal ${result.signal}` : `code ${String(result.code)}`}).`,
    );
  }
  return result.stdout.trim();
}

async function sha256(targetPath) {
  const hash = createHash('sha256');
  await pipeline(createReadStream(targetPath), hash);
  return hash.digest('hex');
}

export function runtimePaths() {
  const artifact = selectedArtifact();
  const runtimeRoot = path.join(CACHE_ROOT, artifact.archive.replace(/\.tar\.(?:gz|xz)$/u, ''));
  return Object.freeze({
    artifact,
    binDirectory: path.join(runtimeRoot, 'bin'),
    node: path.join(runtimeRoot, 'bin', 'node'),
    npmCli: path.join(runtimeRoot, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    runtimeRoot,
  });
}

export async function verifyPinnedRuntime() {
  const paths = runtimePaths();
  for (const targetPath of [paths.runtimeRoot, paths.node, paths.npmCli]) {
    assertInsideRepository(targetPath);
    const metadata = await fs.lstat(targetPath);
    if (metadata.isSymbolicLink()) {
      throw new Error(`Pinned runtime path may not be a symbolic link: ${targetPath}`);
    }
  }
  const nodeVersion = await capture(paths.node, ['--version']);
  const npmVersion = await capture(paths.node, [paths.npmCli, '--version']);
  if (nodeVersion !== `v${PINNED_NODE_VERSION}` || npmVersion !== PINNED_NPM_VERSION) {
    throw new Error(
      `Pinned runtime identity mismatch: received Node ${nodeVersion}, npm ${npmVersion}.`,
    );
  }
  return paths;
}

export async function provisionPinnedRuntime() {
  try {
    return await verifyPinnedRuntime();
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw error;
    }
  }

  await ensureDirectory(DEV_ROOT);
  await ensureDirectory(CACHE_ROOT);
  await ensureDirectory(TEMPORARY_ROOT);
  const paths = runtimePaths();
  const archivePath = path.join(TEMPORARY_ROOT, `${randomUUID()}-${paths.artifact.archive}`);
  assertInsideRepository(archivePath);
  const url = `https://nodejs.org/dist/v${PINNED_NODE_VERSION}/${paths.artifact.archive}`;
  process.stdout.write(`[bootstrap] Downloading ${url}\n`);
  const response = await fetch(url, {
    redirect: 'error',
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok || response.body === null) {
    throw new Error(`Pinned Node download returned HTTP ${String(response.status)}.`);
  }
  try {
    await pipeBoundedResponse(
      response,
      createWriteStream(archivePath, { flags: 'wx', mode: 0o600 }),
      { label: 'Pinned Node artifact', maximumBytes: 100_000_000 },
    );
    const actualDigest = await sha256(archivePath);
    if (actualDigest !== paths.artifact.sha256) {
      throw new Error(
        `Pinned Node SHA-256 mismatch: expected ${paths.artifact.sha256}, received ${actualDigest}.`,
      );
    }
    await run('tar', [paths.artifact.tarFlag, archivePath, '-C', CACHE_ROOT], {
      timeoutMs: 2 * 60_000,
    });
  } catch (error) {
    await fs.rm(paths.runtimeRoot, { force: true, recursive: true });
    throw error;
  } finally {
    await fs.rm(archivePath, { force: true });
  }
  return verifyPinnedRuntime();
}

export async function runPinnedNpm(args, options = {}) {
  const paths = await verifyPinnedRuntime();
  const env = {
    ...process.env,
    ...options.env,
    NPM_CONFIG_ENGINE_STRICT: 'true',
    PATH: `${paths.binDirectory}${path.delimiter}${process.env.PATH ?? ''}`,
  };
  const runOptions = { ...options };
  delete runOptions.env;
  await run(paths.node, [paths.npmCli, ...args], {
    ...runOptions,
    env,
    timeoutMs: runOptions.timeoutMs ?? DEFAULT_SUBPROCESS_TIMEOUT_MS,
  });
}

export async function runPinnedNode(args, options = {}) {
  const paths = await verifyPinnedRuntime();
  const env = {
    ...process.env,
    ...options.env,
    NPM_CONFIG_ENGINE_STRICT: 'true',
    PATH: `${paths.binDirectory}${path.delimiter}${process.env.PATH ?? ''}`,
  };
  const runOptions = { ...options };
  delete runOptions.env;
  await run(paths.node, args, {
    ...runOptions,
    env,
    timeoutMs: runOptions.timeoutMs ?? DEFAULT_SUBPROCESS_TIMEOUT_MS,
  });
}

export { REPOSITORY_ROOT };
