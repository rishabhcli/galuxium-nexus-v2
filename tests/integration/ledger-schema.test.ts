/**
 * The ledger schema and the reservation path, against the real PostgreSQL.
 *
 * Nothing here is mocked. A constraint that is asserted to exist but never
 * executed against the engine is worth nothing: PostgreSQL decides whether
 * `CHECK (credited - settled - reserved >= 0)` actually refuses, not a unit test
 * that read the migration file.
 *
 * The concurrency case is the first form of release gate G1. It is the only test
 * in this file whose failure would mean the product does not work.
 */

import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { Client, Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  type IdempotencyKey,
  type PriceBookVersion,
  type ReserveOutcome,
  type ReservationId,
  type TenantScope,
  attemptId,
  checkLedgerInvariant,
  idempotencyKey,
  instantFromIsoUtc,
  markDispatched,
  migrate,
  nonNegativeNanodollars,
  positiveNanodollars,
  priceBookVersion,
  readBudget,
  releaseReservation,
  reserveBudget,
  reservationId,
  settleReservation,
  tenantScope,
} from '@galuxium-nexus-v2/ledger';

const HOST = '127.0.0.1';
const PORT = 4165;
const DATABASE = 'galuxium_nexus_v2';
const OWNER_ROLE = 'galuxium_nexus_v2_owner';
const RUNTIME_ROLE = 'galuxium_nexus_v2';
const REPOSITORY_ROOT = path.resolve(import.meta.dirname, '..', '..');
const PRICE_VERSION: PriceBookVersion = priceBookVersion('2026-08-10.1');
const NOW = instantFromIsoUtc('2026-08-10T20:00:00.000000Z');
const EXPIRES_AT = instantFromIsoUtc('2026-08-10T20:01:00.000000Z');

async function secret(name: string): Promise<string> {
  return (await readFile(path.join(REPOSITORY_ROOT, '.dev', 'secrets', name), 'utf8')).trim();
}

// Optional, because a connection failure in `beforeAll` must not make teardown
// throw a second, misleading error on top of the real one.
let ownerPool: Pool | undefined;
let runtimePool: Pool | undefined;
const createdTenants: string[] = [];

function owner(): Pool {
  if (ownerPool === undefined) {
    throw new Error('the owner pool was never established; setup failed earlier');
  }
  return ownerPool;
}

function runtime(): Pool {
  if (runtimePool === undefined) {
    throw new Error('the runtime pool was never established; setup failed earlier');
  }
  return runtimePool;
}

/** A fresh tenant with its five accounts, a budget, and a funding entry. */
async function seedTenant(creditedNanodollars: bigint): Promise<TenantScope> {
  const tenantId = randomUUID();
  createdTenants.push(tenantId);
  const client = await owner().connect();
  try {
    await client.query('BEGIN');
    await client.query(
      "INSERT INTO ledger.tenants (id, status, created_at) VALUES ($1, 'active', now())",
      [tenantId],
    );
    const accounts = new Map<string, string>();
    for (const kind of ['funding', 'available', 'reserved', 'settled', 'unreconciled_overspend']) {
      const id = randomUUID();
      accounts.set(kind, id);
      await client.query(
        'INSERT INTO ledger.accounts (id, tenant_id, kind, created_at) VALUES ($1, $2, $3, now())',
        [id, tenantId, kind],
      );
    }
    await client.query(
      `INSERT INTO ledger.budgets
         (tenant_id, credited_nanodollars, settled_nanodollars, reserved_nanodollars,
          overspend_nanodollars, max_output_tokens, reservation_ttl_seconds, updated_at)
       VALUES ($1, $2::NUMERIC, 0, 0, 0, 4096, 60, now())`,
      [tenantId, creditedNanodollars.toString(10)],
    );
    await client.query(
      `INSERT INTO ledger.entries
         (id, tenant_id, debit_account_id, credit_account_id, amount_nanodollars,
          kind, occurred_at, recorded_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4::NUMERIC, 'credit_funding', now(), now())`,
      [
        tenantId,
        accounts.get('funding'),
        accounts.get('available'),
        creditedNanodollars.toString(10),
      ],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  return tenantScope(tenantId);
}

async function withRuntimeClient<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await runtime().connect();
  try {
    return await operation(client);
  } finally {
    client.release();
  }
}

async function ownerQuery<T extends Record<string, unknown>>(
  sql: string,
  values: readonly unknown[] = [],
): Promise<readonly T[]> {
  const result = await owner().query<T>(sql, [...values]);
  return result.rows;
}

/** The refusal a statement produced, as a comparable value. */
async function refusalOf(
  sql: string,
  values: readonly unknown[] = [],
): Promise<{ readonly code?: string; readonly constraint?: string; readonly ok: boolean }> {
  try {
    await owner().query(sql, [...values]);
    return { ok: true };
  } catch (error) {
    const record = error as { code?: unknown; constraint?: unknown };
    return {
      ...(typeof record.code === 'string' ? { code: record.code } : {}),
      ...(typeof record.constraint === 'string' ? { constraint: record.constraint } : {}),
      ok: false,
    };
  }
}

beforeAll(async () => {
  const [ownerPassword, runtimePassword] = await Promise.all([
    secret('postgres-owner-password'),
    secret('postgres-password'),
  ]);

  const migrationClient = new Client({
    application_name: 'galuxium-nexus-v2-integration-migrate',
    database: DATABASE,
    host: HOST,
    password: ownerPassword,
    port: PORT,
    user: OWNER_ROLE,
  });
  await migrationClient.connect();
  try {
    await migrate(migrationClient, path.join(REPOSITORY_ROOT, 'packages', 'ledger', 'migrations'));
  } finally {
    await migrationClient.end();
  }

  ownerPool = new Pool({
    application_name: 'galuxium-nexus-v2-integration-owner',
    database: DATABASE,
    host: HOST,
    max: 4,
    password: ownerPassword,
    port: PORT,
    user: OWNER_ROLE,
  });
  runtimePool = new Pool({
    application_name: 'galuxium-nexus-v2-integration-runtime',
    database: DATABASE,
    host: HOST,
    // Above the concurrency the gate exercises, so the gate measures the ledger
    // rather than the pool.
    max: 16,
    password: runtimePassword,
    port: PORT,
    user: RUNTIME_ROLE,
  });

  await owner().query(
    `INSERT INTO ledger.price_book_versions (version, published_at, rates, content_sha256)
     VALUES ($1, now(), '{}'::JSONB, repeat('a', 64))
     ON CONFLICT (version) DO NOTHING`,
    [PRICE_VERSION],
  );
}, 60_000);

afterAll(async () => {
  // Guarded, because a failure in `beforeAll` — an unavailable database, most
  // likely — leaves these undefined, and a teardown that then throws replaces
  // the real diagnosis with a TypeError about reading `end` of undefined.
  if (ownerPool !== undefined) {
    // Remove only what this suite created, by identity. Never a blanket delete:
    // this database is shared with the running local topology.
    for (const tenantId of createdTenants) {
      await owner().query('DELETE FROM ledger.entries WHERE tenant_id = $1', [tenantId]);
      await owner().query('DELETE FROM ledger.reservations WHERE tenant_id = $1', [tenantId]);
      await owner().query('DELETE FROM ledger.budgets WHERE tenant_id = $1', [tenantId]);
      await owner().query('DELETE FROM ledger.accounts WHERE tenant_id = $1', [tenantId]);
      await owner().query('DELETE FROM ledger.tenants WHERE id = $1', [tenantId]);
    }
    await ownerPool.end();
  }
  if (runtimePool !== undefined) {
    await runtimePool.end();
  }
}, 60_000);

describe('migration', () => {
  it('is idempotent and records a checksum for what it applied', async () => {
    const rows = await ownerQuery<{ readonly checksum: string; readonly name: string }>(
      'SELECT name, checksum FROM ledger.schema_migrations ORDER BY ordinal',
    );
    expect(rows.map((row) => row.name)).toStrictEqual(['0001_double_entry_ledger.sql']);
    expect(rows[0]?.checksum).toMatch(/^[0-9a-f]{64}$/u);
  });
});

describe('I2 as a database constraint: available budget never goes negative', () => {
  it('refuses an over-reservation and admits the exact boundary', async () => {
    const scope = await seedTenant(1_000_000_000n);

    expect(
      await refusalOf(
        'UPDATE ledger.budgets SET reserved_nanodollars = $2::NUMERIC WHERE tenant_id = $1',
        [scope.tenantId, '1000000001'],
      ),
    ).toStrictEqual({
      code: '23514',
      constraint: 'budgets_available_never_negative',
      ok: false,
    });

    expect(
      await refusalOf(
        'UPDATE ledger.budgets SET reserved_nanodollars = $2::NUMERIC WHERE tenant_id = $1',
        [scope.tenantId, '1000000000'],
      ),
    ).toStrictEqual({ ok: true });

    await owner().query('UPDATE ledger.budgets SET reserved_nanodollars = 0 WHERE tenant_id = $1', [
      scope.tenantId,
    ]);
  });

  it('refuses a negative amount at the domain level rather than storing it', async () => {
    const scope = await seedTenant(1_000_000_000n);
    expect(
      await refusalOf('UPDATE ledger.budgets SET credited_nanodollars = -1 WHERE tenant_id = $1', [
        scope.tenantId,
      ]),
    ).toMatchObject({ code: '23514', ok: false });
  });
});

describe('I3 and I4 as a database constraint: terminal states partition exactly', () => {
  it('refuses a terminal reservation whose parts do not sum to the reserved amount', async () => {
    const scope = await seedTenant(1_000_000_000n);
    const id = randomUUID();
    await owner().query(
      `INSERT INTO ledger.reservations
         (id, tenant_id, attempt_id, idempotency_key, price_book_version,
          reserved_nanodollars, status, fence, created_at, expires_at, dispatched_at)
       VALUES ($1, $2, $3, $4, $5, 500000000, 'dispatched', 1, now(), now() + interval '60 seconds', now())`,
      [id, scope.tenantId, randomUUID(), `key-${id.slice(0, 8)}`, PRICE_VERSION],
    );

    expect(
      await refusalOf(
        `UPDATE ledger.reservations
            SET status = 'settled', settled_nanodollars = 1, released_nanodollars = 1,
                resolved_at = now()
          WHERE id = $1`,
        [id],
      ),
    ).toStrictEqual({ code: '23514', constraint: 'reservations_status_shape', ok: false });

    expect(
      await refusalOf(
        `UPDATE ledger.reservations
            SET status = 'settled', settled_nanodollars = 200000000,
                released_nanodollars = 300000000, resolved_at = now()
          WHERE id = $1`,
        [id],
      ),
    ).toStrictEqual({ ok: true });
  });

  it('refuses a non-terminal reservation that claims to have settled something', async () => {
    const scope = await seedTenant(1_000_000_000n);
    const id = randomUUID();
    expect(
      await refusalOf(
        `INSERT INTO ledger.reservations
           (id, tenant_id, attempt_id, idempotency_key, price_book_version,
            reserved_nanodollars, status, fence, created_at, expires_at, settled_nanodollars)
         VALUES ($1, $2, $3, $4, $5, 100, 'open', 1, now(), now() + interval '60 seconds', 50)`,
        [id, scope.tenantId, randomUUID(), `key-${id.slice(0, 8)}`, PRICE_VERSION],
      ),
    ).toStrictEqual({ code: '23514', constraint: 'reservations_status_shape', ok: false });
  });

  it('refuses an expiry that precedes creation', async () => {
    const scope = await seedTenant(1_000_000_000n);
    const id = randomUUID();
    expect(
      await refusalOf(
        `INSERT INTO ledger.reservations
           (id, tenant_id, attempt_id, idempotency_key, price_book_version,
            reserved_nanodollars, status, fence, created_at, expires_at)
         VALUES ($1, $2, $3, $4, $5, 100, 'open', 1, now(), now() - interval '1 second')`,
        [id, scope.tenantId, randomUUID(), `key-${id.slice(0, 8)}`, PRICE_VERSION],
      ),
    ).toStrictEqual({
      code: '23514',
      constraint: 'reservations_expire_after_creation',
      ok: false,
    });
  });
});

describe('I7 at the storage layer: a cross-tenant entry is unrepresentable', () => {
  it('refuses an entry naming an account that belongs to another tenant', async () => {
    const [first, second] = await Promise.all([
      seedTenant(1_000_000_000n),
      seedTenant(1_000_000_000n),
    ]);
    const [firstAvailable] = await ownerQuery<{ readonly id: string }>(
      "SELECT id FROM ledger.accounts WHERE tenant_id = $1 AND kind = 'available'",
      [first.tenantId],
    );
    const [secondAvailable] = await ownerQuery<{ readonly id: string }>(
      "SELECT id FROM ledger.accounts WHERE tenant_id = $1 AND kind = 'available'",
      [second.tenantId],
    );

    expect(
      await refusalOf(
        `INSERT INTO ledger.entries
           (id, tenant_id, debit_account_id, credit_account_id, amount_nanodollars,
            kind, occurred_at, recorded_at)
         VALUES (gen_random_uuid(), $1, $2, $3, 100, 'credit_funding', now(), now())`,
        [first.tenantId, firstAvailable?.id, secondAvailable?.id],
      ),
    ).toStrictEqual({
      code: '23503',
      constraint: 'entries_credit_account_is_tenant_scoped',
      ok: false,
    });
  });

  it('refuses an entry whose two sides are the same account', async () => {
    const scope = await seedTenant(1_000_000_000n);
    const [available] = await ownerQuery<{ readonly id: string }>(
      "SELECT id FROM ledger.accounts WHERE tenant_id = $1 AND kind = 'available'",
      [scope.tenantId],
    );
    expect(
      await refusalOf(
        `INSERT INTO ledger.entries
           (id, tenant_id, debit_account_id, credit_account_id, amount_nanodollars,
            kind, occurred_at, recorded_at)
         VALUES (gen_random_uuid(), $1, $2, $2, 100, 'credit_funding', now(), now())`,
        [scope.tenantId, available?.id],
      ),
    ).toStrictEqual({ code: '23514', constraint: 'entries_two_distinct_sides', ok: false });
  });
});

describe('I5 at the storage layer: the authorizing price version cannot be removed', () => {
  it('refuses deleting a price book version an attempt depends on', async () => {
    const scope = await seedTenant(1_000_000_000n);
    const id = randomUUID();
    await owner().query(
      `INSERT INTO ledger.reservations
         (id, tenant_id, attempt_id, idempotency_key, price_book_version,
          reserved_nanodollars, status, fence, created_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, 100, 'open', 1, now(), now() + interval '60 seconds')`,
      [id, scope.tenantId, randomUUID(), `key-${id.slice(0, 8)}`, PRICE_VERSION],
    );
    expect(
      await refusalOf('DELETE FROM ledger.price_book_versions WHERE version = $1', [PRICE_VERSION]),
    ).toMatchObject({ code: '23503', ok: false });
  });

  it('refuses an unversioned or malformed price book reference', async () => {
    const scope = await seedTenant(1_000_000_000n);
    const id = randomUUID();
    expect(
      await refusalOf(
        `INSERT INTO ledger.reservations
           (id, tenant_id, attempt_id, idempotency_key, price_book_version,
            reserved_nanodollars, status, fence, created_at, expires_at)
         VALUES ($1, $2, $3, $4, 'latest', 100, 'open', 1, now(), now() + interval '60 seconds')`,
        [id, scope.tenantId, randomUUID(), `key-${id.slice(0, 8)}`],
      ),
    ).toMatchObject({ ok: false });
  });
});

describe('row-level security and grants', () => {
  it('shows an unscoped runtime connection zero rows rather than every row', async () => {
    await seedTenant(1_000_000_000n);
    const counts = await withRuntimeClient(async (client) => {
      const result = await client.query<{ readonly count: string }>(
        'SELECT count(*)::TEXT AS count FROM ledger.tenants',
      );
      return result.rows[0]?.count;
    });
    expect(counts).toBe('0');
  });

  it('shows a scoped runtime connection exactly its own tenant', async () => {
    const [first, second] = await Promise.all([
      seedTenant(1_000_000_000n),
      seedTenant(1_000_000_000n),
    ]);
    const visible = await withRuntimeClient(async (client) => {
      await client.query('SELECT set_config($1, $2, false)', ['app.tenant_id', first.tenantId]);
      const result = await client.query<{ readonly id: string }>('SELECT id FROM ledger.tenants');
      return result.rows.map((row) => row.id);
    });
    expect(visible).toStrictEqual([first.tenantId]);
    expect(visible).not.toContain(second.tenantId);
  });

  it('refuses the runtime role every append-only violation and every schema change', async () => {
    const scope = await seedTenant(1_000_000_000n);
    const outcomes = await withRuntimeClient(async (client) => {
      await client.query('SELECT set_config($1, $2, false)', ['app.tenant_id', scope.tenantId]);
      const attempts = [
        'DELETE FROM ledger.entries',
        'UPDATE ledger.entries SET amount_nanodollars = 1',
        'DELETE FROM ledger.reservations',
        'CREATE TABLE ledger.unauthorized (x INTEGER)',
      ];
      const results: string[] = [];
      for (const sql of attempts) {
        try {
          await client.query(sql);
          results.push('permitted');
        } catch (error) {
          results.push((error as { code?: string }).code ?? 'unknown');
        }
      }
      return results;
    });
    // 42501 is insufficient_privilege.
    expect(outcomes).toStrictEqual(['42501', '42501', '42501', '42501']);
  });
});

describe('release gate G1: zero over-authorization under concurrency', () => {
  it('admits exactly the affordable number of 50 simultaneous reservations', async () => {
    // Five affordable reservations, fifty simultaneous requests. A gateway that
    // reads a counter and then calls would admit far more than five here; the
    // conditional single-statement debit admits exactly five.
    const unitAmount = 10_000_000n;
    const affordable = 5;
    const concurrency = 50;
    const scope = await seedTenant(unitAmount * BigInt(affordable));

    const outcomes = await Promise.all(
      Array.from({ length: concurrency }, async (_, index) =>
        withRuntimeClient(async (client) =>
          reserveBudget(client, scope, {
            amount: positiveNanodollars(unitAmount),
            attemptId: attemptId(randomUUID()),
            expiresAt: EXPIRES_AT,
            idempotencyKey: idempotencyKey(`g1-${String(index).padStart(4, '0')}-${randomUUID()}`),
            now: NOW,
            priceBookVersion: PRICE_VERSION,
            reservationId: reservationId(randomUUID()),
          }),
        ),
      ),
    );

    const reserved = outcomes.filter((outcome: ReserveOutcome) => outcome.outcome === 'reserved');
    const refused = outcomes.filter(
      (outcome: ReserveOutcome) => outcome.outcome === 'insufficient_budget',
    );

    expect(reserved).toHaveLength(affordable);
    expect(refused).toHaveLength(concurrency - affordable);

    const budget = await withRuntimeClient(async (client) => readBudget(client, scope));
    expect(budget.reservedNanodollars).toBe(unitAmount * BigInt(affordable));
    expect(budget.availableNanodollars).toBe(0n);

    // Over-authorization count, stated as a number rather than implied: the sum
    // authorized must equal the credited amount exactly, never exceed it.
    const authorized = budget.reservedNanodollars + budget.settledNanodollars;
    expect(authorized).toBe(budget.creditedNanodollars);
    expect(authorized > budget.creditedNanodollars).toBe(false);

    const client = await owner().connect();
    try {
      const report = await checkLedgerInvariant(client, scope.tenantId);
      expect(report.holds).toBe(true);
      expect(report.derivedReservedNanodollars).toBe(report.recordedReservedNanodollars);
    } finally {
      client.release();
    }
  }, 60_000);

  it('debits once when the same idempotency key arrives twenty times at once', async () => {
    const scope = await seedTenant(1_000_000_000n);
    const key: IdempotencyKey = idempotencyKey(`idem-${randomUUID()}`);
    const target: ReservationId = reservationId(randomUUID());

    const outcomes = await Promise.all(
      Array.from({ length: 20 }, async () =>
        withRuntimeClient(async (client) =>
          reserveBudget(client, scope, {
            amount: positiveNanodollars(100_000_000n),
            attemptId: attemptId(randomUUID()),
            expiresAt: EXPIRES_AT,
            idempotencyKey: key,
            now: NOW,
            priceBookVersion: PRICE_VERSION,
            reservationId: target,
          }),
        ),
      ),
    );

    const ids = new Set(
      outcomes.map((outcome: ReserveOutcome) =>
        outcome.outcome === 'insufficient_budget' ? 'refused' : outcome.reservationId,
      ),
    );
    expect(ids).toStrictEqual(new Set([target]));

    const budget = await withRuntimeClient(async (client) => readBudget(client, scope));
    expect(budget.reservedNanodollars).toBe(100_000_000n);

    const rows = await ownerQuery<{ readonly count: string }>(
      'SELECT count(*)::TEXT AS count FROM ledger.reservations WHERE tenant_id = $1',
      [scope.tenantId],
    );
    expect(rows[0]?.count).toBe('1');
  }, 60_000);
});

describe('settlement moves the hot row and the audit trail together', () => {
  it('settles once, releases the remainder, and reports a repeat as already settled', async () => {
    const scope = await seedTenant(1_000_000_000n);
    const target = reservationId(randomUUID());

    const reserveOutcome = await withRuntimeClient(async (client) =>
      reserveBudget(client, scope, {
        amount: positiveNanodollars(500_000_000n),
        attemptId: attemptId(randomUUID()),
        expiresAt: EXPIRES_AT,
        idempotencyKey: idempotencyKey(`settle-${randomUUID()}`),
        now: NOW,
        priceBookVersion: PRICE_VERSION,
        reservationId: target,
      }),
    );
    expect(reserveOutcome.outcome).toBe('reserved');

    expect(
      await withRuntimeClient(async (client) => markDispatched(client, scope, target, NOW)),
    ).toBe(true);

    const settled = await withRuntimeClient(async (client) =>
      settleReservation(client, scope, {
        now: NOW,
        reservationId: target,
        settledAmount: nonNegativeNanodollars(120_000_000n),
      }),
    );
    expect(settled).toStrictEqual({
      outcome: 'settled',
      releasedNanodollars: 380_000_000n,
      settledNanodollars: 120_000_000n,
    });

    const budget = await withRuntimeClient(async (client) => readBudget(client, scope));
    expect(budget.reservedNanodollars).toBe(0n);
    expect(budget.settledNanodollars).toBe(120_000_000n);
    expect(budget.availableNanodollars).toBe(880_000_000n);

    const repeat = await withRuntimeClient(async (client) =>
      settleReservation(client, scope, {
        now: NOW,
        reservationId: target,
        settledAmount: nonNegativeNanodollars(120_000_000n),
      }),
    );
    expect(repeat).toStrictEqual({ outcome: 'already_settled' });

    const after = await withRuntimeClient(async (client) => readBudget(client, scope));
    expect(after.settledNanodollars).toBe(120_000_000n);

    const client = await owner().connect();
    try {
      expect((await checkLedgerInvariant(client, scope.tenantId)).holds).toBe(true);
    } finally {
      client.release();
    }
  }, 60_000);

  it('refuses to settle an attempt that was never dispatched', async () => {
    const scope = await seedTenant(1_000_000_000n);
    const target = reservationId(randomUUID());
    await withRuntimeClient(async (client) =>
      reserveBudget(client, scope, {
        amount: positiveNanodollars(100_000_000n),
        attemptId: attemptId(randomUUID()),
        expiresAt: EXPIRES_AT,
        idempotencyKey: idempotencyKey(`nodispatch-${randomUUID()}`),
        now: NOW,
        priceBookVersion: PRICE_VERSION,
        reservationId: target,
      }),
    );
    const outcome = await withRuntimeClient(async (client) =>
      settleReservation(client, scope, {
        now: NOW,
        reservationId: target,
        settledAmount: nonNegativeNanodollars(1n),
      }),
    );
    expect(outcome).toMatchObject({ outcome: 'refused' });
  }, 60_000);

  it('returns the whole hold to available when an undispatched reservation is released', async () => {
    const scope = await seedTenant(1_000_000_000n);
    const target = reservationId(randomUUID());
    await withRuntimeClient(async (client) =>
      reserveBudget(client, scope, {
        amount: positiveNanodollars(250_000_000n),
        attemptId: attemptId(randomUUID()),
        expiresAt: EXPIRES_AT,
        idempotencyKey: idempotencyKey(`release-${randomUUID()}`),
        now: NOW,
        priceBookVersion: PRICE_VERSION,
        reservationId: target,
      }),
    );

    expect(
      await withRuntimeClient(async (client) =>
        releaseReservation(client, scope, target, 'expired_before_dispatch', NOW),
      ),
    ).toStrictEqual({ outcome: 'released', releasedNanodollars: 250_000_000n });

    const budget = await withRuntimeClient(async (client) => readBudget(client, scope));
    expect(budget.availableNanodollars).toBe(1_000_000_000n);
    expect(budget.reservedNanodollars).toBe(0n);

    expect(
      await withRuntimeClient(async (client) =>
        releaseReservation(client, scope, target, 'expired_before_dispatch', NOW),
      ),
    ).toStrictEqual({ outcome: 'already_released' });
  }, 60_000);

  it('refuses to release a dispatched reservation for an undispatched reason', async () => {
    const scope = await seedTenant(1_000_000_000n);
    const target = reservationId(randomUUID());
    await withRuntimeClient(async (client) =>
      reserveBudget(client, scope, {
        amount: positiveNanodollars(100_000_000n),
        attemptId: attemptId(randomUUID()),
        expiresAt: EXPIRES_AT,
        idempotencyKey: idempotencyKey(`wrongreason-${randomUUID()}`),
        now: NOW,
        priceBookVersion: PRICE_VERSION,
        reservationId: target,
      }),
    );
    await withRuntimeClient(async (client) => markDispatched(client, scope, target, NOW));
    expect(
      await withRuntimeClient(async (client) =>
        releaseReservation(client, scope, target, 'expired_before_dispatch', NOW),
      ),
    ).toMatchObject({ outcome: 'refused' });
  }, 60_000);
});
