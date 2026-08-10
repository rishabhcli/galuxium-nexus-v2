import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  PINNED_NODE_VERSION,
  REPOSITORY_ROOT,
  runBoundedCommand,
  verifyPinnedRuntime,
} from '../pinned-runtime.mjs';
import {
  assertEvidencePathSafetyRefusals,
  assertNoAbsoluteLocalPaths,
  normalizeEvidencePath,
  normalizeLocalRootsInText,
} from './evidence-paths.mjs';
import { assertDependencyRegisterSchemaRefusals, validateJsonSchema } from './schema-validator.mjs';

const THIS_FILE = fileURLToPath(import.meta.url);
const COMMAND = 'node tooling/dependencies/verify.mjs';
const EVIDENCE_DIRECTORY = path.join(REPOSITORY_ROOT, 'evidence', 'dependencies');
const REGISTER_PATH = path.join(REPOSITORY_ROOT, 'tooling', 'dependencies', 'register.json');
const REGISTER_SCHEMA_PATH = path.join(
  REPOSITORY_ROOT,
  'tooling',
  'dependencies',
  'register.schema.json',
);
const SCHEMA_VALIDATOR_PATH = path.join(
  REPOSITORY_ROOT,
  'tooling',
  'dependencies',
  'schema-validator.mjs',
);
const SCHEMA_VALIDATOR_TEST_PATH = path.join(
  REPOSITORY_ROOT,
  'tooling',
  'dependencies',
  'schema-validator.test.mjs',
);
const EVIDENCE_PATHS_PATH = path.join(
  REPOSITORY_ROOT,
  'tooling',
  'dependencies',
  'evidence-paths.mjs',
);
const EVIDENCE_PATHS_TEST_PATH = path.join(
  REPOSITORY_ROOT,
  'tooling',
  'dependencies',
  'evidence-paths.test.mjs',
);
const LOCK_PATH = path.join(REPOSITORY_ROOT, 'package-lock.json');
const NPM_CONFIGURATION_PATH = path.join(REPOSITORY_ROOT, '.npmrc');
const BOOTSTRAP_PATH = path.join(REPOSITORY_ROOT, 'tooling', 'bootstrap.mjs');
const BOUNDED_DOWNLOAD_PATH = path.join(REPOSITORY_ROOT, 'tooling', 'bounded-download.mjs');
const NATIVE_PROVISIONER_PATH = path.join(REPOSITORY_ROOT, 'tooling', 'ci', 'provision-native.mjs');
const NATIVE_TOOLCHAIN_PATH = path.join(REPOSITORY_ROOT, 'tooling', 'ci', 'native-toolchain.json');
const PINNED_RUNTIME_PATH = path.join(REPOSITORY_ROOT, 'tooling', 'pinned-runtime.mjs');
const SUBPROCESS_VERSION_TEST_PATH = path.join(
  REPOSITORY_ROOT,
  'tooling',
  'test',
  'subprocess-and-version.test.mjs',
);
const PLAYWRIGHT_DESCRIPTOR_PATH = path.join(
  REPOSITORY_ROOT,
  'node_modules',
  'playwright-core',
  'browsers.json',
);
const DIRECT_SECTIONS = Object.freeze([
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
]);
const INSTALL_LIFECYCLE_SCRIPTS = Object.freeze(['preinstall', 'install', 'postinstall']);
const NATIVE_EXTENSIONS = new Set(['.a', '.dll', '.dylib', '.exe', '.node', '.so', '.wasm']);
const MAX_JSON_BYTES = 8 * 1024 * 1024;
const MAX_COMMAND_OUTPUT_BYTES = 16 * 1024 * 1024;
const COMMAND_TIMEOUT_MS = 120_000;
const EXACT_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;
const SECRET_KEY_PATTERN =
  /(?:^|_)(?:auth|authorization|credential|password|secret|token)(?:$|_)/iu;
const EVIDENCE_PATH_OPTIONS = Object.freeze({
  homeDirectory: process.env.HOME ?? '',
  repositoryRoot: REPOSITORY_ROOT,
});

function compareText(left, right) {
  return left.localeCompare(right, 'en');
}

function sortedObject(value = {}) {
  return Object.fromEntries(
    Object.entries(value).sort(([left], [right]) => compareText(left, right)),
  );
}

function sortedUnique(values) {
  return [...new Set(values)].sort(compareText);
}

function toRepositoryPath(targetPath) {
  const absolutePath = path.resolve(targetPath);
  const relativePath = path.relative(REPOSITORY_ROOT, absolutePath);
  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    throw new Error(`Expected a path inside the repository: ${targetPath}`);
  }
  return relativePath === '' ? '.' : relativePath.split(path.sep).join('/');
}

async function sha256File(targetPath) {
  const contents = await fs.readFile(targetPath);
  return createHash('sha256').update(contents).digest('hex');
}

async function readJsonFile(targetPath, options = {}) {
  const metadata = await fs.lstat(targetPath);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`JSON input must be a regular non-symlink file: ${targetPath}`);
  }
  if (metadata.size <= 0 || metadata.size > (options.maximumBytes ?? MAX_JSON_BYTES)) {
    throw new Error(
      `JSON input has an unsafe size (${String(metadata.size)} bytes): ${targetPath}`,
    );
  }
  const source = await fs.readFile(targetPath, 'utf8');
  try {
    return JSON.parse(source);
  } catch {
    throw new Error(`JSON input is malformed: ${targetPath}`);
  }
}

async function pathExists(targetPath) {
  try {
    await fs.lstat(targetPath);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

async function writeJsonAtomic(targetPath, value) {
  const temporaryPath = `${targetPath}.${String(process.pid)}.tmp`;
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  await fs.writeFile(temporaryPath, serialized, { encoding: 'utf8', flag: 'wx', mode: 0o644 });
  await fs.rename(temporaryPath, targetPath);
}

function runCommand(executable, args, options = {}) {
  return runBoundedCommand(executable, args, {
    cwd: options.cwd ?? REPOSITORY_ROOT,
    env: options.env ?? process.env,
    maximumOutputBytes: options.maximumBytes ?? MAX_COMMAND_OUTPUT_BYTES,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeoutMs: options.timeoutMs ?? COMMAND_TIMEOUT_MS,
  });
}

async function runPinnedSelf() {
  const runtime = await verifyPinnedRuntime();
  const [currentExecutable, pinnedExecutable] = await Promise.all([
    fs.realpath(process.execPath),
    fs.realpath(runtime.node),
  ]);
  if (currentExecutable === pinnedExecutable && process.versions.node === PINNED_NODE_VERSION) {
    return runtime;
  }

  const result = await runCommand(runtime.node, [THIS_FILE, ...process.argv.slice(2)], {
    maximumBytes: MAX_COMMAND_OUTPUT_BYTES,
  });
  if (result.stdout !== '') {
    process.stdout.write(result.stdout);
  }
  if (result.stderr !== '') {
    process.stderr.write(result.stderr);
  }
  if (result.code !== 0) {
    throw new Error(
      `Pinned dependency verifier failed (${result.code === null ? `signal ${result.signal}` : `code ${String(result.code)}`}).`,
    );
  }
  return null;
}

function validateRegisterShape(register) {
  if (register?.schemaVersion !== 1 || !Array.isArray(register.dependencies)) {
    throw new Error('Dependency register must use schemaVersion 1 and contain dependencies.');
  }
  if (!Array.isArray(register.nativeTools) || register.nativeTools.length === 0) {
    throw new Error('Dependency register must contain native tool rows.');
  }
  if (!Array.isArray(register.managedArtifacts) || register.managedArtifacts.length === 0) {
    throw new Error('Dependency register must contain managed operational artifact rows.');
  }

  function validateExplicitReview(row, label) {
    const requiredReviewFields = [
      'license',
      'maintenance',
      'securityHistory',
      'scriptsAndNative',
      'cost',
    ];
    if (
      typeof row.review !== 'object' ||
      row.review === null ||
      requiredReviewFields.some(
        (field) =>
          typeof row.review[field] !== 'object' ||
          row.review[field] === null ||
          typeof row.review[field].status !== 'string',
      )
    ) {
      throw new Error(`${label} lacks an explicit complete Tier 0 review: ${String(row.name)}`);
    }
    if (
      row.review.maintenance.timeSensitive !== true ||
      row.review.securityHistory.timeSensitive !== true ||
      row.review.license.evidence === undefined ||
      row.review.maintenance.evidence === undefined ||
      row.review.securityHistory.evidence === undefined ||
      row.review.scriptsAndNative.evidence === undefined ||
      row.review.cost.evidence === undefined ||
      typeof row.review.cost.measured !== 'string' ||
      row.review.cost.measured.length === 0
    ) {
      throw new Error(
        `${label} must record evidence, measured local cost, and time-sensitive maintenance/security status: ${String(row.name)}`,
      );
    }
    if (
      typeof row.removalBoundary !== 'string' ||
      row.removalBoundary.length === 0 ||
      row.admissionStatus !== 'tier-0-recorded-release-admission-pending'
    ) {
      throw new Error(`${label} lacks its removal/admission boundary: ${String(row.name)}`);
    }
  }

  if (
    register.policy?.admissionStatus !== 'tier-0-recorded-release-admission-pending' ||
    !Array.isArray(register.policy.currentAuditEvidence) ||
    typeof register.policy.metadataEvidence !== 'string'
  ) {
    throw new Error('Dependency register policy must state the Tier 0/release admission boundary.');
  }

  const nativeToolNames = new Set();
  const expectedNativeProvenanceKinds = new Map([
    ['Node.js', 'node-runtime-archive'],
    ['npm CLI', 'bundled-cli'],
    ['PostgreSQL native distribution', 'source-built-native'],
    ['Redis native distribution', 'source-built-native'],
  ]);
  for (const tool of register.nativeTools) {
    if (
      typeof tool.name !== 'string' ||
      nativeToolNames.has(tool.name) ||
      typeof tool.expectedVersion !== 'string' ||
      !Array.isArray(tool.commands) ||
      tool.commands.length === 0 ||
      new Set(tool.commands).size !== tool.commands.length
    ) {
      throw new Error(`Native tool row is incomplete or duplicated: ${String(tool.name)}`);
    }
    nativeToolNames.add(tool.name);
    validateExplicitReview(tool, 'Native tool row');
    if (
      typeof tool.provenance !== 'object' ||
      tool.provenance === null ||
      tool.provenance.kind !== expectedNativeProvenanceKinds.get(tool.name)
    ) {
      throw new Error(
        `Native tool row lacks exact name-discriminated provenance: ${String(tool.name)}`,
      );
    }
  }
  const managedArtifactNames = new Set();
  for (const artifact of register.managedArtifacts) {
    if (
      typeof artifact.name !== 'string' ||
      managedArtifactNames.has(artifact.name) ||
      !EXACT_VERSION_PATTERN.test(artifact.managerVersion) ||
      !Array.isArray(artifact.components) ||
      artifact.components.length === 0 ||
      path.basename(artifact.cacheRoot) !== artifact.cacheRoot.split('/').at(-1)
    ) {
      throw new Error(`Managed artifact row is incomplete or duplicated: ${String(artifact.name)}`);
    }
    managedArtifactNames.add(artifact.name);
    validateExplicitReview(artifact, 'Managed artifact row');
    if (artifact.descriptor !== toRepositoryPath(PLAYWRIGHT_DESCRIPTOR_PATH)) {
      throw new Error(`Managed artifact descriptor path drifted: ${artifact.name}`);
    }
    toRepositoryPath(path.join(REPOSITORY_ROOT, artifact.cacheRoot));
    const componentNames = new Set();
    for (const component of artifact.components) {
      if (
        typeof component.name !== 'string' ||
        componentNames.has(component.name) ||
        !/^\d+$/u.test(component.revision) ||
        path.basename(component.cacheDirectory) !== component.cacheDirectory
      ) {
        throw new Error(`Managed artifact component is incomplete or unsafe: ${artifact.name}`);
      }
      componentNames.add(component.name);
    }
  }
  const names = new Set();
  for (const row of register.dependencies) {
    if (typeof row.name !== 'string' || row.name.length === 0 || names.has(row.name)) {
      throw new Error(
        `Dependency register contains an invalid or duplicate name: ${String(row.name)}`,
      );
    }
    names.add(row.name);
    if (!['registry', 'workspace'].includes(row.kind)) {
      throw new Error(`Dependency register row has an invalid kind: ${row.name}`);
    }
    if (!EXACT_VERSION_PATTERN.test(row.expectedVersion)) {
      throw new Error(`Dependency register row is not exactly pinned: ${row.name}`);
    }
    if (typeof row.purpose !== 'string' || row.purpose.length === 0) {
      throw new Error(`Dependency register row lacks a purpose: ${row.name}`);
    }
    if (!Array.isArray(row.expectedConsumers) || row.expectedConsumers.length === 0) {
      throw new Error(`Dependency register row lacks consumers: ${row.name}`);
    }
    validateExplicitReview(row, 'Dependency register row');
    if (
      row.review.license.declared !== row.expectedDeclaredLicense ||
      row.review.cost.exposure !== row.exposure ||
      typeof row.review.scriptsAndNative.implications !== 'string' ||
      row.review.scriptsAndNative.implications.length === 0
    ) {
      throw new Error(
        `Dependency register row review does not match its declared facts: ${row.name}`,
      );
    }
  }
  for (const artifact of register.managedArtifacts) {
    if (!names.has(artifact.managerPackage)) {
      throw new Error(`Managed artifact manager lacks a direct dependency row: ${artifact.name}`);
    }
  }
}

function lockWorkspacePaths(lockfile) {
  return Object.keys(lockfile.packages ?? {})
    .filter((lockPath) => lockPath !== '' && !lockPath.startsWith('node_modules/'))
    .sort(compareText);
}

async function loadManifests(lockfile) {
  const manifestLockPaths = ['', ...lockWorkspacePaths(lockfile)];
  const manifests = [];
  for (const lockPath of manifestLockPaths) {
    const manifestPath = path.join(REPOSITORY_ROOT, lockPath, 'package.json');
    const manifest = await readJsonFile(manifestPath);
    const lockEntry = lockfile.packages[lockPath];
    if (manifest.name !== lockEntry?.name || manifest.version !== lockEntry?.version) {
      throw new Error(
        `Manifest and lockfile workspace identity disagree: ${toRepositoryPath(manifestPath)}`,
      );
    }
    manifests.push({
      lockPath,
      manifest,
      manifestPath,
      repositoryPath: toRepositoryPath(manifestPath),
      sha256: await sha256File(manifestPath),
    });
  }
  return manifests;
}

function collectDirectOccurrences(manifests) {
  const occurrences = [];
  for (const record of manifests) {
    for (const section of DIRECT_SECTIONS) {
      for (const [name, spec] of Object.entries(record.manifest[section] ?? {}).sort(
        ([left], [right]) => compareText(left, right),
      )) {
        occurrences.push({
          manifest: record.repositoryPath,
          manifestLockPath: record.lockPath,
          name,
          section,
          spec,
        });
      }
    }
  }
  return occurrences.sort((left, right) =>
    compareText(
      `${left.name}\u0000${left.manifest}\u0000${left.section}`,
      `${right.name}\u0000${right.manifest}\u0000${right.section}`,
    ),
  );
}

function parentResolutionContext(lockPath) {
  const nestedMarker = lockPath.lastIndexOf('/node_modules/');
  if (nestedMarker >= 0) {
    return lockPath.slice(0, nestedMarker);
  }
  return '';
}

function resolveLockedDependency(lockfile, fromLockPath, dependencyName) {
  let context = fromLockPath;
  for (;;) {
    const candidate = context
      ? `${context}/node_modules/${dependencyName}`
      : `node_modules/${dependencyName}`;
    if (lockfile.packages[candidate] !== undefined) {
      return candidate;
    }
    if (context === '') {
      break;
    }
    context = parentResolutionContext(context);
  }
  throw new Error(`Lockfile cannot resolve ${dependencyName} from ${fromLockPath || '<root>'}.`);
}

function occurrenceKey(occurrence) {
  return `${occurrence.manifest}\u0000${occurrence.section}\u0000${occurrence.spec}`;
}

function validateRegisterCoverage(register, manifests, lockfile) {
  const occurrences = collectDirectOccurrences(manifests);
  const byName = new Map();
  for (const occurrence of occurrences) {
    const current = byName.get(occurrence.name) ?? [];
    current.push(occurrence);
    byName.set(occurrence.name, current);
  }

  const registerByName = new Map(register.dependencies.map((row) => [row.name, row]));
  const missingRows = [...byName.keys()].filter((name) => !registerByName.has(name));
  const staleRows = [...registerByName.keys()].filter((name) => !byName.has(name));
  if (missingRows.length > 0 || staleRows.length > 0) {
    throw new Error(
      `Dependency register coverage mismatch; missing=[${missingRows.join(', ')}] stale=[${staleRows.join(', ')}].`,
    );
  }

  const workspaceByName = new Map(manifests.map((record) => [record.manifest.name, record]));
  for (const [name, dependencyOccurrences] of byName) {
    const row = registerByName.get(name);
    const actualConsumers = dependencyOccurrences
      .map(({ manifest, section, spec }) => ({ manifest, section, spec }))
      .sort((left, right) => compareText(occurrenceKey(left), occurrenceKey(right)));
    const expectedConsumers = [...row.expectedConsumers].sort((left, right) =>
      compareText(occurrenceKey(left), occurrenceKey(right)),
    );
    if (JSON.stringify(actualConsumers) !== JSON.stringify(expectedConsumers)) {
      throw new Error(`Dependency consumers drifted from the register: ${name}`);
    }

    const workspace = workspaceByName.get(name);
    if ((workspace === undefined ? 'registry' : 'workspace') !== row.kind) {
      throw new Error(`Dependency kind drifted from the register: ${name}`);
    }
    for (const occurrence of dependencyOccurrences) {
      if (occurrence.spec !== row.expectedVersion || !EXACT_VERSION_PATTERN.test(occurrence.spec)) {
        throw new Error(`Dependency is not pinned to its registered exact version: ${name}`);
      }
      const manifestLockEntry = lockfile.packages[occurrence.manifestLockPath];
      if (manifestLockEntry?.[occurrence.section]?.[name] !== occurrence.spec) {
        throw new Error(
          `Manifest declaration is not represented exactly in package-lock.json: ${name}`,
        );
      }
      const resolvedLockPath = resolveLockedDependency(
        lockfile,
        occurrence.manifestLockPath,
        occurrence.name,
      );
      const resolvedEntry = lockfile.packages[resolvedLockPath];
      const resolvedVersion =
        resolvedEntry.link === true
          ? workspaceByName.get(name)?.manifest.version
          : resolvedEntry.version;
      if (resolvedVersion !== row.expectedVersion) {
        throw new Error(`Locked version drifted from the dependency register: ${name}`);
      }
    }
  }

  return { byName, occurrences, registerByName, workspaceByName };
}

function derivePackageName(lockPath, lockEntry) {
  if (typeof lockEntry.name === 'string') {
    return lockEntry.name;
  }
  const marker = lockPath.lastIndexOf('node_modules/');
  if (marker < 0) {
    return null;
  }
  return lockPath.slice(marker + 'node_modules/'.length);
}

function artifactRootForLockEntry(lockPath, lockEntry) {
  if (lockPath === '') {
    return REPOSITORY_ROOT;
  }
  if (lockEntry.link === true) {
    if (typeof lockEntry.resolved !== 'string') {
      throw new Error(`Workspace link lacks a resolved path: ${lockPath}`);
    }
    const workspaceRoot = path.join(REPOSITORY_ROOT, lockEntry.resolved);
    toRepositoryPath(workspaceRoot);
    return workspaceRoot;
  }
  const artifactRoot = path.join(REPOSITORY_ROOT, lockPath);
  toRepositoryPath(artifactRoot);
  return artifactRoot;
}

async function licenseFilesAt(artifactRoot) {
  const entries = await fs.readdir(artifactRoot, { withFileTypes: true });
  const matches = entries
    .filter(
      (entry) =>
        entry.isFile() && /^(?:licen[cs]e|copying|copyright|notice)(?:\..+)?$/iu.test(entry.name),
    )
    .sort((left, right) => compareText(left.name, right.name));
  const files = [];
  for (const entry of matches) {
    const filePath = path.join(artifactRoot, entry.name);
    const metadata = await fs.lstat(filePath);
    files.push({
      bytes: metadata.size,
      path: toRepositoryPath(filePath),
      sha256: await sha256File(filePath),
    });
  }
  return files;
}

async function externalLicenseFilesAt(artifactRoot) {
  const entries = await fs.readdir(artifactRoot, { withFileTypes: true });
  const matches = entries
    .filter(
      (entry) =>
        entry.isFile() && /^(?:licen[cs]e|copying|copyright|notice)(?:\..+)?$/iu.test(entry.name),
    )
    .sort((left, right) => compareText(left.name, right.name));
  const files = [];
  for (const entry of matches) {
    const filePath = path.join(artifactRoot, entry.name);
    const metadata = await fs.lstat(filePath);
    files.push({
      bytes: metadata.size,
      path: normalizeEvidencePath(filePath, EVIDENCE_PATH_OPTIONS),
      sha256: await sha256File(filePath),
    });
  }
  return files;
}

async function treeFootprint(artifactRoot) {
  let bytes = 0;
  let files = 0;
  const pending = [artifactRoot];
  while (pending.length > 0) {
    const directory = pending.pop();
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const targetPath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        continue;
      }
      if (entry.isDirectory()) {
        pending.push(targetPath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      const metadata = await fs.lstat(targetPath);
      bytes += metadata.size;
      files += 1;
      if (files > 500_000) {
        throw new Error(`Artifact footprint exceeded the file-count safety limit: ${artifactRoot}`);
      }
    }
  }
  return { bytes, files };
}

async function scanArtifact(artifactRoot) {
  let bytes = 0;
  let files = 0;
  const nativeArtifacts = [];
  const pending = [artifactRoot];
  while (pending.length > 0) {
    const directory = pending.pop();
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => compareText(left.name, right.name));
    for (const entry of entries) {
      if (entry.name === 'node_modules') {
        continue;
      }
      const targetPath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        continue;
      }
      if (entry.isDirectory()) {
        pending.push(targetPath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      const metadata = await fs.lstat(targetPath);
      files += 1;
      bytes += metadata.size;
      if (NATIVE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        nativeArtifacts.push({
          bytes: metadata.size,
          path: toRepositoryPath(targetPath),
          sha256: await sha256File(targetPath),
        });
      }
      if (files > 100_000) {
        throw new Error(`Artifact file count exceeded the safety limit: ${artifactRoot}`);
      }
    }
  }
  nativeArtifacts.sort((left, right) => compareText(left.path, right.path));
  return { footprint: { bytes, files }, nativeArtifacts };
}

const artifactCache = new Map();

async function installedArtifactMetadata(lockPath, lockEntry) {
  const artifactRoot = artifactRootForLockEntry(lockPath, lockEntry);
  const artifactKey = path.resolve(artifactRoot);
  if (artifactCache.has(artifactKey)) {
    return artifactCache.get(artifactKey);
  }
  const manifestPath = path.join(artifactRoot, 'package.json');
  if (!(await pathExists(manifestPath))) {
    const unavailable = Object.freeze({
      availability: 'not-installed',
      reason:
        'No package manifest exists at the locked physical path in this platform-specific installation.',
    });
    artifactCache.set(artifactKey, unavailable);
    return unavailable;
  }

  const [manifest, manifestSha256, licenseFiles, scan] = await Promise.all([
    readJsonFile(manifestPath, { maximumBytes: 2 * 1024 * 1024 }),
    sha256File(manifestPath),
    licenseFilesAt(artifactRoot),
    scanArtifact(artifactRoot),
  ]);
  const scripts = sortedObject(manifest.scripts);
  const lifecycleScripts = Object.fromEntries(
    INSTALL_LIFECYCLE_SCRIPTS.filter((name) => scripts[name] !== undefined).map((name) => [
      name,
      scripts[name],
    ]),
  );
  const metadata = Object.freeze({
    availability: 'installed',
    artifactPath: toRepositoryPath(artifactRoot),
    bin: manifest.bin ?? null,
    bundledDependencies: manifest.bundledDependencies ?? manifest.bundleDependencies ?? null,
    cpu: manifest.cpu ?? null,
    footprint: scan.footprint,
    gypfile: manifest.gypfile ?? null,
    libc: manifest.libc ?? null,
    license: manifest.license ?? null,
    licenseFiles,
    lifecycleScripts,
    manifestPath: toRepositoryPath(manifestPath),
    manifestSha256,
    name: manifest.name ?? null,
    nativeArtifacts: scan.nativeArtifacts,
    optionalDependencies: sortedObject(manifest.optionalDependencies),
    os: manifest.os ?? null,
    repository: manifest.repository ?? null,
    scripts,
    version: manifest.version ?? null,
  });
  artifactCache.set(artifactKey, metadata);
  return metadata;
}

function exactLockMetadata(lockPath, lockEntry) {
  return {
    bin: lockEntry.bin ?? null,
    cpu: lockEntry.cpu ?? null,
    dependencies: sortedObject(lockEntry.dependencies),
    deprecated: lockEntry.deprecated ?? null,
    dev: lockEntry.dev ?? false,
    engines: lockEntry.engines ?? null,
    hasInstallScript: lockEntry.hasInstallScript ?? false,
    integrity: lockEntry.integrity ?? null,
    libc: lockEntry.libc ?? null,
    license: lockEntry.license ?? null,
    link: lockEntry.link ?? false,
    name: derivePackageName(lockPath, lockEntry),
    optional: lockEntry.optional ?? false,
    optionalDependencies: sortedObject(lockEntry.optionalDependencies),
    os: lockEntry.os ?? null,
    peerDependencies: sortedObject(lockEntry.peerDependencies),
    resolved: lockEntry.resolved ?? null,
    version: lockEntry.version ?? null,
  };
}

function validateLockArtifactProvenance(lockPath, lockEntry) {
  if (!lockPath.startsWith('node_modules/') || lockEntry.link === true) {
    return;
  }
  if (
    typeof lockEntry.resolved !== 'string' ||
    typeof lockEntry.integrity !== 'string' ||
    !lockEntry.integrity.startsWith('sha512-')
  ) {
    throw new Error(`Registry lock entry lacks an exact SHA-512 artifact identity: ${lockPath}`);
  }
  let resolved;
  try {
    resolved = new URL(lockEntry.resolved);
  } catch {
    throw new Error(`Registry lock entry has a malformed artifact URL: ${lockPath}`);
  }
  if (
    resolved.protocol !== 'https:' ||
    resolved.hostname !== 'registry.npmjs.org' ||
    resolved.username !== '' ||
    resolved.password !== ''
  ) {
    throw new Error(
      `Registry lock entry has unadmitted or credential-bearing provenance: ${lockPath}`,
    );
  }
}

function selectorAllowsCurrentValue(selectors, currentValue) {
  if (!Array.isArray(selectors) || selectors.length === 0) {
    return true;
  }
  if (currentValue === null) {
    return false;
  }
  const excluded = selectors
    .filter((selector) => selector.startsWith('!'))
    .map((selector) => selector.slice(1));
  if (excluded.includes(currentValue)) {
    return false;
  }
  const included = selectors.filter((selector) => !selector.startsWith('!'));
  return included.length === 0 || included.includes(currentValue);
}

function currentLibc() {
  if (process.platform !== 'linux') {
    return null;
  }
  return process.report.getReport().header.glibcVersionRuntime === undefined ? 'musl' : 'glibc';
}

function lockEntrySupportsCurrentPlatform(lockEntry) {
  return (
    selectorAllowsCurrentValue(lockEntry.os, process.platform) &&
    selectorAllowsCurrentValue(lockEntry.cpu, process.arch) &&
    selectorAllowsCurrentValue(lockEntry.libc, currentLibc())
  );
}

function validateInstalledArtifactIdentity(lockfile, lockPath, lockEntry, artifact) {
  const supportsCurrentPlatform = lockEntrySupportsCurrentPlatform(lockEntry);
  if (artifact.availability !== 'installed') {
    if (supportsCurrentPlatform) {
      throw new Error(`A current-platform locked artifact is not installed: ${lockPath}`);
    }
    return;
  }
  if (!supportsCurrentPlatform) {
    throw new Error(`An incompatible platform-filtered artifact is installed: ${lockPath}`);
  }

  const identityEntry = lockEntry.link === true ? lockfile.packages[lockEntry.resolved] : lockEntry;
  if (identityEntry === undefined) {
    throw new Error(`Workspace link target lacks lock metadata: ${lockPath}`);
  }
  const expectedName = identityEntry.name ?? derivePackageName(lockPath, lockEntry);
  if (
    artifact.name !== expectedName ||
    artifact.version !== identityEntry.version ||
    JSON.stringify(artifact.license) !== JSON.stringify(identityEntry.license ?? null)
  ) {
    throw new Error(`Installed artifact identity disagrees with exact lock metadata: ${lockPath}`);
  }
}

async function buildLockedGraph(lockfile) {
  const records = [];
  for (const lockPath of Object.keys(lockfile.packages).filter(Boolean).sort(compareText)) {
    const lockEntry = lockfile.packages[lockPath];
    validateLockArtifactProvenance(lockPath, lockEntry);
    const artifact = await installedArtifactMetadata(lockPath, lockEntry);
    validateInstalledArtifactIdentity(lockfile, lockPath, lockEntry, artifact);
    records.push({
      artifact,
      lock: exactLockMetadata(lockPath, lockEntry),
      lockPath,
    });
  }
  return records;
}

function dependencyNames(lockEntry) {
  return sortedUnique([
    ...Object.keys(lockEntry.dependencies ?? {}),
    ...Object.keys(lockEntry.optionalDependencies ?? {}),
    ...Object.keys(lockEntry.peerDependencies ?? {}),
  ]);
}

function dependencyClosure(lockfile, initialLockPaths) {
  const visited = new Set();
  const pending = [...initialLockPaths];
  while (pending.length > 0) {
    const lockPath = pending.pop();
    if (visited.has(lockPath)) {
      continue;
    }
    visited.add(lockPath);
    const lockEntry = lockfile.packages[lockPath];
    if (lockEntry === undefined) {
      throw new Error(`Dependency closure references a missing lock path: ${lockPath}`);
    }
    if (lockEntry.link === true && typeof lockEntry.resolved === 'string') {
      pending.push(lockEntry.resolved);
      continue;
    }
    for (const name of dependencyNames(lockEntry)) {
      try {
        pending.push(resolveLockedDependency(lockfile, lockPath, name));
      } catch (error) {
        if (lockEntry.peerDependenciesMeta?.[name]?.optional === true) {
          continue;
        }
        throw error;
      }
    }
  }
  return [...visited].sort(compareText);
}

function summarizeClosure(closure, lockedGraphByPath) {
  const installScriptPackages = [];
  const nativeArtifactPackages = [];
  const platformConstrainedPackages = [];
  const executableEntryPointPackages = [];
  const lifecycleScriptPackages = [];
  const installedRoots = new Set();
  let installedArtifactBytes = 0;
  let installedArtifactFiles = 0;

  for (const lockPath of closure) {
    const record = lockedGraphByPath.get(lockPath);
    if (record.lock.hasInstallScript) {
      installScriptPackages.push(lockPath);
    }
    if (record.lock.os !== null || record.lock.cpu !== null || record.lock.libc !== null) {
      platformConstrainedPackages.push(lockPath);
    }
    if (record.lock.bin !== null) {
      executableEntryPointPackages.push(lockPath);
    }
    if (record.artifact.availability === 'installed') {
      if (Object.keys(record.artifact.lifecycleScripts).length > 0) {
        lifecycleScriptPackages.push(lockPath);
      }
      if (record.artifact.nativeArtifacts.length > 0 || record.artifact.gypfile === true) {
        nativeArtifactPackages.push(lockPath);
      }
      if (!installedRoots.has(record.artifact.artifactPath)) {
        installedRoots.add(record.artifact.artifactPath);
        installedArtifactBytes += record.artifact.footprint.bytes;
        installedArtifactFiles += record.artifact.footprint.files;
      }
    }
  }
  return {
    executableEntryPointPackages,
    installScriptPackages,
    installedArtifactFootprint: {
      bytes: installedArtifactBytes,
      files: installedArtifactFiles,
      uniqueArtifactRoots: installedRoots.size,
    },
    lifecycleScriptPackages,
    lockedPackageCount: closure.length,
    lockedPaths: closure,
    nativeArtifactPackages,
    platformConstrainedPackages,
  };
}

async function buildDirectDependencyRecords(registerState, lockfile, lockedGraph) {
  const lockedGraphByPath = new Map(lockedGraph.map((record) => [record.lockPath, record]));
  const records = [];
  for (const name of [...registerState.byName.keys()].sort(compareText)) {
    const row = registerState.registerByName.get(name);
    const occurrences = registerState.byName.get(name);
    const lockPaths = sortedUnique(
      occurrences.map((occurrence) =>
        resolveLockedDependency(lockfile, occurrence.manifestLockPath, occurrence.name),
      ),
    );
    const primary = lockedGraphByPath.get(lockPaths[0]);
    const declaredLicense =
      primary.artifact.availability === 'installed'
        ? primary.artifact.license
        : primary.lock.license;
    if (declaredLicense !== row.expectedDeclaredLicense) {
      throw new Error(`Exact artifact licence declaration drifted from the register: ${name}`);
    }
    if (
      primary.artifact.availability === 'installed' &&
      primary.artifact.version !== row.expectedVersion
    ) {
      throw new Error(`Installed artifact version drifted from the register: ${name}`);
    }
    const closure = dependencyClosure(lockfile, lockPaths);
    records.push({
      admissionStatus: row.admissionStatus,
      artifact: primary.artifact,
      exactVersion: row.expectedVersion,
      exposure: row.exposure,
      kind: row.kind,
      lock: primary.lock,
      lockPaths,
      name,
      occurrences: occurrences.map(({ manifest, section, spec }) => ({ manifest, section, spec })),
      purpose: row.purpose,
      review: row.review,
      removalBoundary: row.removalBoundary,
      transitiveImplications: summarizeClosure(closure, lockedGraphByPath),
    });
  }
  return records;
}

async function findExecutable(commandName, pathValue) {
  for (const directory of pathValue.split(path.delimiter)) {
    if (directory === '') {
      continue;
    }
    const candidate = path.join(directory, commandName);
    try {
      await fs.access(candidate, fsConstants.X_OK);
      return { commandPath: candidate, realPath: await fs.realpath(candidate) };
    } catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'EACCES') {
        throw error;
      }
    }
  }
  throw new Error(`Required native tool is missing from PATH: ${commandName}`);
}

async function dynamicLinkage(executablePath) {
  if (process.platform === 'darwin' && (await pathExists('/usr/bin/otool'))) {
    const result = await runCommand('/usr/bin/otool', ['-L', executablePath], {
      maximumBytes: 256 * 1024,
      timeoutMs: 10_000,
    });
    if (result.code !== 0) {
      return { available: false, reason: 'otool exited non-zero' };
    }
    return {
      available: true,
      command: '/usr/bin/otool -L <executable>',
      libraries: result.stdout
        .split(/\r?\n/u)
        .slice(1)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => normalizeLocalRootsInText(line, EVIDENCE_PATH_OPTIONS)),
    };
  }
  if (process.platform === 'linux') {
    try {
      const ldd = await findExecutable('ldd', process.env.PATH ?? '');
      const result = await runCommand(ldd.realPath, [executablePath], {
        maximumBytes: 256 * 1024,
        timeoutMs: 10_000,
      });
      if (result.code === 0) {
        return {
          available: true,
          command: 'ldd <executable>',
          libraries: result.stdout
            .split(/\r?\n/u)
            .map((line) => line.trim())
            .filter(Boolean)
            .map((line) => normalizeLocalRootsInText(line, EVIDENCE_PATH_OPTIONS)),
        };
      }
    } catch {
      return { available: false, reason: 'ldd is unavailable' };
    }
  }
  return { available: false, reason: 'No supported dynamic-linkage inspector is available.' };
}

export function extractExpectedVersion(commandName, output) {
  if (commandName === 'node') {
    return /^v(\d+\.\d+\.\d+)$/u.exec(output)?.[1] ?? null;
  }
  if (commandName === 'npm') {
    return /^(\d+\.\d+\.\d+)$/u.exec(output)?.[1] ?? null;
  }
  if (commandName === 'redis-server') {
    return /^Redis server v=(\d+\.\d+\.\d+)(?=\s|$)/u.exec(output)?.[1] ?? null;
  }
  if (commandName === 'redis-cli') {
    return /^redis-cli (\d+\.\d+\.\d+)(?=\s|$)/u.exec(output)?.[1] ?? null;
  }
  if (commandName.startsWith('redis-')) {
    return null;
  }
  return /(?:PostgreSQL\)\s+)(\d+\.\d+(?:\.\d+)?)/u.exec(output)?.[1] ?? null;
}

async function executableRecord(commandName, executable, versionArgs, expectedVersion) {
  const result = await runCommand(executable.realPath, versionArgs, {
    maximumBytes: 64 * 1024,
    timeoutMs: 10_000,
  });
  if (result.code !== 0) {
    throw new Error(`Native tool version command failed: ${commandName}`);
  }
  const versionOutput = result.stdout.trim() || result.stderr.trim();
  const parsedVersion = extractExpectedVersion(commandName, versionOutput);
  if (parsedVersion !== expectedVersion) {
    throw new Error(
      `Native tool version mismatch for ${commandName}; expected ${expectedVersion}, received ${String(parsedVersion)}.`,
    );
  }
  const metadata = await fs.lstat(executable.realPath);
  return {
    bytes: metadata.size,
    command: commandName,
    commandPath: executable.commandPath,
    dynamicLinkage: await dynamicLinkage(executable.realPath),
    parsedVersion,
    realPath: executable.realPath,
    sha256: await sha256File(executable.realPath),
    versionArguments: versionArgs,
    versionOutput,
  };
}

function executableEvidenceRecord(record) {
  return {
    ...record,
    commandPath: normalizeEvidencePath(record.commandPath, EVIDENCE_PATH_OPTIONS),
    realPath: normalizeEvidencePath(record.realPath, EVIDENCE_PATH_OPTIONS),
    versionOutput: normalizeLocalRootsInText(record.versionOutput, EVIDENCE_PATH_OPTIONS),
  };
}

async function collectNativeTools(register, runtime) {
  const pathValue = process.env.PATH ?? '';
  const nativeTools = [];
  for (const tool of register.nativeTools) {
    const commands = [];
    for (const commandName of tool.commands) {
      if (commandName === 'node') {
        commands.push(
          await executableRecord(
            commandName,
            { commandPath: runtime.node, realPath: await fs.realpath(runtime.node) },
            ['--version'],
            tool.expectedVersion,
          ),
        );
        continue;
      }
      if (commandName === 'npm') {
        const result = await runCommand(runtime.node, [runtime.npmCli, '--version'], {
          maximumBytes: 64 * 1024,
          timeoutMs: 10_000,
        });
        const parsedVersion = extractExpectedVersion('npm', result.stdout.trim());
        if (result.code !== 0 || parsedVersion !== tool.expectedVersion) {
          throw new Error('Pinned npm CLI version does not match the dependency register.');
        }
        const metadata = await fs.lstat(runtime.npmCli);
        commands.push({
          bytes: metadata.size,
          command: 'npm',
          commandPath: runtime.npmCli,
          dynamicLinkage: { available: false, reason: 'npm CLI is a JavaScript entry point.' },
          parsedVersion,
          realPath: await fs.realpath(runtime.npmCli),
          sha256: await sha256File(runtime.npmCli),
          versionArguments: ['--version'],
          versionOutput: result.stdout.trim(),
        });
        continue;
      }
      const versionArgs = ['--version'];
      commands.push(
        await executableRecord(
          commandName,
          await findExecutable(commandName, pathValue),
          versionArgs,
          tool.expectedVersion,
        ),
      );
    }
    let artifactEvidence;
    if (tool.name === 'Node.js') {
      const platformKey = `${process.platform}-${process.arch}`;
      const registeredArtifact = tool.provenance.artifacts?.[platformKey];
      if (
        registeredArtifact?.archive !== runtime.artifact.archive ||
        registeredArtifact?.sha256 !== runtime.artifact.sha256
      ) {
        throw new Error(`Pinned Node artifact provenance drifted for ${platformKey}.`);
      }
      artifactEvidence = {
        archive: runtime.artifact.archive,
        archiveSha256: runtime.artifact.sha256,
        footprint: await treeFootprint(runtime.runtimeRoot),
        licenseFiles: await licenseFilesAt(runtime.runtimeRoot),
        runtimeRoot: toRepositoryPath(runtime.runtimeRoot),
      };
    } else if (tool.name === 'npm CLI') {
      const npmRoot = path.resolve(path.dirname(runtime.npmCli), '..');
      artifactEvidence = {
        footprint: await treeFootprint(npmRoot),
        licenseFiles: await licenseFilesAt(npmRoot),
        packageRoot: toRepositoryPath(npmRoot),
      };
    } else {
      const installationPrefixes = sortedUnique(
        commands.map((command) => path.dirname(path.dirname(command.realPath))),
      );
      artifactEvidence = {
        installationPrefixes: await Promise.all(
          installationPrefixes.map(async (installationPrefix) => ({
            footprint: await treeFootprint(installationPrefix),
            licenseFiles: await externalLicenseFilesAt(installationPrefix),
            path: normalizeEvidencePath(installationPrefix, EVIDENCE_PATH_OPTIONS),
          })),
        ),
      };
    }
    nativeTools.push({
      admissionStatus: tool.admissionStatus,
      artifactEvidence,
      commands: commands.map(executableEvidenceRecord),
      expectedVersion: tool.expectedVersion,
      name: tool.name,
      provenance: tool.provenance,
      removalBoundary: tool.removalBoundary,
      review: tool.review,
      role: tool.role,
    });
  }
  return nativeTools;
}

async function scanManagedArtifact(artifactRoot) {
  let bytes = 0;
  let files = 0;
  const hashedFiles = [];
  const pending = [artifactRoot];
  while (pending.length > 0) {
    const directory = pending.pop();
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => compareText(left.name, right.name));
    for (const entry of entries) {
      const targetPath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        continue;
      }
      if (entry.isDirectory()) {
        pending.push(targetPath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      const metadata = await fs.lstat(targetPath);
      files += 1;
      bytes += metadata.size;
      const isExecutable = (metadata.mode & 0o111) !== 0;
      const isNativeLibrary = NATIVE_EXTENSIONS.has(path.extname(entry.name).toLowerCase());
      const isNotice =
        /^(?:about|copying|copyright|dependencies_validated|installation_complete|licen[cs]e|notice)(?:\..+)?$/iu.test(
          entry.name,
        );
      if (isExecutable || isNativeLibrary || isNotice) {
        hashedFiles.push({
          bytes: metadata.size,
          executable: isExecutable,
          nativeLibrary: isNativeLibrary,
          noticeOrMarker: isNotice,
          path: toRepositoryPath(targetPath),
          sha256: await sha256File(targetPath),
        });
      }
      if (files > 250_000) {
        throw new Error(`Managed artifact file count exceeded the safety limit: ${artifactRoot}`);
      }
    }
  }
  hashedFiles.sort((left, right) => compareText(left.path, right.path));
  return { footprint: { bytes, files }, hashedFiles };
}

function browserDescriptorEntry(descriptor, name) {
  const matches = descriptor.browsers.filter((entry) => entry.name === name);
  if (matches.length !== 1) {
    throw new Error(`Playwright browser descriptor does not contain exactly one ${name} row.`);
  }
  return matches[0];
}

function assertManagedComponentDescriptor(component, descriptorEntry) {
  if (
    String(descriptorEntry.revision) !== component.revision ||
    (descriptorEntry.browserVersion ?? null) !== component.browserVersion
  ) {
    throw new Error(`Playwright managed artifact descriptor drifted: ${component.name}`);
  }
}

async function managerResolvedChromiumExecutable(runtime, cacheRoot) {
  const script =
    "import { chromium } from 'playwright'; process.stdout.write(chromium.executablePath());";
  const result = await runCommand(runtime.node, ['--input-type=module', '--eval', script], {
    env: {
      HOME: path.join(REPOSITORY_ROOT, '.dev', 'tmp'),
      LANG: 'C.UTF-8',
      PATH: [runtime.binDirectory, '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(path.delimiter),
      PLAYWRIGHT_BROWSERS_PATH: cacheRoot,
      TMPDIR: path.join(REPOSITORY_ROOT, '.dev', 'tmp'),
    },
    maximumBytes: 64 * 1024,
    timeoutMs: COMMAND_TIMEOUT_MS,
  });
  if (result.code !== 0 || result.stdout.trim() === '') {
    throw new Error('The exactly locked Playwright manager did not resolve a Chromium executable.');
  }
  const executablePath = path.resolve(result.stdout.trim());
  const relativePath = path.relative(cacheRoot, executablePath);
  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    throw new Error('Playwright resolved Chromium outside the repository-owned browser cache.');
  }
  return executablePath;
}

function managedExecutableFor(component, scan, managerExecutable) {
  if (component.name === 'chromium') {
    return managerExecutable;
  }
  const expectedPattern =
    component.name === 'chromium-headless-shell'
      ? /chrome-headless-shell$/u
      : /ffmpeg(?:-[^/]*)?$/u;
  const matches = scan.hashedFiles
    .filter((record) => record.executable && expectedPattern.test(record.path))
    .map((record) => path.join(REPOSITORY_ROOT, record.path));
  if (matches.length !== 1) {
    throw new Error(
      `Expected one executable for managed component ${component.name}, received ${String(matches.length)}.`,
    );
  }
  return matches[0];
}

async function managedExecutableIdentity(component, executablePath) {
  const versionArguments = component.name === 'ffmpeg' ? ['-version'] : ['--version'];
  const result = await runCommand(executablePath, versionArguments, {
    maximumBytes: 256 * 1024,
    timeoutMs: 10_000,
  });
  if (result.code !== 0) {
    throw new Error(`Managed artifact version command failed: ${component.name}`);
  }
  const versionOutput = (result.stdout.trim() || result.stderr.trim()).split(/\r?\n/u)[0];
  if (component.browserVersion !== null && !versionOutput.includes(component.browserVersion)) {
    throw new Error(`Managed browser version drifted: ${component.name}`);
  }
  const metadata = await fs.lstat(executablePath);
  return {
    bytes: metadata.size,
    dynamicLinkage: await dynamicLinkage(executablePath),
    path: toRepositoryPath(executablePath),
    sha256: await sha256File(executablePath),
    versionArguments,
    versionOutput: normalizeLocalRootsInText(versionOutput, EVIDENCE_PATH_OPTIONS),
  };
}

async function collectManagedArtifacts(register, runtime) {
  const descriptor = await readJsonFile(PLAYWRIGHT_DESCRIPTOR_PATH, {
    maximumBytes: 512 * 1024,
  });
  if (!Array.isArray(descriptor.browsers)) {
    throw new Error('Playwright browser descriptor is malformed.');
  }
  const results = [];
  for (const artifact of register.managedArtifacts) {
    if (artifact.name !== 'Playwright-managed Chromium') {
      throw new Error(`Unsupported managed dependency artifact: ${artifact.name}`);
    }
    const managerManifest = await readJsonFile(
      path.join(REPOSITORY_ROOT, 'node_modules', artifact.managerPackage, 'package.json'),
    );
    if (managerManifest.version !== artifact.managerVersion) {
      throw new Error('Playwright manager package version drifted from the artifact register.');
    }
    const cacheRoot = path.join(REPOSITORY_ROOT, artifact.cacheRoot);
    const managerExecutable = await managerResolvedChromiumExecutable(runtime, cacheRoot);
    const components = [];
    for (const component of artifact.components) {
      const descriptorEntry = browserDescriptorEntry(descriptor, component.name);
      assertManagedComponentDescriptor(component, descriptorEntry);
      const artifactRoot = path.join(cacheRoot, component.cacheDirectory);
      const completionMarker = path.join(artifactRoot, 'INSTALLATION_COMPLETE');
      if (!(await pathExists(completionMarker))) {
        throw new Error(`Managed artifact is not completely installed: ${component.name}`);
      }
      const scan = await scanManagedArtifact(artifactRoot);
      const executablePath = managedExecutableFor(component, scan, managerExecutable);
      components.push({
        browserVersion: component.browserVersion,
        cacheDirectory: toRepositoryPath(artifactRoot),
        descriptor: {
          browserVersion: descriptorEntry.browserVersion ?? null,
          installByDefault: descriptorEntry.installByDefault ?? false,
          name: descriptorEntry.name,
          revision: String(descriptorEntry.revision),
          title: descriptorEntry.title ?? null,
        },
        executable: await managedExecutableIdentity(component, executablePath),
        footprint: scan.footprint,
        hashedNativeExecutableNoticeAndMarkerFiles: scan.hashedFiles,
        name: component.name,
        revision: component.revision,
      });
    }
    results.push({
      admissionStatus: artifact.admissionStatus,
      cacheRoot: toRepositoryPath(cacheRoot),
      components,
      descriptor: artifact.descriptor,
      descriptorSha256: await sha256File(PLAYWRIGHT_DESCRIPTOR_PATH),
      downloadBoundary: artifact.downloadBoundary,
      exposure: artifact.exposure,
      managerPackage: artifact.managerPackage,
      managerVersion: artifact.managerVersion,
      name: artifact.name,
      purpose: artifact.purpose,
      removalBoundary: artifact.removalBoundary,
      review: artifact.review,
      timeSensitivePlatformArtifactPaths: true,
    });
  }
  return results;
}

async function createAuditEnvironment(runtime, scope) {
  const auditRoot = path.join(REPOSITORY_ROOT, '.dev', 'tmp', 'dependency-audit', scope);
  const home = path.join(auditRoot, 'home');
  const temporary = path.join(auditRoot, 'tmp');
  const cache = path.join(REPOSITORY_ROOT, '.dev', 'cache', 'npm-audit', scope);
  await fs.rm(auditRoot, { force: true, recursive: true });
  await Promise.all([
    fs.mkdir(home, { mode: 0o700, recursive: true }),
    fs.mkdir(temporary, { mode: 0o700, recursive: true }),
    fs.mkdir(cache, { mode: 0o700, recursive: true }),
  ]);
  const userConfig = path.join(auditRoot, 'user.npmrc');
  const globalConfig = path.join(auditRoot, 'global.npmrc');
  await Promise.all([
    fs.writeFile(userConfig, 'registry=https://registry.npmjs.org/\n', { mode: 0o600 }),
    fs.writeFile(globalConfig, '', { mode: 0o600 }),
  ]);
  return {
    CI: 'true',
    HOME: home,
    LANG: 'C.UTF-8',
    NPM_CONFIG_CACHE: cache,
    NPM_CONFIG_FUND: 'false',
    NPM_CONFIG_GLOBALCONFIG: globalConfig,
    NPM_CONFIG_REGISTRY: 'https://registry.npmjs.org/',
    NPM_CONFIG_UPDATE_NOTIFIER: 'false',
    NPM_CONFIG_USERCONFIG: userConfig,
    PATH: [runtime.binDirectory, '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(path.delimiter),
    TMPDIR: temporary,
  };
}

function sanitizeAdvisory(value) {
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  return {
    cvss: value.cvss ?? null,
    cwe: value.cwe ?? null,
    dependency: value.dependency ?? null,
    name: value.name ?? null,
    range: value.range ?? null,
    severity: value.severity ?? null,
    source: value.source ?? null,
    title: value.title ?? null,
    url: value.url ?? null,
  };
}

function sanitizeVulnerability(value) {
  return {
    effects: Array.isArray(value.effects) ? sortedUnique(value.effects) : [],
    fixAvailable:
      typeof value.fixAvailable === 'boolean'
        ? value.fixAvailable
        : value.fixAvailable === null || value.fixAvailable === undefined
          ? null
          : {
              isSemVerMajor: value.fixAvailable.isSemVerMajor ?? null,
              name: value.fixAvailable.name ?? null,
              version: value.fixAvailable.version ?? null,
            },
    isDirect: value.isDirect ?? null,
    name: value.name ?? null,
    nodes: Array.isArray(value.nodes) ? sortedUnique(value.nodes) : [],
    range: value.range ?? null,
    severity: value.severity ?? null,
    via: Array.isArray(value.via) ? value.via.map(sanitizeAdvisory).filter(Boolean) : [],
  };
}

function sanitizeAuditReport(report) {
  if (
    typeof report !== 'object' ||
    report === null ||
    typeof report.auditReportVersion !== 'number' ||
    typeof report.metadata !== 'object' ||
    report.metadata === null ||
    typeof report.vulnerabilities !== 'object' ||
    report.vulnerabilities === null
  ) {
    throw new Error('npm audit returned an unsupported or error response.');
  }
  return {
    auditReportVersion: report.auditReportVersion,
    metadata: {
      dependencies: sortedObject(report.metadata.dependencies),
      vulnerabilities: sortedObject(report.metadata.vulnerabilities),
    },
    vulnerabilities: Object.fromEntries(
      Object.entries(report.vulnerabilities)
        .sort(([left], [right]) => compareText(left, right))
        .map(([name, vulnerability]) => [name, sanitizeVulnerability(vulnerability)]),
    ),
  };
}

async function runAudit(runtime, auditEnvironment, scope) {
  const omitArguments = scope === 'production-omit-dev' ? ['--omit=dev'] : [];
  const args = [
    runtime.npmCli,
    'audit',
    '--json',
    '--ignore-scripts',
    ...omitArguments,
    '--registry=https://registry.npmjs.org/',
  ];
  const startedAt = new Date().toISOString();
  const result = await runCommand(runtime.node, args, {
    env: auditEnvironment,
    maximumBytes: MAX_COMMAND_OUTPUT_BYTES,
    timeoutMs: COMMAND_TIMEOUT_MS,
  });
  if (![0, 1].includes(result.code)) {
    throw new Error(
      `npm audit ${scope} did not return an audit result (exit ${String(result.code)}).`,
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new Error(`npm audit ${scope} did not return parseable JSON.`);
  }
  return {
    command: `npm audit --json --ignore-scripts${omitArguments.length > 0 ? ' --omit=dev' : ''} --registry=https://registry.npmjs.org/`,
    completedAt: new Date().toISOString(),
    environmentIsolation: {
      inheritedEnvironmentVariables: [],
      npmConfigFiles:
        'fresh repository-local scratch files with no auth data; user config contains only the fixed registry',
      persistedRawStdout: false,
      persistedStderr: false,
      registry: 'https://registry.npmjs.org/',
    },
    exitCode: result.code,
    npmAudit: sanitizeAuditReport(parsed),
    scope,
    startedAt,
    timeSensitive: true,
  };
}

function evidenceMetadata(generatedAt, inputs) {
  return {
    command: COMMAND,
    generatedAt,
    generator: 'tooling/dependencies/verify.mjs',
    inputs,
    schemaVersion: 1,
    seed: {
      applicability: 'not-applicable',
      reason:
        'Dependency metadata extraction and npm audit invocation use no randomized operation.',
      value: null,
    },
  };
}

function assertNoSecretShapedKeys(value, location = '$') {
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      assertNoSecretShapedKeys(entry, `${location}[${String(index)}]`),
    );
    return;
  }
  if (typeof value !== 'object' || value === null) {
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_KEY_PATTERN.test(key)) {
      throw new Error(`Evidence contains a prohibited sensitive key at ${location}.${key}`);
    }
    assertNoSecretShapedKeys(child, `${location}.${key}`);
  }
}

async function verifyCommittedEvidence({
  currentFullAudit,
  currentMetadata,
  currentProductionAudit,
  inputs,
  vulnerabilityTotals,
}) {
  const metadataPath = path.join(EVIDENCE_DIRECTORY, 'dependency-metadata.json');
  const productionAuditPath = path.join(EVIDENCE_DIRECTORY, 'npm-audit-production.json');
  const fullAuditPath = path.join(EVIDENCE_DIRECTORY, 'npm-audit-full.json');
  const verificationPath = path.join(EVIDENCE_DIRECTORY, 'verification.json');
  const [metadata, productionAudit, fullAudit, verification] = await Promise.all([
    readJsonFile(metadataPath),
    readJsonFile(productionAuditPath),
    readJsonFile(fullAuditPath),
    readJsonFile(verificationPath),
  ]);
  for (const [name, evidence] of [
    ['metadata', metadata],
    ['productionAudit', productionAudit],
    ['fullAudit', fullAudit],
    ['verification', verification],
  ]) {
    assertNoSecretShapedKeys(evidence);
    assertNoAbsoluteLocalPaths(evidence, EVIDENCE_PATH_OPTIONS, `$committed.${name}`);
    if (JSON.stringify(evidence.evidence?.inputs) !== JSON.stringify(inputs)) {
      throw new Error('Committed dependency evidence inputs are stale; regenerate the evidence.');
    }
    if (
      evidence.evidence?.command !== COMMAND ||
      evidence.evidence?.seed?.applicability !== 'not-applicable' ||
      evidence.evidence?.seed?.value !== null
    ) {
      throw new Error('Committed dependency evidence lacks the required command/seed metadata.');
    }
  }
  if (
    JSON.stringify(metadata.lockfile) !== JSON.stringify(currentMetadata.lockfile) ||
    JSON.stringify(metadata.manifestInventory) !==
      JSON.stringify(currentMetadata.manifestInventory) ||
    JSON.stringify(metadata.registerVerification) !==
      JSON.stringify(currentMetadata.registerVerification) ||
    JSON.stringify(metadata.supplyChainControls) !==
      JSON.stringify(currentMetadata.supplyChainControls)
  ) {
    throw new Error('Committed dependency inventory summary is stale; regenerate the evidence.');
  }
  if (
    JSON.stringify(productionAudit.audit?.npmAudit) !==
      JSON.stringify(currentProductionAudit.npmAudit) ||
    JSON.stringify(fullAudit.audit?.npmAudit) !== JSON.stringify(currentFullAudit.npmAudit)
  ) {
    throw new Error(
      'Committed npm advisory snapshot differs from the current sanitized audit result.',
    );
  }
  if (
    verification.result?.passed !== true ||
    verification.result?.absoluteRepositoryAndHomePathsRefused !== true ||
    verification.result?.uniqueDirectDependencyCount !==
      currentMetadata.manifestInventory.uniqueDirectDependencyCount ||
    verification.result?.directDependencyOccurrenceCount !==
      currentMetadata.manifestInventory.directDependencyOccurrenceCount ||
    verification.result?.registerJsonSchemaValidated !== true ||
    verification.result?.registerSchemaNegativeRefusalsVerified !== true ||
    JSON.stringify(verification.result?.vulnerabilityTotals) !== JSON.stringify(vulnerabilityTotals)
  ) {
    throw new Error('Committed dependency verification summary is stale or non-passing.');
  }
  const expectedOutputs = new Map([
    ['evidence/dependencies/dependency-metadata.json', metadataPath],
    ['evidence/dependencies/npm-audit-production.json', productionAuditPath],
    ['evidence/dependencies/npm-audit-full.json', fullAuditPath],
  ]);
  if (
    !Array.isArray(verification.outputs) ||
    verification.outputs.length !== expectedOutputs.size
  ) {
    throw new Error('Committed dependency verification output manifest is incomplete.');
  }
  for (const output of verification.outputs) {
    const outputPath = expectedOutputs.get(output.path);
    if (outputPath === undefined || (await sha256File(outputPath)) !== output.sha256) {
      throw new Error(
        `Committed dependency evidence output digest mismatch: ${String(output.path)}`,
      );
    }
  }
}

function auditVulnerabilityTotal(audit) {
  const total = audit.npmAudit.metadata.vulnerabilities.total;
  if (!Number.isInteger(total) || total < 0) {
    throw new Error(`npm audit ${audit.scope} returned an invalid vulnerability total.`);
  }
  return total;
}

async function collectNpmConfiguration() {
  const metadata = await fs.lstat(NPM_CONFIGURATION_PATH);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 64 * 1024) {
    throw new Error('The committed npm configuration must be a bounded regular file.');
  }
  const source = await fs.readFile(NPM_CONFIGURATION_PATH, 'utf8');
  const settings = {};
  for (const [index, sourceLine] of source.split(/\r?\n/u).entries()) {
    const line = sourceLine.trim();
    if (line === '' || line.startsWith('#') || line.startsWith(';')) {
      continue;
    }
    const separator = line.indexOf('=');
    if (separator <= 0) {
      throw new Error(`Unsupported committed npm configuration at line ${String(index + 1)}.`);
    }
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (
      key === '' ||
      value === '' ||
      Object.hasOwn(settings, key) ||
      /(?:auth|credential|password|secret|token)/iu.test(key) ||
      /\$\{/u.test(value) ||
      /^[a-z][a-z\d+.-]*:\/\/[^/@\s]+:[^/@\s]+@/iu.test(value)
    ) {
      throw new Error(
        `Unsafe, empty, or duplicate committed npm configuration at line ${String(index + 1)}.`,
      );
    }
    settings[key] = value;
  }
  const requiredSettings = {
    'engine-strict': 'true',
    'ignore-scripts': 'true',
    'package-lock': 'true',
    'save-exact': 'true',
    'strict-peer-deps': 'true',
  };
  for (const [key, expectedValue] of Object.entries(requiredSettings)) {
    if (settings[key] !== expectedValue) {
      throw new Error(
        `Committed npm safety setting is absent or weakened: ${key}=${expectedValue}`,
      );
    }
  }
  return {
    path: toRepositoryPath(NPM_CONFIGURATION_PATH),
    settings: sortedObject(settings),
    sha256: await sha256File(NPM_CONFIGURATION_PATH),
  };
}

async function collectNativeBuildToolchain() {
  const register = await readJsonFile(NATIVE_TOOLCHAIN_PATH, { maximumBytes: 64 * 1024 });
  if (
    register?.schemaVersion !== 1 ||
    typeof register.target !== 'string' ||
    register.target.length === 0 ||
    typeof register.claimBoundary !== 'string' ||
    register.claimBoundary.length === 0 ||
    !Array.isArray(register.requiredCommands) ||
    register.requiredCommands.length === 0
  ) {
    throw new Error('Native build-toolchain register does not match schema version 1.');
  }
  const names = new Set();
  for (const row of register.requiredCommands) {
    if (
      typeof row?.name !== 'string' ||
      row.name.length === 0 ||
      names.has(row.name) ||
      !Array.isArray(row.versionArguments) ||
      !row.versionArguments.every((argument) => typeof argument === 'string')
    ) {
      throw new Error('Native build-toolchain register contains an invalid command row.');
    }
    names.add(row.name);
  }
  return {
    claimBoundary: register.claimBoundary,
    path: toRepositoryPath(NATIVE_TOOLCHAIN_PATH),
    requiredCommands: register.requiredCommands,
    schemaVersion: register.schemaVersion,
    sha256: await sha256File(NATIVE_TOOLCHAIN_PATH),
    target: register.target,
  };
}

async function collectSupplyChainControls() {
  const [npmConfiguration, nativeBuildToolchain] = await Promise.all([
    collectNpmConfiguration(),
    collectNativeBuildToolchain(),
  ]);
  return { nativeBuildToolchain, npmConfiguration };
}

async function inputEvidence(manifests) {
  const fixedInputs = [
    BOOTSTRAP_PATH,
    BOUNDED_DOWNLOAD_PATH,
    EVIDENCE_PATHS_PATH,
    EVIDENCE_PATHS_TEST_PATH,
    LOCK_PATH,
    NATIVE_TOOLCHAIN_PATH,
    NATIVE_PROVISIONER_PATH,
    NPM_CONFIGURATION_PATH,
    PINNED_RUNTIME_PATH,
    REGISTER_PATH,
    REGISTER_SCHEMA_PATH,
    SCHEMA_VALIDATOR_PATH,
    SCHEMA_VALIDATOR_TEST_PATH,
    SUBPROCESS_VERSION_TEST_PATH,
    THIS_FILE,
    PLAYWRIGHT_DESCRIPTOR_PATH,
  ];
  const allInputs = [...fixedInputs, ...manifests.map((record) => record.manifestPath)];
  const uniqueInputs = sortedUnique(allInputs.map((targetPath) => path.resolve(targetPath)));
  const records = [];
  for (const targetPath of uniqueInputs) {
    records.push({
      path: toRepositoryPath(targetPath),
      sha256: await sha256File(targetPath),
    });
  }
  return records;
}

async function main(runtime) {
  const argumentsList = process.argv.slice(2);
  if (argumentsList.some((argument) => argument !== '--check') || argumentsList.length > 1) {
    throw new Error('Usage: node tooling/dependencies/verify.mjs [--check]');
  }
  const checkOnly = argumentsList[0] === '--check';
  const [register, registerSchema, lockfile] = await Promise.all([
    readJsonFile(REGISTER_PATH),
    readJsonFile(REGISTER_SCHEMA_PATH),
    readJsonFile(LOCK_PATH),
  ]);
  validateJsonSchema(registerSchema, register);
  const schemaNegativeRefusals = assertDependencyRegisterSchemaRefusals(registerSchema, register);
  const pathNegativeRefusals = assertEvidencePathSafetyRefusals(EVIDENCE_PATH_OPTIONS);
  validateRegisterShape(register);
  if (lockfile.lockfileVersion !== 3 || typeof lockfile.packages !== 'object') {
    throw new Error('package-lock.json must be npm lockfileVersion 3 with package metadata.');
  }

  const manifests = await loadManifests(lockfile);
  const registerCoverage = validateRegisterCoverage(register, manifests, lockfile);
  const lockedGraph = await buildLockedGraph(lockfile);
  const directDependencies = await buildDirectDependencyRecords(
    {
      ...registerCoverage,
      policy: register.policy,
    },
    lockfile,
    lockedGraph,
  );
  const nativeTools = await collectNativeTools(register, runtime);
  const managedArtifacts = await collectManagedArtifacts(register, runtime);
  const supplyChainControls = await collectSupplyChainControls();
  const [productionAuditEnvironment, fullAuditEnvironment] = await Promise.all([
    createAuditEnvironment(runtime, 'production-omit-dev'),
    createAuditEnvironment(runtime, 'full-lockfile'),
  ]);
  const [productionAudit, fullAudit] = await Promise.all([
    runAudit(runtime, productionAuditEnvironment, 'production-omit-dev'),
    runAudit(runtime, fullAuditEnvironment, 'full-lockfile'),
  ]);

  const generatedAt = new Date().toISOString();
  const inputs = await inputEvidence(manifests);
  const metadataEvidence = {
    evidence: evidenceMetadata(generatedAt, inputs),
    localArtifactScope: {
      limitation:
        'Installed package manifests and files are exact for this clean npm installation. Platform-filtered lock entries retain lock metadata but have no installed artifact script/file claim.',
      pathPolicy:
        'Repository-local paths are repository-relative; external home paths use <home>; external platform paths such as /opt remain explicit observations.',
      pathPolicyNegativeRefusedProbeCount: pathNegativeRefusals.refusedProbeCount,
      platform: process.platform,
      architecture: process.arch,
      timeSensitiveNativeToolPaths: true,
    },
    lockfile: {
      lockfileVersion: lockfile.lockfileVersion,
      lockedPackageEntryCount: lockedGraph.length,
      path: 'package-lock.json',
      sha256: await sha256File(LOCK_PATH),
    },
    manifestInventory: {
      directDependencyOccurrenceCount: registerCoverage.occurrences.length,
      manifests: manifests.map((record) => ({
        name: record.manifest.name,
        path: record.repositoryPath,
        sha256: record.sha256,
        version: record.manifest.version,
      })),
      uniqueDirectDependencyCount: directDependencies.length,
    },
    registerVerification: {
      coveredDirectDependencies: directDependencies.map((record) => record.name),
      exactConsumerSetsMatch: true,
      exactManifestSpecsMatch: true,
      exactResolvedVersionsMatch: true,
      missingRows: [],
      registerJsonSchemaValidated: true,
      schemaNegativeRefusedProbeCount: schemaNegativeRefusals.refusedProbeCount,
      staleRows: [],
    },
    supplyChainControls,
    nativeTools,
    managedArtifacts,
    directDependencies,
    lockedGraph,
  };

  const productionAuditEvidence = {
    evidence: evidenceMetadata(generatedAt, inputs),
    audit: productionAudit,
    limitation:
      'This point-in-time npm registry advisory snapshot is not a maintenance review, historical security review, reachability proof, or prediction of future advisory status.',
  };
  const fullAuditEvidence = {
    evidence: evidenceMetadata(generatedAt, inputs),
    audit: fullAudit,
    limitation:
      'This point-in-time npm registry advisory snapshot is not a maintenance review, historical security review, reachability proof, or prediction of future advisory status.',
  };

  for (const [name, evidence] of [
    ['metadata', metadataEvidence],
    ['productionAudit', productionAuditEvidence],
    ['fullAudit', fullAuditEvidence],
  ]) {
    assertNoSecretShapedKeys(evidence);
    assertNoAbsoluteLocalPaths(evidence, EVIDENCE_PATH_OPTIONS, `$generated.${name}`);
  }

  const vulnerabilityTotals = {
    fullLockfile: auditVulnerabilityTotal(fullAudit),
    productionOmitDev: auditVulnerabilityTotal(productionAudit),
  };
  const passed = Object.values(vulnerabilityTotals).every((total) => total === 0);
  if (checkOnly) {
    await verifyCommittedEvidence({
      currentFullAudit: fullAudit,
      currentMetadata: metadataEvidence,
      currentProductionAudit: productionAudit,
      inputs,
      vulnerabilityTotals,
    });
    if (!passed) {
      throw new Error('Current npm audit returned one or more unresolved findings.');
    }
    process.stdout.write(
      `[dependencies] PASS check-only: ${String(directDependencies.length)} unique direct dependencies across ${String(registerCoverage.occurrences.length)} declarations; committed evidence inputs/digests match; current production and full npm audits observed 0 known vulnerabilities at ${generatedAt}. Full admission remains pending documented reviews.\n`,
    );
    return;
  }

  await fs.mkdir(EVIDENCE_DIRECTORY, { mode: 0o755, recursive: true });
  const metadataPath = path.join(EVIDENCE_DIRECTORY, 'dependency-metadata.json');
  const productionAuditPath = path.join(EVIDENCE_DIRECTORY, 'npm-audit-production.json');
  const fullAuditPath = path.join(EVIDENCE_DIRECTORY, 'npm-audit-full.json');
  await Promise.all([
    writeJsonAtomic(metadataPath, metadataEvidence),
    writeJsonAtomic(productionAuditPath, productionAuditEvidence),
    writeJsonAtomic(fullAuditPath, fullAuditEvidence),
  ]);

  const outputFiles = [];
  for (const outputPath of [metadataPath, productionAuditPath, fullAuditPath]) {
    outputFiles.push({
      path: toRepositoryPath(outputPath),
      sha256: await sha256File(outputPath),
    });
  }
  const verificationEvidence = {
    evidence: evidenceMetadata(generatedAt, inputs),
    admissionBoundary: {
      allDependenciesFullyAdmitted: false,
      reason:
        'Local artifact evidence is present, but upstream maintenance, historical security, legal obligations, and runtime/bundle cost review remain pending.',
    },
    outputs: outputFiles,
    result: {
      absoluteRepositoryAndHomePathsRefused: pathNegativeRefusals.refusedProbeCount === 6,
      auditsCompleted: true,
      directDependencyOccurrenceCount: registerCoverage.occurrences.length,
      exactPinsVerified: true,
      fullAuditHasNoKnownVulnerabilitiesAtObservationTime: vulnerabilityTotals.fullLockfile === 0,
      managedArtifactIdentitiesVerified: true,
      nativeToolIdentitiesVerified: true,
      passed,
      productionAuditHasNoKnownVulnerabilitiesAtObservationTime:
        vulnerabilityTotals.productionOmitDev === 0,
      registerCoverageVerified: true,
      registerJsonSchemaValidated: true,
      registerSchemaNegativeRefusalsVerified: schemaNegativeRefusals.refusedProbeCount === 11,
      uniqueDirectDependencyCount: directDependencies.length,
      vulnerabilityTotals,
    },
    timeSensitive: {
      auditObservedAt: {
        fullLockfile: fullAudit.completedAt,
        productionOmitDev: productionAudit.completedAt,
      },
      statement:
        'Audit results and native tool paths are observations from this run and must be regenerated for a later claim.',
    },
  };
  assertNoSecretShapedKeys(verificationEvidence);
  assertNoAbsoluteLocalPaths(
    verificationEvidence,
    EVIDENCE_PATH_OPTIONS,
    '$generated.verification',
  );
  await writeJsonAtomic(path.join(EVIDENCE_DIRECTORY, 'verification.json'), verificationEvidence);

  if (!passed) {
    throw new Error(
      'Dependency evidence regenerated, but one or more npm audit findings are unresolved.',
    );
  }
  process.stdout.write(
    `[dependencies] PASS ${String(directDependencies.length)} unique direct dependencies across ${String(registerCoverage.occurrences.length)} declarations; exact pins/register coverage/native tool identities verified; production and full npm audits observed 0 known vulnerabilities at ${generatedAt}. Full admission remains pending documented reviews.\n`,
  );
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === THIS_FILE) {
  try {
    const runtime = await runPinnedSelf();
    if (runtime !== null) {
      await main(runtime);
    }
  } catch (error) {
    process.stderr.write(
      `[dependencies] FAIL ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
