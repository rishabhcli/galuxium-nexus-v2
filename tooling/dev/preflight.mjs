import fs from 'node:fs/promises';

import {
  POSTGRES,
  REPOSITORY_ROOT,
  REQUIRED_NODE_VERSION,
  REQUIRED_NPM_VERSION,
  REQUIRED_POSTGRES_VERSION,
  REQUIRED_REDIS_VERSION,
  REQUIRED_TYPESCRIPT_VERSION,
} from './constants.mjs';
import { isMain, runCli } from './cli.mjs';
import { execute, findExecutable } from './command.mjs';
import { readPortConfiguration } from './config.mjs';
import { DevContractError } from './errors.mjs';
import { ensureDevTree, ensureSecretFile } from './filesystem.mjs';
import { auditBlockListeners } from './listeners.mjs';

/**
 * Escapes every regular-expression metacharacter in a literal version string so
 * a pinned version can never match a looser one. `.` must be escaped for all
 * occurrences: a partially escaped `16.14.1` would let the unescaped dot match
 * any character and silently admit a foreign build.
 */
export function escapeRegExpLiteral(literal) {
  return literal.replaceAll(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

const POSTGRES_VERSION_PATTERN = new RegExp(
  `PostgreSQL\\) ${escapeRegExpLiteral(REQUIRED_POSTGRES_VERSION)}(?:\\s+\\([^\\r\\n]*\\))?$`,
  'u',
);

const POSTGRES_TOOL_NAMES = Object.freeze(['postgres', 'initdb', 'createdb', 'psql', 'pg_isready']);

const TOOL_VERSION_CHECKS = Object.freeze([
  Object.freeze({
    args: ['--version'],
    name: 'npm',
    pattern: new RegExp(`^${escapeRegExpLiteral(REQUIRED_NPM_VERSION)}\\s*$`, 'u'),
  }),
  Object.freeze({
    args: ['--version'],
    name: 'tsc',
    pattern: new RegExp(
      `^Version\\s+${escapeRegExpLiteral(REQUIRED_TYPESCRIPT_VERSION)}\\s*$`,
      'u',
    ),
  }),
  ...POSTGRES_TOOL_NAMES.map((name) =>
    Object.freeze({ args: ['--version'], name, pattern: POSTGRES_VERSION_PATTERN }),
  ),
  Object.freeze({
    args: ['--version'],
    name: 'redis-server',
    pattern: new RegExp(
      `^Redis server v=${escapeRegExpLiteral(REQUIRED_REDIS_VERSION)}(?:\\s|$)`,
      'u',
    ),
  }),
  Object.freeze({
    args: ['--version'],
    name: 'redis-cli',
    pattern: new RegExp(`^redis-cli ${escapeRegExpLiteral(REQUIRED_REDIS_VERSION)}(?:\\s|$)`, 'u'),
  }),
]);

export async function verifyRepositoryIsolation() {
  const git = await findExecutable('git');
  const result = await execute(git, ['rev-parse', '--show-toplevel'], {
    cwd: REPOSITORY_ROOT,
  });
  let actualRoot;
  try {
    actualRoot = await fs.realpath(result.stdout.trim());
  } catch (error) {
    throw new DevContractError(
      'DEV_REPOSITORY_ROOT_INVALID',
      'Git returned a repository root that cannot be resolved.',
      undefined,
      { cause: error },
    );
  }
  const expectedRoot = await fs.realpath(REPOSITORY_ROOT);
  if (actualRoot !== expectedRoot) {
    throw new DevContractError(
      'DEV_WRONG_REPOSITORY',
      `Dev tooling resolved ${actualRoot}, expected ${expectedRoot}.`,
    );
  }

  const ignored = await execute(git, ['check-ignore', '-q', '--', '.dev/.preflight-probe'], {
    allowExitCodes: [0, 1],
    cwd: REPOSITORY_ROOT,
  });
  if (ignored.exitCode !== 0) {
    throw new DevContractError(
      'DEV_DIRECTORY_NOT_IGNORED',
      '.dev/ is not git-ignored; refusing to create runtime state that could be committed.',
    );
  }
}

export async function verifyToolchain() {
  if (process.versions.node !== REQUIRED_NODE_VERSION) {
    throw new DevContractError(
      'DEV_NODE_VERSION',
      `Node ${REQUIRED_NODE_VERSION} is required; current runtime is ${process.versions.node}.`,
    );
  }

  const tools = {};
  for (const check of TOOL_VERSION_CHECKS) {
    const executable = await findExecutable(check.name);
    const result = await execute(executable, check.args);
    const versionOutput = `${result.stdout}\n${result.stderr}`.trim();
    if (!check.pattern.test(versionOutput)) {
      throw new DevContractError(
        'DEV_TOOL_VERSION',
        `${check.name} does not match the required version.`,
        { required: check.pattern.source, received: versionOutput },
      );
    }
    tools[check.name] = executable;
  }
  tools.git = await findExecutable('git');
  tools.lsof = await findExecutable('lsof');
  tools.ps = await findExecutable('ps');
  return Object.freeze(tools);
}

export async function preflight({ quiet = false } = {}) {
  await ensureDevTree();
  await verifyRepositoryIsolation();
  const [ports, tools] = await Promise.all([
    readPortConfiguration(),
    verifyToolchain(),
    ensureSecretFile(POSTGRES.passwordFile),
    ensureSecretFile(POSTGRES.ownerPasswordFile),
  ]);
  const listenerAudit = await auditBlockListeners();

  if (!quiet) {
    process.stdout.write(
      `[dev:preflight] PASS repository=${REPOSITORY_ROOT} node=${process.versions.node} ports=4160-4169 listeners=${listenerAudit.listeners.length}\n`,
    );
    process.stdout.write(
      '[dev:preflight] Scope: local runtime isolation only; no product or production-readiness claim is asserted.\n',
    );
  }
  return { listenerAudit, ports, tools };
}

if (isMain(import.meta.url)) {
  await runCli(() => preflight());
}
