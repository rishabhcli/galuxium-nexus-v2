/**
 * Schema migration, with the properties a monetary schema needs.
 *
 * - **Ordered and gapless.** Files are `NNNN_name.sql`; the runner refuses a gap,
 *   a duplicate number, or a name that does not match, because "which migrations
 *   ran" must be answerable without reading a directory listing by eye.
 * - **Checksummed.** Every applied migration's SHA-256 is recorded. An edit to an
 *   already-applied file is a hard refusal, not a silent no-op — a changed
 *   migration means the schema in front of you is not the schema the file
 *   describes, and for a ledger that is the difference between an audit and a
 *   guess.
 * - **One transaction per migration.** A migration either applied completely or
 *   not at all. PostgreSQL's transactional DDL makes this real rather than
 *   aspirational.
 * - **Serialised by advisory lock.** Two processes starting at once must not both
 *   apply `0001`. The lock is held for the whole run and released with the
 *   connection.
 * - **Never destructive.** The runner has no `down` path. Rolling back a ledger
 *   schema by dropping columns discards evidence; the recovery story is a
 *   forward migration plus a restore drill, both of which are Tier 11 work.
 */

import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import type { Client } from 'pg';

/** `pg_advisory_lock` key. Arbitrary but fixed; collides only with itself. */
const MIGRATION_LOCK_KEY = 6_141_602_026n;

const MIGRATION_FILE = /^(\d{4})_([a-z0-9]+(?:_[a-z0-9]+)*)\.sql$/u;

export type MigrationErrorCode =
  | 'MIGRATION_APPLIED_FILE_CHANGED'
  | 'MIGRATION_APPLIED_UNKNOWN_FILE'
  | 'MIGRATION_DIRECTORY_UNREADABLE'
  | 'MIGRATION_DUPLICATE_ORDINAL'
  | 'MIGRATION_EMPTY_FILE'
  | 'MIGRATION_LOCK_UNAVAILABLE'
  | 'MIGRATION_MALFORMED_FILENAME'
  | 'MIGRATION_ORDINAL_GAP';

export class MigrationError extends Error {
  readonly code: MigrationErrorCode;

  constructor(code: MigrationErrorCode, message: string) {
    super(message);
    this.name = 'MigrationError';
    this.code = code;
  }
}

export interface MigrationFile {
  readonly checksum: string;
  readonly name: string;
  readonly ordinal: number;
  readonly sql: string;
}

export interface MigrationOutcome {
  readonly alreadyApplied: readonly string[];
  readonly applied: readonly string[];
}

export function migrationsDirectory(): string {
  // `../..` from dist/src or src both land on the package root, so the same
  // resolution works compiled and under a test runner.
  return path.join(import.meta.dirname, '..', '..', 'migrations');
}

function checksumOf(sql: string): string {
  return createHash('sha256').update(sql, 'utf8').digest('hex');
}

/**
 * Read and validate the migration set as a whole.
 *
 * Validation is deliberately structural rather than a warning: an unexpected
 * filename means somebody's migration is about to be skipped without anyone
 * noticing, which is worse than refusing to start.
 */
export async function readMigrations(directory = migrationsDirectory()): Promise<MigrationFile[]> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    throw new MigrationError(
      'MIGRATION_DIRECTORY_UNREADABLE',
      `The migration directory could not be read: ${error instanceof Error ? error.name : 'unknown'}`,
    );
  }

  const candidates = names
    .filter((name) => name.endsWith('.sql'))
    .sort((left, right) => (left < right ? -1 : 1));
  const migrations: MigrationFile[] = [];
  const seen = new Set<number>();

  for (const name of candidates) {
    const match = MIGRATION_FILE.exec(name);
    if (match === null) {
      throw new MigrationError(
        'MIGRATION_MALFORMED_FILENAME',
        `A migration filename must be NNNN_lower_snake_case.sql: ${name}`,
      );
    }
    const ordinal = Number(match[1]);
    if (seen.has(ordinal)) {
      throw new MigrationError(
        'MIGRATION_DUPLICATE_ORDINAL',
        `Two migrations share ordinal ${String(ordinal)}`,
      );
    }
    seen.add(ordinal);
    const sql = await readFile(path.join(directory, name), 'utf8');
    if (sql.trim().length === 0) {
      throw new MigrationError('MIGRATION_EMPTY_FILE', `A migration file is empty: ${name}`);
    }
    migrations.push({ checksum: checksumOf(sql), name, ordinal, sql });
  }

  migrations.forEach((migration, index) => {
    if (migration.ordinal !== index + 1) {
      throw new MigrationError(
        'MIGRATION_ORDINAL_GAP',
        `Migration ordinals must start at 1 and have no gaps; found ${String(migration.ordinal)} at position ${String(index + 1)}`,
      );
    }
  });

  return migrations;
}

interface AppliedRow {
  readonly checksum: string;
  readonly name: string;
}

const CREATE_HISTORY = `
  CREATE SCHEMA IF NOT EXISTS ledger;
  CREATE TABLE IF NOT EXISTS ledger.schema_migrations (
    ordinal INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    checksum TEXT NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
`;

/**
 * Apply every migration not yet applied.
 *
 * `client` must be connected as the schema owner. The runtime role deliberately
 * cannot run this: it has no CREATE privilege, which is what keeps a request
 * path from altering the schema it is being constrained by.
 */
export async function migrate(
  client: Client,
  directory = migrationsDirectory(),
): Promise<MigrationOutcome> {
  const migrations = await readMigrations(directory);

  const locked = await client.query<{ readonly locked: boolean }>(
    'SELECT pg_try_advisory_lock($1) AS locked',
    [MIGRATION_LOCK_KEY.toString()],
  );
  if (locked.rows[0]?.locked !== true) {
    throw new MigrationError(
      'MIGRATION_LOCK_UNAVAILABLE',
      'Another process holds the migration lock; refusing to apply migrations concurrently',
    );
  }

  try {
    await client.query(CREATE_HISTORY);
    const history = await client.query<AppliedRow>(
      'SELECT name, checksum FROM ledger.schema_migrations ORDER BY ordinal',
    );
    const appliedByName = new Map(history.rows.map((row) => [row.name, row.checksum]));
    const known = new Set(migrations.map((migration) => migration.name));

    for (const name of appliedByName.keys()) {
      if (!known.has(name)) {
        // The database has run something this checkout does not contain. Applying
        // more on top would produce a schema neither the code nor the files
        // describe.
        throw new MigrationError(
          'MIGRATION_APPLIED_UNKNOWN_FILE',
          `The database has applied a migration absent from this checkout: ${name}`,
        );
      }
    }

    const applied: string[] = [];
    const alreadyApplied: string[] = [];

    for (const migration of migrations) {
      const recordedChecksum = appliedByName.get(migration.name);
      if (recordedChecksum !== undefined) {
        if (recordedChecksum !== migration.checksum) {
          throw new MigrationError(
            'MIGRATION_APPLIED_FILE_CHANGED',
            `An already-applied migration has been edited: ${migration.name}`,
          );
        }
        alreadyApplied.push(migration.name);
        continue;
      }

      await client.query('BEGIN');
      try {
        await client.query(migration.sql);
        await client.query(
          'INSERT INTO ledger.schema_migrations (ordinal, name, checksum) VALUES ($1, $2, $3)',
          [migration.ordinal, migration.name, migration.checksum],
        );
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
      applied.push(migration.name);
    }

    return { alreadyApplied, applied };
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY.toString()]);
  }
}
