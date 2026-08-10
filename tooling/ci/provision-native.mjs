import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

import { REPOSITORY_ROOT, runBoundedCommand } from '../pinned-runtime.mjs';
import { pipeBoundedResponse } from '../bounded-download.mjs';

const DEV_ROOT = path.join(REPOSITORY_ROOT, '.dev');
const CACHE_ROOT = path.join(DEV_ROOT, 'cache');
const NATIVE_ROOT = path.join(CACHE_ROOT, 'ci-native');
const TEMPORARY_ROOT = path.join(DEV_ROOT, 'tmp');
const POSTGRES_ROOT = path.join(NATIVE_ROOT, 'postgresql-16.14');
const REDIS_ROOT = path.join(NATIVE_ROOT, 'redis-8.10.0');
const TOOLCHAIN_REGISTER_PATH = path.join(
  REPOSITORY_ROOT,
  'tooling',
  'ci',
  'native-toolchain.json',
);
const COMMAND_TIMEOUT_MS = 15 * 60_000;
const CAPTURE_TIMEOUT_MS = 60_000;
const EXPECTED_BUILD_COMMANDS = Object.freeze([
  Object.freeze({ name: 'ar', versionArguments: Object.freeze(['--version']) }),
  Object.freeze({ name: 'cc', versionArguments: Object.freeze(['--version']) }),
  Object.freeze({ name: 'make', versionArguments: Object.freeze(['--version']) }),
  Object.freeze({ name: 'perl', versionArguments: Object.freeze(['--version']) }),
  Object.freeze({ name: 'ranlib', versionArguments: Object.freeze(['--version']) }),
  Object.freeze({ name: 'tar', versionArguments: Object.freeze(['--version']) }),
]);

function nativeBuildEnvironment() {
  const environment = {
    AR: 'ar',
    CC: 'cc',
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    MAKE: 'make',
    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    RANLIB: 'ranlib',
    TZ: 'UTC',
  };
  for (const name of ['HOME', 'TMPDIR']) {
    if (typeof process.env[name] === 'string') {
      environment[name] = process.env[name];
    }
  }
  return environment;
}

const ARTIFACTS = Object.freeze({
  postgres: Object.freeze({
    archive: 'postgresql-16.14.tar.bz2',
    maximumBytes: 30_000_000,
    sha256: 'f6d077142737920858ce958ccdb75c6ee137a63b5b0853c70693d401ac7e3471',
    sourceDirectory: 'postgresql-16.14',
    tarArguments: ['-xjf'],
    url: 'https://ftp.postgresql.org/pub/source/v16.14/postgresql-16.14.tar.bz2',
  }),
  redis: Object.freeze({
    archive: 'redis-8.10.0.tar.gz',
    maximumBytes: 25_000_000,
    sha256: 'f1baa4b28befd417aa6577ebeedde9e9fc7814cfcc299b2a6d2fd99ef7420a6c',
    sourceDirectory: 'redis-8.10.0',
    tarArguments: ['-xzf'],
    url: 'https://download.redis.io/releases/redis-8.10.0.tar.gz',
  }),
});

function assertInsideRepository(targetPath) {
  const relative = path.relative(REPOSITORY_ROOT, path.resolve(targetPath));
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Refusing a CI-native path outside the repository: ${targetPath}`);
  }
}

async function ensureRealDirectory(targetPath) {
  assertInsideRepository(targetPath);
  try {
    const metadata = await fs.lstat(targetPath);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error(`CI-native path must be a real directory: ${targetPath}`);
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw error;
    }
    await fs.mkdir(targetPath, { mode: 0o700 });
  }
}

async function initializeDirectories() {
  for (const targetPath of [DEV_ROOT, CACHE_ROOT, NATIVE_ROOT, TEMPORARY_ROOT]) {
    await ensureRealDirectory(targetPath);
  }
}

async function run(executable, args, options = {}) {
  const result = await runBoundedCommand(executable, args, {
    cwd: options.cwd ?? REPOSITORY_ROOT,
    // Do not inherit CC/CFLAGS/CPPFLAGS/LDFLAGS/MAKEFLAGS/CONFIG_SITE or
    // other ambient build selectors. Source identity is exact; the runner
    // toolchain remains observed rather than claimed bit-reproducible.
    env: nativeBuildEnvironment(),
    stdio: 'inherit',
    timeoutMs: options.timeoutMs ?? COMMAND_TIMEOUT_MS,
  });
  if (result.code !== 0) {
    throw new Error(
      `${executable} failed (${result.code === null ? `signal ${result.signal}` : `code ${String(result.code)}`}).`,
    );
  }
}

async function capture(executable, args, options = {}) {
  const result = await runBoundedCommand(executable, args, {
    cwd: options.cwd ?? REPOSITORY_ROOT,
    env: nativeBuildEnvironment(),
    maximumOutputBytes: options.maximumBytes ?? 64 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeoutMs: options.timeoutMs ?? CAPTURE_TIMEOUT_MS,
  });
  if (result.code !== 0) {
    throw new Error(
      `${executable} version probe failed (${result.code === null ? `signal ${result.signal}` : `code ${String(result.code)}`}).`,
    );
  }
  return `${result.stdout}${result.stderr}`.trim();
}

async function validateArchiveMembers(artifact, archivePath) {
  const listing = await capture('tar', ['-tf', archivePath], {
    maximumBytes: 8 * 1024 * 1024,
  });
  const members = listing.split(/\r?\n/u).filter((member) => member !== '');
  if (members.length === 0) {
    throw new Error(`Native source archive is empty: ${artifact.archive}`);
  }
  for (const member of members) {
    const components = member.split('/').filter((component) => component !== '');
    if (
      member.startsWith('/') ||
      components.includes('..') ||
      components[0] !== artifact.sourceDirectory
    ) {
      throw new Error(`Native source archive contains an unsafe member path: ${member}`);
    }
  }
}

async function verifyBuildToolchain() {
  const metadata = await fs.lstat(TOOLCHAIN_REGISTER_PATH);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 64 * 1024) {
    throw new Error(
      `Native build-toolchain register must be a bounded regular file: ${TOOLCHAIN_REGISTER_PATH}`,
    );
  }
  const register = JSON.parse(await fs.readFile(TOOLCHAIN_REGISTER_PATH, 'utf8'));
  if (
    register?.schemaVersion !== 1 ||
    register.target !== 'linux-x64 on the GitHub-hosted ubuntu-24.04 runner' ||
    typeof register.claimBoundary !== 'string' ||
    register.claimBoundary.length === 0 ||
    register.claimBoundary.length > 1_024 ||
    !/^[\x20-\x7E]+$/u.test(register.claimBoundary) ||
    !Array.isArray(register.requiredCommands) ||
    register.requiredCommands.length === 0
  ) {
    throw new Error('Native build-toolchain register does not match schema version 1.');
  }

  if (JSON.stringify(register.requiredCommands) !== JSON.stringify(EXPECTED_BUILD_COMMANDS)) {
    throw new Error('Native build-toolchain commands drifted from the executable allowlist.');
  }

  const observedNames = new Set();
  for (const row of register.requiredCommands) {
    if (
      typeof row?.name !== 'string' ||
      row.name.length === 0 ||
      observedNames.has(row.name) ||
      !Array.isArray(row.versionArguments) ||
      !row.versionArguments.every((argument) => typeof argument === 'string')
    ) {
      throw new Error('Native build-toolchain register contains an invalid command row.');
    }
    observedNames.add(row.name);
    const versionOutput = await capture(row.name, row.versionArguments);
    const identity = versionOutput
      .split(/\r?\n/u)
      .find((line) => line.trim() !== '')
      ?.replaceAll(/[^\x20-\x7E]/gu, '?');
    if (identity === undefined) {
      throw new Error(`Native build-toolchain command returned no identity: ${row.name}`);
    }
    process.stdout.write(`[ci-native] TOOL ${row.name} identity=${identity}\n`);
  }
  process.stdout.write(`[ci-native] CLAIM_BOUNDARY ${register.claimBoundary}\n`);
}

async function sha256(targetPath) {
  const hash = createHash('sha256');
  await pipeline(createReadStream(targetPath), hash);
  return hash.digest('hex');
}

async function download(artifact, destination) {
  const response = await fetch(artifact.url, {
    redirect: 'error',
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok || response.body === null) {
    throw new Error(
      `Native source download returned HTTP ${String(response.status)}: ${artifact.url}`,
    );
  }
  const receivedBytes = await pipeBoundedResponse(
    response,
    createWriteStream(destination, { flags: 'wx', mode: 0o600 }),
    { label: `Native source ${artifact.url}`, maximumBytes: artifact.maximumBytes },
  );
  const metadata = await fs.lstat(destination);
  if (metadata.size !== receivedBytes) {
    throw new Error(
      `Native source length mismatch after write: streamed ${String(receivedBytes)}, stored ${String(metadata.size)}.`,
    );
  }
  const actualDigest = await sha256(destination);
  if (actualDigest !== artifact.sha256) {
    throw new Error(
      `Native source SHA-256 mismatch: expected ${artifact.sha256}, received ${actualDigest}.`,
    );
  }
}

async function executableMatches(executable, args, expectedPattern) {
  try {
    const metadata = await fs.lstat(executable);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      return false;
    }
    return expectedPattern.test(await capture(executable, args));
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

export function redisServerVersionOutputMatches(output) {
  return /^Redis server v=8\.10\.0(?=\s|$)/u.test(output);
}

export function redisCliVersionOutputMatches(output) {
  return /^redis-cli 8\.10\.0(?=\s|$)/u.test(output);
}

async function withExtractedSource(artifact, operation) {
  const operationRoot = path.join(TEMPORARY_ROOT, `native-${randomUUID()}`);
  assertInsideRepository(operationRoot);
  await fs.mkdir(operationRoot, { mode: 0o700 });
  const archivePath = path.join(operationRoot, artifact.archive);
  try {
    await download(artifact, archivePath);
    await validateArchiveMembers(artifact, archivePath);
    await run('tar', [...artifact.tarArguments, archivePath, '-C', operationRoot]);
    const sourceRoot = path.join(operationRoot, artifact.sourceDirectory);
    const sourceMetadata = await fs.lstat(sourceRoot);
    if (!sourceMetadata.isDirectory() || sourceMetadata.isSymbolicLink()) {
      throw new Error(`Extracted native source is not a real directory: ${sourceRoot}`);
    }
    await operation(sourceRoot);
  } finally {
    await fs.rm(operationRoot, { force: true, recursive: true });
  }
}

async function provisionPostgres() {
  const postgres = path.join(POSTGRES_ROOT, 'bin', 'postgres');
  if (await executableMatches(postgres, ['--version'], /PostgreSQL\) 16\.14$/u)) {
    process.stdout.write('[ci-native] PASS cached PostgreSQL 16.14.\n');
    return;
  }
  await fs.rm(POSTGRES_ROOT, { force: true, recursive: true });
  try {
    await withExtractedSource(ARTIFACTS.postgres, async (sourceRoot) => {
      await run(
        path.join(sourceRoot, 'configure'),
        [`--prefix=${POSTGRES_ROOT}`, '--without-icu', '--without-readline', '--without-zlib'],
        { cwd: sourceRoot },
      );
      await run('make', ['-j2'], { cwd: sourceRoot });
      await run('make', ['install'], { cwd: sourceRoot });
    });
  } catch (error) {
    await fs.rm(POSTGRES_ROOT, { force: true, recursive: true });
    throw error;
  }
  if (!(await executableMatches(postgres, ['--version'], /PostgreSQL\) 16\.14$/u))) {
    throw new Error('Compiled PostgreSQL did not report the required version 16.14.');
  }
  process.stdout.write('[ci-native] PASS compiled PostgreSQL 16.14 from verified source.\n');
}

async function provisionRedis() {
  const redisServer = path.join(REDIS_ROOT, 'bin', 'redis-server');
  const redisCli = path.join(REDIS_ROOT, 'bin', 'redis-cli');
  if (
    (await executableMatches(redisServer, ['--version'], {
      test: redisServerVersionOutputMatches,
    })) &&
    (await executableMatches(redisCli, ['--version'], { test: redisCliVersionOutputMatches }))
  ) {
    process.stdout.write('[ci-native] PASS cached Redis 8.10.0.\n');
    return;
  }
  await fs.rm(REDIS_ROOT, { force: true, recursive: true });
  try {
    await withExtractedSource(ARTIFACTS.redis, async (sourceRoot) => {
      await run('make', ['-j2', 'BUILD_TLS=no', 'MALLOC=libc'], { cwd: sourceRoot });
      await run('make', ['-j2', 'BUILD_TLS=no', 'MALLOC=libc', `PREFIX=${REDIS_ROOT}`, 'install'], {
        cwd: sourceRoot,
      });
    });
  } catch (error) {
    await fs.rm(REDIS_ROOT, { force: true, recursive: true });
    throw error;
  }
  if (
    !(await executableMatches(redisServer, ['--version'], {
      test: redisServerVersionOutputMatches,
    })) ||
    !(await executableMatches(redisCli, ['--version'], { test: redisCliVersionOutputMatches }))
  ) {
    throw new Error('Compiled Redis binaries did not both report the required version 8.10.0.');
  }
  process.stdout.write('[ci-native] PASS compiled Redis 8.10.0 from verified source.\n');
}

async function main() {
  if (process.platform !== 'linux' || process.arch !== 'x64') {
    throw new Error(
      `CI native-source provisioning is pinned to linux-x64; received ${process.platform}-${process.arch}.`,
    );
  }

  await initializeDirectories();
  await verifyBuildToolchain();
  await provisionPostgres();
  await provisionRedis();
  process.stdout.write(`[ci-native] PATH_POSTGRES=${path.join(POSTGRES_ROOT, 'bin')}\n`);
  process.stdout.write(`[ci-native] PATH_REDIS=${path.join(REDIS_ROOT, 'bin')}\n`);
  process.stdout.write(
    '[ci-native] Scope: exact-version SHA-256-verified source inputs; runner-specific compiled binaries are not claimed reproducible, deployable, or production-ready.\n',
  );
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
) {
  await main();
}
