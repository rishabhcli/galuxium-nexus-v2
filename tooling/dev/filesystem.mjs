import crypto from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

import { DEV_PATHS, REPOSITORY_ROOT } from './constants.mjs';
import { DevContractError } from './errors.mjs';

const REQUIRED_DIRECTORIES = Object.freeze([
  DEV_PATHS.root,
  DEV_PATHS.cache,
  DEV_PATHS.logs,
  DEV_PATHS.pids,
  DEV_PATHS.playwrightProfile,
  DEV_PATHS.postgres,
  DEV_PATHS.postgresSocket,
  DEV_PATHS.redis,
  DEV_PATHS.secrets,
  DEV_PATHS.tmp,
]);

export function assertInsideRepository(targetPath) {
  const relative = path.relative(REPOSITORY_ROOT, path.resolve(targetPath));
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new DevContractError(
      'DEV_PATH_OUTSIDE_REPOSITORY',
      `Refusing to use path outside the repository: ${targetPath}`,
    );
  }
}

async function validateDirectory(targetPath) {
  const existing = await fs.lstat(targetPath);
  if (existing.isSymbolicLink() || !existing.isDirectory()) {
    throw new DevContractError(
      'DEV_UNSAFE_PATH',
      `Expected a real directory, not a symlink or file: ${targetPath}`,
    );
  }
}

export async function ensureDirectory(targetPath) {
  assertInsideRepository(targetPath);
  try {
    await validateDirectory(targetPath);
    return;
  } catch (error) {
    if (error instanceof DevContractError || error?.code !== 'ENOENT') {
      throw error;
    }
  }

  try {
    await fs.mkdir(targetPath, { mode: 0o700, recursive: false });
  } catch (error) {
    if (error?.code !== 'EEXIST') {
      throw error;
    }
  }
  // A concurrent repository preflight may have created the same path. Accept
  // that winner only after repeating the complete non-symlink directory check.
  await validateDirectory(targetPath);
}

export async function ensureDevTree() {
  for (const directory of REQUIRED_DIRECTORIES) {
    await ensureDirectory(directory);
  }

  const resolvedRoot = await fs.realpath(DEV_PATHS.root);
  assertInsideRepository(resolvedRoot);
  return resolvedRoot;
}

export async function ensureSecretFile(secretPath) {
  assertInsideRepository(secretPath);
  try {
    return await readCanonicalDevSecretFile(secretPath);
  } catch (error) {
    if (error instanceof DevContractError) {
      throw error;
    }
    if (error?.code !== 'ENOENT') {
      throw error;
    }
  }

  const value = crypto.randomBytes(32).toString('base64url');
  const temporaryPath = `${secretPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    // Fully materialize a private same-directory inode before publishing it.
    // link(2) is the no-overwrite commit point: a concurrent winner is visible
    // only after its complete contents exist, never at size zero or mid-write.
    await fs.writeFile(temporaryPath, `${value}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    await fs.link(temporaryPath, secretPath);
  } catch (error) {
    if (error?.code !== 'EEXIST') {
      throw error;
    }
  } finally {
    await fs.rm(temporaryPath, { force: true });
  }
  // A concurrent preflight may have won the exclusive create. Never overwrite
  // it; validate and return the exact canonical file that now exists.
  return readCanonicalDevSecretFile(secretPath);
}

export async function readCanonicalDevSecretFile(secretPath, { maximumBytes = 4_096 } = {}) {
  assertInsideRepository(secretPath);
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    throw new DevContractError('DEV_INVALID_SECRET_LIMIT', 'Secret file limit must be positive.');
  }

  const metadata = await fs.lstat(secretPath);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new DevContractError(
      'DEV_UNSAFE_SECRET_PATH',
      `Expected a non-symlink regular secret file: ${secretPath}`,
    );
  }
  if (metadata.size < 1 || metadata.size > maximumBytes) {
    throw new DevContractError(
      'DEV_INVALID_SECRET',
      `The local PostgreSQL secret file has an invalid size: ${secretPath}`,
    );
  }
  if ((metadata.mode & 0o077) !== 0) {
    throw new DevContractError(
      'DEV_UNSAFE_SECRET_PERMISSIONS',
      `The local PostgreSQL secret must deny group and other access: ${secretPath}`,
    );
  }
  if ((await fs.realpath(secretPath)) !== secretPath) {
    throw new DevContractError(
      'DEV_UNSAFE_SECRET_PATH',
      `The local PostgreSQL secret path is redirected: ${secretPath}`,
    );
  }

  const handle = await fs.open(secretPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.dev !== metadata.dev ||
      opened.ino !== metadata.ino ||
      opened.size < 1 ||
      opened.size > maximumBytes ||
      (opened.mode & 0o077) !== 0
    ) {
      throw new DevContractError(
        'DEV_SECRET_REPLACED',
        `The local PostgreSQL secret changed during validation: ${secretPath}`,
      );
    }
    const buffer = Buffer.alloc(maximumBytes + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.byteLength) {
      const result = await handle.read(buffer, bytesRead, buffer.byteLength - bytesRead, bytesRead);
      if (result.bytesRead === 0) {
        break;
      }
      bytesRead += result.bytesRead;
    }
    const finalMetadata = await handle.stat();
    if (
      !finalMetadata.isFile() ||
      finalMetadata.dev !== opened.dev ||
      finalMetadata.ino !== opened.ino ||
      finalMetadata.size !== opened.size ||
      (finalMetadata.mode & 0o077) !== 0 ||
      bytesRead !== opened.size
    ) {
      throw new DevContractError(
        'DEV_SECRET_REPLACED',
        `The local PostgreSQL secret changed while it was being read: ${secretPath}`,
      );
    }
    if (bytesRead < 1 || bytesRead > maximumBytes) {
      throw new DevContractError(
        'DEV_INVALID_SECRET',
        `The local PostgreSQL secret file has an invalid size: ${secretPath}`,
      );
    }
    const value = buffer.subarray(0, bytesRead).toString('utf8').trim();
    if (!/^[A-Za-z0-9_-]{43}$/.test(value)) {
      throw new DevContractError(
        'DEV_INVALID_SECRET',
        `The local PostgreSQL secret has an invalid format: ${secretPath}`,
      );
    }
    return value;
  } finally {
    await handle.close();
  }
}

export async function atomicWrite(targetPath, contents, mode = 0o600) {
  assertInsideRepository(targetPath);
  const temporaryPath = `${targetPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temporaryPath, contents, {
    encoding: 'utf8',
    flag: 'wx',
    mode,
  });
  await fs.rename(temporaryPath, targetPath);
}

export async function assertRegularFileInsideRepository(targetPath) {
  assertInsideRepository(targetPath);
  let metadata;
  try {
    metadata = await fs.lstat(targetPath);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new DevContractError(
        'DEV_BUILD_ARTIFACT_MISSING',
        `Required compiled service entry is missing: ${targetPath}. Run the build before dev:up.`,
      );
    }
    throw error;
  }
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new DevContractError(
      'DEV_UNSAFE_BUILD_ARTIFACT',
      `Compiled service entry must be a regular file inside the repository: ${targetPath}`,
    );
  }
}
