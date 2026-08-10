import fs from 'node:fs/promises';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEV_PATHS } from '../constants.mjs';
import {
  ensureDevTree,
  ensureDirectory,
  ensureSecretFile,
  readCanonicalDevSecretFile,
} from '../filesystem.mjs';

const SECRET = 'a'.repeat(43);
let testRoot;

describe('canonical development secret reader', () => {
  beforeEach(async () => {
    testRoot = await fs.mkdtemp(path.join(DEV_PATHS.tmp, 'secret-reader-test-'));
  });

  afterEach(async () => {
    if (testRoot !== undefined) {
      await fs.rm(testRoot, { force: true, recursive: true });
    }
  });

  it('reads a bounded mode-0600 canonical regular file', async () => {
    const secretPath = path.join(testRoot, 'secret');
    await fs.writeFile(secretPath, `${SECRET}\n`, { mode: 0o600 });

    await expect(readCanonicalDevSecretFile(secretPath)).resolves.toBe(SECRET);
  });

  it('continues bounded reads until the validated regular-file size is complete', async () => {
    const secretPath = path.join(testRoot, 'short-read-secret');
    const contents = Buffer.from(`${SECRET}\n`);
    await fs.writeFile(secretPath, contents, { mode: 0o600 });
    const metadata = await fs.lstat(secretPath);
    let readCalls = 0;
    const open = vi.spyOn(fs, 'open').mockResolvedValue({
      close: async () => {},
      read: async (buffer, offset, length, position) => {
        if (position >= contents.length) {
          return { buffer, bytesRead: 0 };
        }
        const bytesRead = Math.min(7, length, contents.length - position);
        contents.copy(buffer, offset, position, position + bytesRead);
        readCalls += 1;
        return { buffer, bytesRead };
      },
      stat: async () => metadata,
    });

    try {
      await expect(readCanonicalDevSecretFile(secretPath)).resolves.toBe(SECRET);
      expect(readCalls).toBeGreaterThan(1);
    } finally {
      open.mockRestore();
    }
  });

  it('refuses a symbolic-link file before opening it', async () => {
    const targetPath = path.join(testRoot, 'target');
    const linkPath = path.join(testRoot, 'link');
    await fs.writeFile(targetPath, `${SECRET}\n`, { mode: 0o600 });
    await fs.symlink(targetPath, linkPath);

    await expect(readCanonicalDevSecretFile(linkPath)).rejects.toMatchObject({
      code: 'DEV_UNSAFE_SECRET_PATH',
    });
  });

  it('refuses a redirected parent directory', async () => {
    const realDirectory = path.join(testRoot, 'real');
    const redirectedDirectory = path.join(testRoot, 'redirected');
    await fs.mkdir(realDirectory, { mode: 0o700 });
    await fs.writeFile(path.join(realDirectory, 'secret'), `${SECRET}\n`, { mode: 0o600 });
    await fs.symlink(realDirectory, redirectedDirectory);

    await expect(
      readCanonicalDevSecretFile(path.join(redirectedDirectory, 'secret')),
    ).rejects.toMatchObject({ code: 'DEV_UNSAFE_SECRET_PATH' });
  });

  it('refuses group-readable or oversized secret files', async () => {
    const groupReadable = path.join(testRoot, 'group-readable');
    const oversized = path.join(testRoot, 'oversized');
    await fs.writeFile(groupReadable, `${SECRET}\n`, { mode: 0o640 });
    await fs.chmod(groupReadable, 0o640);
    await fs.writeFile(oversized, `${'b'.repeat(64)}\n`, { mode: 0o600 });

    await expect(readCanonicalDevSecretFile(groupReadable)).rejects.toMatchObject({
      code: 'DEV_UNSAFE_SECRET_PERMISSIONS',
    });
    await expect(readCanonicalDevSecretFile(oversized, { maximumBytes: 44 })).rejects.toMatchObject(
      { code: 'DEV_INVALID_SECRET' },
    );
  });
});

describe('repository-local development directory layout', () => {
  it('materializes every required non-data runtime directory as a real directory', async () => {
    await ensureDevTree();
    const requiredDirectories = [
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
    ];

    for (const directory of requiredDirectories) {
      const metadata = await fs.lstat(directory);
      expect(metadata.isDirectory()).toBe(true);
      expect(metadata.isSymbolicLink()).toBe(false);
    }
  });

  it('accepts only a validated winner when fresh directory creation races', async () => {
    const parent = await fs.mkdtemp(path.join(DEV_PATHS.tmp, 'parallel-directory-test-'));
    const target = path.join(parent, 'winner');
    try {
      await expect(
        Promise.all(Array.from({ length: 16 }, () => ensureDirectory(target))),
      ).resolves.toHaveLength(16);
      const metadata = await fs.lstat(target);
      expect(metadata.isDirectory()).toBe(true);
      expect(metadata.isSymbolicLink()).toBe(false);
    } finally {
      await fs.rm(parent, { force: true, recursive: true });
    }
  });

  it('accepts one canonical mode-0600 secret winner under concurrent preflights', async () => {
    const parent = await fs.mkdtemp(path.join(DEV_PATHS.tmp, 'parallel-secret-test-'));
    const target = path.join(parent, 'secret');
    try {
      const values = await Promise.all(Array.from({ length: 16 }, () => ensureSecretFile(target)));
      expect(new Set(values).size).toBe(1);
      expect(values[0]).toMatch(/^[A-Za-z0-9_-]{43}$/u);
      const metadata = await fs.lstat(target);
      expect(metadata.mode & 0o077).toBe(0);
    } finally {
      await fs.rm(parent, { force: true, recursive: true });
    }
  });

  it('never publishes a partial secret while a concurrent writer is delayed', async () => {
    const parent = await fs.mkdtemp(path.join(DEV_PATHS.tmp, 'atomic-secret-test-'));
    const target = path.join(parent, 'secret');
    const originalWriteFile = fs.writeFile.bind(fs);
    let delayed = false;
    let releaseWriter;
    let reportTemporaryCreated;
    const writerReleased = new Promise((resolve) => {
      releaseWriter = resolve;
    });
    const temporaryCreated = new Promise((resolve) => {
      reportTemporaryCreated = resolve;
    });
    const writeFile = vi.spyOn(fs, 'writeFile').mockImplementation(async (file, data, options) => {
      if (!delayed && String(file).startsWith(`${target}.`) && String(file).endsWith('.tmp')) {
        delayed = true;
        await originalWriteFile(file, '', options);
        reportTemporaryCreated();
        await writerReleased;
        await originalWriteFile(file, data, { ...options, flag: 'w' });
        return;
      }
      await originalWriteFile(file, data, options);
    });

    try {
      const delayedWriter = ensureSecretFile(target);
      await temporaryCreated;
      await expect(fs.lstat(target)).rejects.toMatchObject({ code: 'ENOENT' });
      const winningValue = await ensureSecretFile(target);
      releaseWriter();
      await expect(delayedWriter).resolves.toBe(winningValue);
      await expect(readCanonicalDevSecretFile(target)).resolves.toBe(winningValue);
    } finally {
      releaseWriter();
      writeFile.mockRestore();
      await fs.rm(parent, { force: true, recursive: true });
    }
  });
});
