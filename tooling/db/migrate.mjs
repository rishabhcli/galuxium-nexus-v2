/**
 * Apply the ledger schema migrations.
 *
 * Runs as the schema **owner**, not as the runtime role. That separation is the
 * point: the runtime role has no CREATE privilege, so no request path can alter
 * the schema that constrains it. This script is therefore an operator command,
 * never something a service invokes.
 *
 * Connection parameters come from the repository's own local development
 * contract in `tooling/dev/constants.mjs` by default, and each one can be
 * overridden by an explicitly named environment variable for a non-local
 * database. No undeclared variable is read, and the password is only ever read
 * from a file so it cannot land in a process listing or a shell history.
 *
 *   LEDGER_DB_HOST                 default 127.0.0.1
 *   LEDGER_DB_PORT                 default 4165 (this repository's exclusive block)
 *   LEDGER_DB_NAME                 default galuxium_nexus_v2
 *   LEDGER_DB_OWNER                default galuxium_nexus_v2_owner
 *   LEDGER_DB_OWNER_PASSWORD_FILE  default .dev/secrets/postgres-owner-password
 */

import { readFile } from 'node:fs/promises';

import pg from 'pg';

import { migrate } from '../../packages/ledger/dist/src/migrate.js';
import { EXPECTED_PORTS, HOST, POSTGRES } from '../dev/constants.mjs';

const CONNECT_TIMEOUT_MS = 10_000;
const STATEMENT_TIMEOUT_MS = 120_000;

function requiredPort(value) {
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`LEDGER_DB_PORT must be a TCP port; received ${String(value)}`);
  }
  return port;
}

async function readPassword(passwordFile) {
  const password = (await readFile(passwordFile, 'utf8')).trim();
  if (password.length === 0) {
    throw new Error('The database owner password file is empty.');
  }
  return password;
}

async function main() {
  const host = process.env['LEDGER_DB_HOST'] ?? HOST;
  const port = requiredPort(process.env['LEDGER_DB_PORT'] ?? EXPECTED_PORTS.PORT_5);
  const database = process.env['LEDGER_DB_NAME'] ?? POSTGRES.database;
  const user = process.env['LEDGER_DB_OWNER'] ?? POSTGRES.ownerRole;
  const passwordFile = process.env['LEDGER_DB_OWNER_PASSWORD_FILE'] ?? POSTGRES.ownerPasswordFile;

  const client = new pg.Client({
    application_name: 'galuxium-nexus-v2-migrate',
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    database,
    host,
    password: await readPassword(passwordFile),
    port,
    statement_timeout: STATEMENT_TIMEOUT_MS,
    user,
  });

  await client.connect();
  try {
    const { applied, alreadyApplied } = await migrate(client);
    for (const name of alreadyApplied) {
      process.stdout.write(`[db:migrate] UNCHANGED ${name}\n`);
    }
    for (const name of applied) {
      process.stdout.write(`[db:migrate] APPLIED ${name}\n`);
    }
    process.stdout.write(
      `[db:migrate] PASS ${String(applied.length)} applied, ${String(alreadyApplied.length)} already present on ${host}:${String(port)}/${database} as ${user}.\n`,
    );
    process.stdout.write(
      '[db:migrate] Scope: schema only; this asserts no product behaviour, release gate, or production state.\n',
    );
  } finally {
    await client.end();
  }
}

try {
  await main();
} catch (error) {
  // The message may name a constraint or a migration file, never a credential:
  // the password is read from a file and never interpolated into a query.
  process.stderr.write(
    `[db:migrate] FAILED ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}\n`,
  );
  process.exitCode = 1;
}
