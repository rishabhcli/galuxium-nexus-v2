import fs from 'node:fs/promises';
import path from 'node:path';

import {
  REPOSITORY_ROOT,
  provisionPinnedRuntime,
  runPinnedNode,
  runPinnedNpm,
} from './pinned-runtime.mjs';

const PLAYWRIGHT_VERSION = '1.62.1';
const PLAYWRIGHT_PACKAGE_PATH = path.join(
  REPOSITORY_ROOT,
  'node_modules',
  '@playwright',
  'test',
  'package.json',
);
const PLAYWRIGHT_CLI_PATH = path.join(
  REPOSITORY_ROOT,
  'node_modules',
  '@playwright',
  'test',
  'cli.js',
);
const DEV_ROOT = path.join(REPOSITORY_ROOT, '.dev');
const CACHE_ROOT = path.join(DEV_ROOT, 'cache');
const PLAYWRIGHT_BROWSER_PATH = path.join(CACHE_ROOT, 'playwright');

function assertInsideRepository(targetPath) {
  const relative = path.relative(REPOSITORY_ROOT, path.resolve(targetPath));
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Refusing a bootstrap path outside this repository: ${targetPath}`);
  }
}

async function assertRegularFile(targetPath) {
  assertInsideRepository(targetPath);
  const metadata = await fs.lstat(targetPath);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`Bootstrap input must be a regular non-symlink file: ${targetPath}`);
  }
  const realPath = await fs.realpath(targetPath);
  assertInsideRepository(realPath);
}

async function ensureRealDirectory(targetPath) {
  assertInsideRepository(targetPath);
  try {
    const metadata = await fs.lstat(targetPath);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error(`Bootstrap path must be a real directory: ${targetPath}`);
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw error;
    }
    await fs.mkdir(targetPath, { mode: 0o700 });
  }
}

async function installPinnedChromium() {
  await Promise.all([
    assertRegularFile(PLAYWRIGHT_PACKAGE_PATH),
    assertRegularFile(PLAYWRIGHT_CLI_PATH),
  ]);
  const packageRecord = JSON.parse(await fs.readFile(PLAYWRIGHT_PACKAGE_PATH, 'utf8'));
  if (packageRecord.version !== PLAYWRIGHT_VERSION) {
    throw new Error(
      `Expected the locked local Playwright ${PLAYWRIGHT_VERSION}, received ${String(packageRecord.version)}.`,
    );
  }

  for (const targetPath of [DEV_ROOT, CACHE_ROOT, PLAYWRIGHT_BROWSER_PATH]) {
    await ensureRealDirectory(targetPath);
  }

  await runPinnedNode([PLAYWRIGHT_CLI_PATH, 'install', 'chromium'], {
    env: {
      PLAYWRIGHT_BROWSERS_PATH: PLAYWRIGHT_BROWSER_PATH,
      PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '0',
    },
  });
}

await provisionPinnedRuntime();
await runPinnedNpm(['ci', '--ignore-scripts']);
await installPinnedChromium();
process.stdout.write(
  '[bootstrap] PASS pinned runtime, immutable dependencies, and locked local Playwright Chromium installed; npm lifecycle scripts were disabled.\n',
);
process.stdout.write(
  '[bootstrap] Scope: repository-local development dependencies only; no release, deployment, or production claim is asserted.\n',
);
