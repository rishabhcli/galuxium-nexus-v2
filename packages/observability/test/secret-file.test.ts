import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { readCanonicalSecretFile, repositoryRootFromServiceModule } from '../src/secret-file.js';

async function withTemporaryDirectory<T>(run: (directory: string) => Promise<T>): Promise<T> {
  const temporaryRoot = join(process.cwd(), '.dev', 'tmp');
  await mkdir(temporaryRoot, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(temporaryRoot, 'secret-file-test-'));
  try {
    return await run(directory);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

describe('readCanonicalSecretFile', () => {
  it('reads a bounded mode-0600 secret only from its exact canonical path', async () => {
    await withTemporaryDirectory(async (directory) => {
      const path = join(directory, 'postgres-password');
      await writeFile(path, 'bounded-secret\n', { encoding: 'utf8', mode: 0o600 });

      await expect(readCanonicalSecretFile({ expectedPath: path, path })).resolves.toBe(
        'bounded-secret',
      );
      await expect(
        readCanonicalSecretFile({
          expectedPath: path,
          path: join(directory, '.', 'postgres-password'),
        }),
      ).resolves.toBe('bounded-secret');
      await expect(
        readCanonicalSecretFile({ expectedPath: path, path: `${path}-different` }),
      ).rejects.toMatchObject({ code: 'SECRET_FILE_NOT_CANONICAL' });
    });
  });

  it('refuses symlinks, permissive modes, empty files, and oversized files', async () => {
    await withTemporaryDirectory(async (directory) => {
      const target = join(directory, 'target');
      const link = join(directory, 'link');
      const permissive = join(directory, 'permissive');
      const empty = join(directory, 'empty');
      const oversized = join(directory, 'oversized');
      await writeFile(target, 'secret', { mode: 0o600 });
      await symlink(target, link);
      await writeFile(permissive, 'secret', { mode: 0o644 });
      await writeFile(empty, '', { mode: 0o600 });
      await writeFile(oversized, 'x'.repeat(17), { mode: 0o600 });

      await expect(
        readCanonicalSecretFile({ expectedPath: link, path: link }),
      ).rejects.toMatchObject({ code: 'SECRET_FILE_TYPE' });
      await expect(
        readCanonicalSecretFile({ expectedPath: permissive, path: permissive }),
      ).rejects.toMatchObject({ code: 'SECRET_FILE_PERMISSIONS' });
      await expect(
        readCanonicalSecretFile({ expectedPath: empty, path: empty }),
      ).rejects.toMatchObject({ code: 'SECRET_FILE_SIZE' });
      await expect(
        readCanonicalSecretFile({ expectedPath: oversized, maximumBytes: 16, path: oversized }),
      ).rejects.toMatchObject({ code: 'SECRET_FILE_SIZE' });
    });
  });
});

describe('repositoryRootFromServiceModule', () => {
  it('finds the repository root from source and compiled service module locations', () => {
    const root = '/repository/galuxium-nexus-v2';
    expect(
      repositoryRootFromServiceModule(`file://${root}/services/gateway/src/server.ts`, 'gateway'),
    ).toBe(root);
    expect(
      repositoryRootFromServiceModule(
        `file://${root}/services/gateway/dist/src/server.js`,
        'gateway',
      ),
    ).toBe(root);
  });
});
