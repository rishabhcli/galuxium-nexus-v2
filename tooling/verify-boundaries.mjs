import fs from 'node:fs/promises';
import { builtinModules } from 'node:module';
import path from 'node:path';

import ts from 'typescript';

import { REPOSITORY_ROOT, runBoundedCommand, verifyPinnedRuntime } from './pinned-runtime.mjs';

const DEPENDENCY_CRUISER_CLI = path.join(
  REPOSITORY_ROOT,
  'node_modules',
  'dependency-cruiser',
  'bin',
  'dependency-cruise.mjs',
);
const DEPENDENCY_CRUISER_CONFIG = path.join(REPOSITORY_ROOT, 'dependency-cruiser.config.mjs');
const TEMPORARY_ROOT = path.join(REPOSITORY_ROOT, '.dev', 'tmp');
const MAXIMUM_OUTPUT_BYTES = 4 * 1024 * 1024;
const TIMEOUT_MS = 60_000;
const WORKSPACE_ROOT_NAMES = Object.freeze(['apps', 'packages', 'services']);
const BUILTIN_MODULES = new Set(
  builtinModules.flatMap((name) => [
    name,
    name.startsWith('node:') ? name.slice(5) : `node:${name}`,
  ]),
);

function assertInsideTemporaryRoot(targetPath) {
  const relative = path.relative(TEMPORARY_ROOT, path.resolve(targetPath));
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Refusing an unsafe boundary-fixture path: ${targetPath}`);
  }
}

async function assertRegularFile(targetPath) {
  const metadata = await fs.lstat(targetPath);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`Boundary verifier input must be a regular non-symlink file: ${targetPath}`);
  }
}

function importedPackageName(specifier) {
  if (
    specifier.startsWith('.') ||
    specifier.startsWith('/') ||
    specifier.startsWith('#') ||
    BUILTIN_MODULES.has(specifier)
  ) {
    return undefined;
  }
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

function sourceImports(sourceText, fileName) {
  const sourceFile = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const imports = [];
  function record(moduleSpecifier) {
    if (moduleSpecifier !== undefined && ts.isStringLiteralLike(moduleSpecifier)) {
      imports.push(moduleSpecifier.text);
    }
  }
  function visit(node) {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      record(node.moduleSpecifier);
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1
    ) {
      record(node.arguments[0]);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      record(node.moduleReference.expression);
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return imports;
}

async function sourceFilesUnder(directory) {
  const files = [];
  async function walk(current) {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(current, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`Workspace source tree may not contain a symlink: ${entryPath}`);
      }
      if (entry.isDirectory()) {
        await walk(entryPath);
      } else if (entry.isFile() && /\.(?:cts|mts|ts|tsx)$/u.test(entry.name)) {
        files.push(entryPath);
      }
    }
  }
  await walk(directory);
  return files.sort();
}

async function workspaceDirectories(repositoryRoot) {
  const directories = [];
  for (const rootName of WORKSPACE_ROOT_NAMES) {
    const workspaceRoot = path.join(repositoryRoot, rootName);
    let entries;
    try {
      entries = await fs.readdir(workspaceRoot, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') {
        continue;
      }
      throw error;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        throw new Error(`Workspace root entry may not be a symlink: ${entry.name}`);
      }
      if (entry.isDirectory()) {
        directories.push(path.join(workspaceRoot, entry.name));
      }
    }
  }
  return directories.sort();
}

export async function verifyWorkspaceManifestDeclarations(repositoryRoot = REPOSITORY_ROOT) {
  const violations = [];
  for (const workspaceDirectory of await workspaceDirectories(repositoryRoot)) {
    const manifestPath = path.join(workspaceDirectory, 'package.json');
    const sourceDirectory = path.join(workspaceDirectory, 'src');
    const [manifestMetadata, sourceMetadata] = await Promise.all([
      fs.lstat(manifestPath),
      fs.lstat(sourceDirectory),
    ]);
    if (
      !manifestMetadata.isFile() ||
      manifestMetadata.isSymbolicLink() ||
      manifestMetadata.size > 64 * 1024 ||
      !sourceMetadata.isDirectory() ||
      sourceMetadata.isSymbolicLink()
    ) {
      throw new Error(`Workspace manifest/source layout is unsafe: ${workspaceDirectory}`);
    }
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    const declared = new Set([
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.optionalDependencies ?? {}),
      ...Object.keys(manifest.peerDependencies ?? {}),
    ]);
    for (const sourceFile of await sourceFilesUnder(sourceDirectory)) {
      const contents = await fs.readFile(sourceFile, 'utf8');
      for (const specifier of sourceImports(contents, sourceFile)) {
        const packageName = importedPackageName(specifier);
        if (packageName !== undefined && !declared.has(packageName)) {
          violations.push(
            `${path.relative(repositoryRoot, sourceFile)} imports undeclared ${JSON.stringify(packageName)} via ${JSON.stringify(specifier)}`,
          );
        }
      }
    }
  }
  if (violations.length > 0) {
    throw new Error(
      `Production workspace imports lack direct manifest declarations:\n${violations.join('\n')}`,
    );
  }
  process.stdout.write(
    '[boundaries] PASS every production workspace import is declared by its owning manifest.\n',
  );
}

async function ensureTemporaryRoot() {
  await fs.mkdir(TEMPORARY_ROOT, { mode: 0o700, recursive: true });
  const metadata = await fs.lstat(TEMPORARY_ROOT);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`Boundary fixture root must be a real directory: ${TEMPORARY_ROOT}`);
  }
}

async function runDependencyCruiser(cwd, targets) {
  const runtime = await verifyPinnedRuntime();
  const result = await runBoundedCommand(
    runtime.node,
    [DEPENDENCY_CRUISER_CLI, '--config', DEPENDENCY_CRUISER_CONFIG, ...targets],
    {
      cwd,
      env: process.env,
      maximumOutputBytes: MAXIMUM_OUTPUT_BYTES,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeoutMs: TIMEOUT_MS,
    },
  );
  return { ...result, output: `${result.stdout}${result.stderr}` };
}

async function writeNegativeFixture(fixtureRoot) {
  const packageSource = path.join(fixtureRoot, 'packages', 'observability', 'src');
  const privateApplicationSource = path.join(fixtureRoot, 'apps', 'admin', 'src');
  await Promise.all([
    fs.mkdir(packageSource, { mode: 0o700, recursive: true }),
    fs.mkdir(privateApplicationSource, { mode: 0o700, recursive: true }),
  ]);
  await Promise.all([
    fs.writeFile(
      path.join(packageSource, 'illegal.ts'),
      "import { privateValue } from '../../../apps/admin/src/private.js';\n\nexport const leakedValue = privateValue;\n",
      { encoding: 'utf8', flag: 'wx', mode: 0o600 },
    ),
    fs.writeFile(
      path.join(privateApplicationSource, 'private.ts'),
      "export const privateValue = 'must-not-cross';\n",
      { encoding: 'utf8', flag: 'wx', mode: 0o600 },
    ),
    fs.writeFile(
      path.join(fixtureRoot, 'tsconfig.json'),
      `${JSON.stringify(
        {
          compilerOptions: {
            module: 'NodeNext',
            moduleResolution: 'NodeNext',
            target: 'ES2023',
          },
          include: ['apps/**/*.ts', 'packages/**/*.ts'],
        },
        undefined,
        2,
      )}\n`,
      { encoding: 'utf8', flag: 'wx', mode: 0o600 },
    ),
  ]);
}

async function proveNegativeRules() {
  await ensureTemporaryRoot();
  const fixtureRoot = await fs.mkdtemp(path.join(TEMPORARY_ROOT, 'boundary-negative-'));
  assertInsideTemporaryRoot(fixtureRoot);
  try {
    await writeNegativeFixture(fixtureRoot);
    const result = await runDependencyCruiser(fixtureRoot, ['packages', 'apps']);
    const expectedRules = [
      'packages-do-not-depend-on-applications',
      'no-private-cross-workspace-imports-from-packages-observability',
    ];
    if (result.code === 0 || !expectedRules.every((rule) => result.output.includes(rule))) {
      throw new Error(
        `Boundary negative self-test did not reject the package-to-application private import with both named rules (${result.code === null ? `signal ${result.signal}` : `code ${String(result.code)}`}).\n${result.output}`,
      );
    }
    process.stdout.write(
      `[boundaries] PASS negative fixture rejected by ${expectedRules.join(' and ')}.\n`,
    );
  } finally {
    await fs.rm(fixtureRoot, { force: true, recursive: true });
  }
}

async function proveUndeclaredImportRefusal() {
  await ensureTemporaryRoot();
  const fixtureRoot = await fs.mkdtemp(path.join(TEMPORARY_ROOT, 'manifest-negative-'));
  assertInsideTemporaryRoot(fixtureRoot);
  try {
    const workspaceRoot = path.join(fixtureRoot, 'services', 'gateway');
    await fs.mkdir(path.join(workspaceRoot, 'src'), { mode: 0o700, recursive: true });
    await Promise.all([
      fs.writeFile(
        path.join(workspaceRoot, 'package.json'),
        `${JSON.stringify({ name: '@fixture/gateway', private: true, type: 'module' }, null, 2)}\n`,
        { encoding: 'utf8', flag: 'wx', mode: 0o600 },
      ),
      fs.writeFile(
        path.join(workspaceRoot, 'src', 'illegal.ts'),
        "import { assert } from 'vitest';\n\nexport const leakedTestDependency = assert;\n",
        { encoding: 'utf8', flag: 'wx', mode: 0o600 },
      ),
    ]);
    await expectManifestRefusal(fixtureRoot);
    process.stdout.write(
      '[boundaries] PASS negative fixture rejected a root-hoisted undeclared production import.\n',
    );
  } finally {
    await fs.rm(fixtureRoot, { force: true, recursive: true });
  }
}

async function proveLedgerExternalBoundary() {
  await ensureTemporaryRoot();
  const fixtureRoot = await fs.mkdtemp(path.join(TEMPORARY_ROOT, 'ledger-sdk-negative-'));
  assertInsideTemporaryRoot(fixtureRoot);
  try {
    const ledgerRoot = path.join(fixtureRoot, 'packages', 'ledger');
    await fs.mkdir(path.join(ledgerRoot, 'src'), { mode: 0o700, recursive: true });
    await Promise.all([
      fs.writeFile(
        path.join(ledgerRoot, 'package.json'),
        `${JSON.stringify(
          {
            dependencies: { zod: '4.4.3' },
            name: '@fixture/ledger',
            private: true,
            type: 'module',
          },
          null,
          2,
        )}\n`,
        { encoding: 'utf8', flag: 'wx', mode: 0o600 },
      ),
      fs.writeFile(
        path.join(ledgerRoot, 'src', 'illegal.ts'),
        "import { z } from 'zod';\n\nexport const forbiddenFrameworkSchema = z.string();\n",
        { encoding: 'utf8', flag: 'wx', mode: 0o600 },
      ),
      fs.writeFile(
        path.join(fixtureRoot, 'tsconfig.json'),
        `${JSON.stringify(
          {
            compilerOptions: {
              module: 'NodeNext',
              moduleResolution: 'NodeNext',
              target: 'ES2023',
            },
            include: ['packages/**/*.ts'],
          },
          null,
          2,
        )}\n`,
        { encoding: 'utf8', flag: 'wx', mode: 0o600 },
      ),
    ]);
    const result = await runDependencyCruiser(fixtureRoot, ['packages/ledger/src']);
    const expectedRule = 'ledger-domain-only-uses-admitted-database-driver';
    if (result.code === 0 || !result.output.includes(expectedRule)) {
      throw new Error(
        `Ledger external-dependency negative self-test did not trigger ${expectedRule}.\n${result.output}`,
      );
    }
    process.stdout.write(
      `[boundaries] PASS declared non-pg ledger dependency rejected by ${expectedRule}.\n`,
    );
  } finally {
    await fs.rm(fixtureRoot, { force: true, recursive: true });
  }
}

async function verifyLedgerDriverEdge() {
  const result = await runDependencyCruiser(REPOSITORY_ROOT, [
    '--output-type',
    'json',
    'packages/ledger/src',
  ]);
  if (result.code !== 0) {
    throw new Error(`The admitted pg ledger dependency edge was rejected.\n${result.output}`);
  }
  let cruise;
  try {
    cruise = JSON.parse(result.output);
  } catch (error) {
    throw new Error('Dependency-cruiser returned malformed JSON for the ledger edge assertion.', {
      cause: error,
    });
  }
  const healthModule = cruise.modules?.find(
    (module) => module.source === 'packages/ledger/src/health.ts',
  );
  const postgresEdge = healthModule?.dependencies?.find(
    (dependency) =>
      dependency.module === 'pg' &&
      dependency.resolved?.startsWith('node_modules/pg/') &&
      dependency.dependencyTypes?.includes('npm'),
  );
  if (!postgresEdge || postgresEdge.valid !== true) {
    throw new Error('The real ledger pg import was not visible as an allowed npm dependency edge.');
  }
  process.stdout.write(
    '[boundaries] PASS the real ledger pg import is visible and admitted as the sole database driver.\n',
  );
}

async function expectManifestRefusal(fixtureRoot) {
  try {
    await verifyWorkspaceManifestDeclarations(fixtureRoot);
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes('imports undeclared') &&
      error.message.includes('vitest')
    ) {
      return;
    }
    throw error;
  }
  throw new Error('Manifest boundary negative fixture was incorrectly accepted.');
}

async function verifyCurrentGraph() {
  const result = await runDependencyCruiser(REPOSITORY_ROOT, [
    'packages',
    'services',
    'apps',
    'tooling',
    'tests',
  ]);
  if (result.code !== 0) {
    throw new Error(
      `Current dependency graph failed boundary verification (${result.code === null ? `signal ${result.signal}` : `code ${String(result.code)}`}).\n${result.output}`,
    );
  }
  process.stdout.write(result.output);
  process.stdout.write(
    '[boundaries] PASS current dependency graph satisfies the enforced rules.\n',
  );
}

await Promise.all([
  assertRegularFile(DEPENDENCY_CRUISER_CLI),
  assertRegularFile(DEPENDENCY_CRUISER_CONFIG),
]);
await proveNegativeRules();
await proveUndeclaredImportRefusal();
await proveLedgerExternalBoundary();
await verifyWorkspaceManifestDeclarations();
await verifyLedgerDriverEdge();
await verifyCurrentGraph();
