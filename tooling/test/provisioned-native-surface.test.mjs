import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { DEV_PATHS } from '../dev/constants.mjs';
import {
  assertExactProvisionedSurface,
  assertRequiredExecutables,
  installCompiledBinary,
} from '../ci/provision-native.mjs';

const REDIS_ADMITTED_SURFACE = Object.freeze([
  path.join('bin', 'redis-cli'),
  path.join('bin', 'redis-server'),
]);
const temporaryRoots = [];

async function createProvisionedTree(relativePaths) {
  const root = path.join(DEV_PATHS.tmp, `provisioned-${randomUUID()}`);
  temporaryRoots.push(root);
  for (const relativePath of relativePaths) {
    const target = path.join(root, relativePath);
    await fs.mkdir(path.dirname(target), { mode: 0o700, recursive: true });
    await fs.writeFile(target, 'compiled-artifact-placeholder', { mode: 0o755 });
  }
  await fs.mkdir(root, { mode: 0o700, recursive: true });
  return root;
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => fs.rm(root, { force: true, recursive: true })),
  );
});

describe('provisioned native surface', () => {
  it('admits exactly the Redis server and client the runtime contract declares', async () => {
    const root = await createProvisionedTree(REDIS_ADMITTED_SURFACE);

    await expect(
      assertExactProvisionedSurface(root, REDIS_ADMITTED_SURFACE),
    ).resolves.toBeUndefined();
  });

  it('refuses a provisioned loadable Redis module', async () => {
    // Redis 8's default goal builds every bundled module. If a future release
    // reintroduces one into this tree, the surface assertion must fail rather
    // than silently widen what CI provisions onto PATH.
    const root = await createProvisionedTree([
      ...REDIS_ADMITTED_SURFACE,
      path.join('lib', 'redis', 'modules', 'redisearch.so'),
    ]);

    await expect(assertExactProvisionedSurface(root, REDIS_ADMITTED_SURFACE)).rejects.toThrow(
      /Provisioned native surface drifted/u,
    );
  });

  it('refuses an extra provisioned executable that the runtime contract never admitted', async () => {
    const root = await createProvisionedTree([
      ...REDIS_ADMITTED_SURFACE,
      path.join('bin', 'redis-sentinel'),
    ]);

    await expect(assertExactProvisionedSurface(root, REDIS_ADMITTED_SURFACE)).rejects.toThrow(
      /redis-sentinel/u,
    );
  });

  it('refuses a provisioned tree missing an admitted binary', async () => {
    const root = await createProvisionedTree([path.join('bin', 'redis-server')]);

    await expect(assertExactProvisionedSurface(root, REDIS_ADMITTED_SURFACE)).rejects.toThrow(
      /Provisioned native surface drifted/u,
    );
  });

  it('names every executable the dev contract requires but the tree lacks', async () => {
    const root = await createProvisionedTree([
      path.join('bin', 'postgres'),
      path.join('bin', 'psql'),
    ]);

    await expect(
      assertRequiredExecutables(root, ['createdb', 'initdb', 'pg_isready', 'postgres', 'psql']),
    ).rejects.toThrow(/createdb, initdb, pg_isready/u);
  });

  it('accepts a tree that holds every required executable', async () => {
    const root = await createProvisionedTree([
      path.join('bin', 'createdb'),
      path.join('bin', 'initdb'),
      path.join('bin', 'pg_isready'),
      path.join('bin', 'postgres'),
      path.join('bin', 'psql'),
    ]);

    await expect(
      assertRequiredExecutables(root, ['createdb', 'initdb', 'pg_isready', 'postgres', 'psql']),
    ).resolves.toBeUndefined();
  });

  it('installs a compiled binary as an executable regular file', async () => {
    const sourceRoot = await createProvisionedTree([path.join('src', 'redis-server')]);
    const destinationRoot = path.join(DEV_PATHS.tmp, `install-${randomUUID()}`);
    temporaryRoots.push(destinationRoot);
    await fs.mkdir(path.join(destinationRoot, 'bin'), { mode: 0o700, recursive: true });
    const destination = path.join(destinationRoot, 'bin', 'redis-server');

    await installCompiledBinary(path.join(sourceRoot, 'src', 'redis-server'), destination);

    const metadata = await fs.lstat(destination);
    expect(metadata.isFile()).toBe(true);
    expect(metadata.isSymbolicLink()).toBe(false);
    expect(metadata.mode & 0o777).toBe(0o755);
  });

  it('refuses to install a symlinked build artifact', async () => {
    const sourceRoot = await createProvisionedTree([path.join('src', 'redis-server')]);
    const linkPath = path.join(sourceRoot, 'src', 'redis-server-link');
    await fs.symlink(path.join(sourceRoot, 'src', 'redis-server'), linkPath);
    const destination = path.join(sourceRoot, 'bin-redis-server');

    await expect(installCompiledBinary(linkPath, destination)).rejects.toThrow(
      /regular non-symlink file/u,
    );
  });

  it('refuses to install outside this repository', async () => {
    const sourceRoot = await createProvisionedTree([path.join('src', 'redis-server')]);

    await expect(
      installCompiledBinary(path.join(sourceRoot, 'src', 'redis-server'), '/tmp/redis-server'),
    ).rejects.toThrow(/outside the repository/u);
  });
});
