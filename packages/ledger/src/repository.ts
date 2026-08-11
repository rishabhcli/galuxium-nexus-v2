/**
 * The authoritative ledger operations.
 *
 * Three properties matter more than anything else in this file.
 *
 * **The debit is one statement.** `reserveBudget` never reads a balance and then
 * decides. It issues a single conditional `UPDATE` whose `WHERE` clause contains
 * the affordability test, so the test and the write are the same atomic act.
 * Zero rows affected means the tenant could not afford it. This is the difference
 * between this system and a gateway that checks a counter: N concurrent requests
 * cannot all pass the same check, because there is no check to pass — there is
 * one row and the last writer to reach it sees the others' effects.
 *
 * **Every mutation carries its ledger entry in the same transaction.** A balance
 * that moved without a corresponding entry, or an entry without the balance
 * movement, is an unauditable ledger. Both happen together or neither happens.
 *
 * **The tenant scope is set on the connection, inside the transaction.** Row-level
 * security reads it, so a query that forgot to filter returns nothing rather than
 * everything. `SET LOCAL` scopes it to the transaction so a pooled connection
 * cannot leak one tenant's scope into the next request.
 */

import type { PoolClient } from 'pg';

import type {
  AttemptId,
  FenceToken,
  IdempotencyKey,
  PriceBookVersion,
  ReservationId,
  TenantScope,
} from './identity.js';
import {
  type NonNegativeNanodollars,
  type PositiveNanodollars,
  formatNanodollars,
  nonNegativeNanodollars,
  parseNanodollars,
} from './money.js';
import type { ReleaseReason, UncertainReason } from './reservation.js';
import { type InstantUtc, formatInstantIsoUtc } from './time.js';

export type LedgerRepositoryErrorCode =
  | 'LEDGER_BUDGET_MISSING'
  | 'LEDGER_IMBALANCE_DETECTED'
  | 'LEDGER_RESERVATION_MISSING'
  | 'LEDGER_ROW_UNREADABLE'
  | 'LEDGER_SCOPE_NOT_APPLIED';

export class LedgerRepositoryError extends Error {
  readonly code: LedgerRepositoryErrorCode;

  constructor(code: LedgerRepositoryErrorCode, message: string) {
    super(message);
    this.name = 'LedgerRepositoryError';
    this.code = code;
  }
}

/** PostgreSQL's SQLSTATE for a unique-constraint violation. */
const UNIQUE_VIOLATION = '23505';

export interface BudgetState {
  readonly availableNanodollars: NonNegativeNanodollars;
  readonly creditedNanodollars: NonNegativeNanodollars;
  readonly maxOutputTokens: number;
  readonly overspendNanodollars: NonNegativeNanodollars;
  readonly reservationTtlSeconds: number;
  readonly reservedNanodollars: NonNegativeNanodollars;
  readonly settledNanodollars: NonNegativeNanodollars;
}

export interface ReserveRequest {
  readonly amount: PositiveNanodollars;
  readonly attemptId: AttemptId;
  readonly expiresAt: InstantUtc;
  readonly idempotencyKey: IdempotencyKey;
  readonly now: InstantUtc;
  readonly priceBookVersion: PriceBookVersion;
  readonly reservationId: ReservationId;
}

export type ReserveOutcome =
  | {
      readonly availableAfter: NonNegativeNanodollars;
      readonly fence: FenceToken;
      readonly outcome: 'reserved';
      readonly reservationId: ReservationId;
    }
  | {
      /** The reservation this idempotency key already created. */
      readonly outcome: 'already_reserved';
      readonly reservationId: ReservationId;
    }
  | {
      readonly availableNanodollars: NonNegativeNanodollars;
      readonly outcome: 'insufficient_budget';
      readonly requestedNanodollars: PositiveNanodollars;
    };

interface BudgetRow {
  readonly credited_nanodollars: string;
  readonly max_output_tokens: number;
  readonly overspend_nanodollars: string;
  readonly reservation_ttl_seconds: number;
  readonly reserved_nanodollars: string;
  readonly settled_nanodollars: string;
}

function budgetFromRow(row: BudgetRow): BudgetState {
  const credited = parseNanodollars(row.credited_nanodollars);
  const settled = parseNanodollars(row.settled_nanodollars);
  const reserved = parseNanodollars(row.reserved_nanodollars);
  return {
    // The database constraint guarantees this is non-negative, so a negative
    // value here means the constraint is gone and the ledger is not trustworthy.
    availableNanodollars: nonNegativeNanodollars(credited - settled - reserved),
    creditedNanodollars: nonNegativeNanodollars(credited),
    maxOutputTokens: row.max_output_tokens,
    overspendNanodollars: nonNegativeNanodollars(parseNanodollars(row.overspend_nanodollars)),
    reservationTtlSeconds: row.reservation_ttl_seconds,
    reservedNanodollars: nonNegativeNanodollars(reserved),
    settledNanodollars: nonNegativeNanodollars(settled),
  };
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === UNIQUE_VIOLATION
  );
}

/**
 * Apply the tenant scope that row-level security reads.
 *
 * `SET LOCAL` rather than `SET`, so the scope dies with the transaction. A pooled
 * connection therefore cannot carry one tenant's scope into another tenant's
 * request, which is the failure mode that makes connection-pooled RLS dangerous
 * when it is done with a session-level setting.
 */
async function applyScope(client: PoolClient, scope: TenantScope): Promise<void> {
  // The third argument is `is_local`: the setting lives and dies with the
  // enclosing transaction. Outside a transaction PostgreSQL accepts the call and
  // discards the value, so every caller must already be inside one — which the
  // verification below turns into a loud refusal rather than a query that
  // silently sees zero rows.
  await client.query('SELECT set_config($1, $2, true)', ['app.tenant_id', scope.tenantId]);
  const applied = await client.query<{ readonly tenant: string | null }>(
    'SELECT current_setting($1, true) AS tenant',
    ['app.tenant_id'],
  );
  if (applied.rows[0]?.tenant !== scope.tenantId) {
    throw new LedgerRepositoryError(
      'LEDGER_SCOPE_NOT_APPLIED',
      'The tenant scope could not be applied to this connection',
    );
  }
}

async function accountIdOf(client: PoolClient, scope: TenantScope, kind: string): Promise<string> {
  const result = await client.query<{ readonly id: string }>(
    'SELECT id FROM ledger.accounts WHERE tenant_id = $1 AND kind = $2',
    [scope.tenantId, kind],
  );
  const id = result.rows[0]?.id;
  if (id === undefined) {
    throw new LedgerRepositoryError(
      'LEDGER_ROW_UNREADABLE',
      `The tenant has no ${kind} account, so no movement can name its two sides`,
    );
  }
  return id;
}

export async function readBudget(client: PoolClient, scope: TenantScope): Promise<BudgetState> {
  await client.query('BEGIN');
  try {
    await applyScope(client, scope);
    const result = await client.query<BudgetRow>(
      `SELECT credited_nanodollars, settled_nanodollars, reserved_nanodollars,
              overspend_nanodollars, max_output_tokens, reservation_ttl_seconds
         FROM ledger.budgets
        WHERE tenant_id = $1`,
      [scope.tenantId],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new LedgerRepositoryError(
        'LEDGER_BUDGET_MISSING',
        'This tenant has no budget, so nothing may be authorized for it',
      );
    }
    const budget = budgetFromRow(row);
    await client.query('COMMIT');
    return budget;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

/**
 * Reserve budget for one attempt, or refuse.
 *
 * The whole admission decision is the `WHERE` clause of a single `UPDATE`. There
 * is no moment between deciding and writing for another request to occupy, and
 * PostgreSQL serialises concurrent updates of the same row, so the affordability
 * test each caller passes accounts for every caller that got there first.
 *
 * `expiresAt` is stored rather than derived at read time so that a clock
 * disagreement between the gateway and the reaper cannot change when a hold ends.
 */
export async function reserveBudget(
  client: PoolClient,
  scope: TenantScope,
  request: ReserveRequest,
): Promise<ReserveOutcome> {
  await client.query('BEGIN');
  try {
    await applyScope(client, scope);

    const existing = await client.query<{ readonly id: string }>(
      'SELECT id FROM ledger.reservations WHERE tenant_id = $1 AND idempotency_key = $2',
      [scope.tenantId, request.idempotencyKey],
    );
    const existingId = existing.rows[0]?.id;
    if (existingId !== undefined) {
      await client.query('COMMIT');
      return { outcome: 'already_reserved', reservationId: existingId as ReservationId };
    }

    // One statement. The affordability test and the write are the same act.
    const debit = await client.query<BudgetRow>(
      `UPDATE ledger.budgets
          SET reserved_nanodollars = reserved_nanodollars + $2::NUMERIC,
              updated_at = $3::TIMESTAMPTZ
        WHERE tenant_id = $1
          AND credited_nanodollars - settled_nanodollars - reserved_nanodollars - $2::NUMERIC >= 0
        RETURNING credited_nanodollars, settled_nanodollars, reserved_nanodollars,
                  overspend_nanodollars, max_output_tokens, reservation_ttl_seconds`,
      [scope.tenantId, formatNanodollars(request.amount), formatInstantIsoUtc(request.now)],
    );

    const debited = debit.rows[0];
    if (debited === undefined) {
      // Zero rows means either "cannot afford" or "no such budget". Distinguish
      // them, because one is a normal refusal a caller can act on and the other
      // is a misconfiguration.
      const budget = await client.query<BudgetRow>(
        `SELECT credited_nanodollars, settled_nanodollars, reserved_nanodollars,
                overspend_nanodollars, max_output_tokens, reservation_ttl_seconds
           FROM ledger.budgets WHERE tenant_id = $1`,
        [scope.tenantId],
      );
      const row = budget.rows[0];
      await client.query('ROLLBACK');
      if (row === undefined) {
        throw new LedgerRepositoryError(
          'LEDGER_BUDGET_MISSING',
          'This tenant has no budget, so nothing may be authorized for it',
        );
      }
      return {
        availableNanodollars: budgetFromRow(row).availableNanodollars,
        outcome: 'insufficient_budget',
        requestedNanodollars: request.amount,
      };
    }

    await client.query(
      `INSERT INTO ledger.reservations
         (id, tenant_id, attempt_id, idempotency_key, price_book_version,
          reserved_nanodollars, status, fence, created_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6::NUMERIC, 'open', 1, $7::TIMESTAMPTZ, $8::TIMESTAMPTZ)`,
      [
        request.reservationId,
        scope.tenantId,
        request.attemptId,
        request.idempotencyKey,
        request.priceBookVersion,
        formatNanodollars(request.amount),
        formatInstantIsoUtc(request.now),
        formatInstantIsoUtc(request.expiresAt),
      ],
    );

    const availableAccount = await accountIdOf(client, scope, 'available');
    const reservedAccount = await accountIdOf(client, scope, 'reserved');
    await client.query(
      `INSERT INTO ledger.entries
         (id, tenant_id, debit_account_id, credit_account_id, amount_nanodollars,
          kind, reservation_id, price_book_version, occurred_at, recorded_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4::NUMERIC, 'reserve_hold', $5, $6,
               $7::TIMESTAMPTZ, now())`,
      [
        scope.tenantId,
        availableAccount,
        reservedAccount,
        formatNanodollars(request.amount),
        request.reservationId,
        request.priceBookVersion,
        formatInstantIsoUtc(request.now),
      ],
    );

    await client.query('COMMIT');
    return {
      availableAfter: budgetFromRow(debited).availableNanodollars,
      fence: 1n as FenceToken,
      outcome: 'reserved',
      reservationId: request.reservationId,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    if (isUniqueViolation(error)) {
      // Two requests raced on the same idempotency key. The loser rolled back
      // entirely — including its debit, because the debit was in this same
      // transaction — so reading the winner's reservation is safe and correct.
      await client.query('BEGIN');
      let id: string | undefined;
      try {
        await applyScope(client, scope);
        const winner = await client.query<{ readonly id: string }>(
          'SELECT id FROM ledger.reservations WHERE tenant_id = $1 AND idempotency_key = $2',
          [scope.tenantId, request.idempotencyKey],
        );
        id = winner.rows[0]?.id;
        await client.query('COMMIT');
      } catch (readError) {
        await client.query('ROLLBACK');
        throw readError;
      }
      if (id !== undefined) {
        return { outcome: 'already_reserved', reservationId: id as ReservationId };
      }
    }
    throw error;
  }
}

export interface SettleRequest {
  readonly now: InstantUtc;
  readonly reservationId: ReservationId;
  readonly settledAmount: NonNegativeNanodollars;
}

export type SettleOutcome =
  | { readonly outcome: 'already_settled' }
  | { readonly outcome: 'refused'; readonly reason: string }
  | {
      readonly outcome: 'settled';
      readonly releasedNanodollars: NonNegativeNanodollars;
      readonly settledNanodollars: NonNegativeNanodollars;
    };

/**
 * Settle a dispatched attempt exactly once.
 *
 * The released remainder is computed by the database from the stored reservation,
 * never supplied by the caller, so `settled + released = reserved` cannot be got
 * wrong by a caller doing its own arithmetic. The `status = 'dispatched'`
 * predicate makes the update itself the idempotency check: a repeat affects zero
 * rows, which is reported as `already_settled` rather than moving money twice.
 */
export async function settleReservation(
  client: PoolClient,
  scope: TenantScope,
  request: SettleRequest,
): Promise<SettleOutcome> {
  await client.query('BEGIN');
  try {
    await applyScope(client, scope);

    const updated = await client.query<{
      readonly released_nanodollars: string;
      readonly settled_nanodollars: string;
    }>(
      `UPDATE ledger.reservations
          SET status = 'settled',
              settled_nanodollars = $3::NUMERIC,
              released_nanodollars = reserved_nanodollars - $3::NUMERIC,
              resolved_at = $4::TIMESTAMPTZ
        WHERE tenant_id = $1
          AND id = $2
          AND status = 'dispatched'
          AND reserved_nanodollars >= $3::NUMERIC
        RETURNING settled_nanodollars, released_nanodollars`,
      [
        scope.tenantId,
        request.reservationId,
        formatNanodollars(request.settledAmount),
        formatInstantIsoUtc(request.now),
      ],
    );

    const row = updated.rows[0];
    if (row === undefined) {
      const current = await client.query<{ readonly status: string }>(
        'SELECT status FROM ledger.reservations WHERE tenant_id = $1 AND id = $2',
        [scope.tenantId, request.reservationId],
      );
      const status = current.rows[0]?.status;
      await client.query('ROLLBACK');
      if (status === undefined) {
        throw new LedgerRepositoryError(
          'LEDGER_RESERVATION_MISSING',
          'No reservation with that identity exists for this tenant',
        );
      }
      if (status === 'settled') {
        return { outcome: 'already_settled' };
      }
      return {
        outcome: 'refused',
        reason: `A reservation in ${status} cannot be settled from a dispatched attempt`,
      };
    }

    const settled = nonNegativeNanodollars(parseNanodollars(row.settled_nanodollars));
    const released = nonNegativeNanodollars(parseNanodollars(row.released_nanodollars));

    // The hot row moves in the same transaction as the reservation and the
    // entries. Reserved falls by the whole hold; settled rises by the actual cost.
    await client.query(
      `UPDATE ledger.budgets
          SET reserved_nanodollars = reserved_nanodollars - ($2::NUMERIC + $3::NUMERIC),
              settled_nanodollars = settled_nanodollars + $2::NUMERIC,
              updated_at = $4::TIMESTAMPTZ
        WHERE tenant_id = $1`,
      [
        scope.tenantId,
        formatNanodollars(settled),
        formatNanodollars(released),
        formatInstantIsoUtc(request.now),
      ],
    );

    const reservedAccount = await accountIdOf(client, scope, 'reserved');
    const settledAccount = await accountIdOf(client, scope, 'settled');
    const availableAccount = await accountIdOf(client, scope, 'available');
    const occurredAt = formatInstantIsoUtc(request.now);
    const priceVersion = await client.query<{ readonly price_book_version: string }>(
      'SELECT price_book_version FROM ledger.reservations WHERE tenant_id = $1 AND id = $2',
      [scope.tenantId, request.reservationId],
    );
    const version = priceVersion.rows[0]?.price_book_version;
    if (version === undefined) {
      throw new LedgerRepositoryError(
        'LEDGER_RESERVATION_MISSING',
        'The reservation lost its price book version between statements',
      );
    }

    // Zero-amount movements are not written: an entry no balance depends on
    // forces every reader to know to ignore it.
    if (settled > 0n) {
      await client.query(
        `INSERT INTO ledger.entries
           (id, tenant_id, debit_account_id, credit_account_id, amount_nanodollars,
            kind, reservation_id, price_book_version, occurred_at, recorded_at)
         VALUES (gen_random_uuid(), $1, $2, $3, $4::NUMERIC, 'settle_reserved', $5, $6,
                 $7::TIMESTAMPTZ, now())`,
        [
          scope.tenantId,
          reservedAccount,
          settledAccount,
          formatNanodollars(settled),
          request.reservationId,
          version,
          occurredAt,
        ],
      );
    }
    if (released > 0n) {
      await client.query(
        `INSERT INTO ledger.entries
           (id, tenant_id, debit_account_id, credit_account_id, amount_nanodollars,
            kind, reservation_id, price_book_version, occurred_at, recorded_at)
         VALUES (gen_random_uuid(), $1, $2, $3, $4::NUMERIC, 'release_reserved', $5, $6,
                 $7::TIMESTAMPTZ, now())`,
        [
          scope.tenantId,
          reservedAccount,
          availableAccount,
          formatNanodollars(released),
          request.reservationId,
          version,
          occurredAt,
        ],
      );
    }

    await client.query('COMMIT');
    return { outcome: 'settled', releasedNanodollars: released, settledNanodollars: settled };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

/** Move an open reservation to dispatched. Must commit before any provider call. */
export async function markDispatched(
  client: PoolClient,
  scope: TenantScope,
  reservationId: ReservationId,
  now: InstantUtc,
): Promise<boolean> {
  await client.query('BEGIN');
  try {
    await applyScope(client, scope);
    const result = await client.query(
      `UPDATE ledger.reservations
          SET status = 'dispatched', dispatched_at = $3::TIMESTAMPTZ
        WHERE tenant_id = $1 AND id = $2 AND status = 'open'`,
      [scope.tenantId, reservationId, formatInstantIsoUtc(now)],
    );
    await client.query('COMMIT');
    return result.rowCount === 1;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

/**
 * Record that a dispatched attempt's outcome is not known.
 *
 * Invariant I6: this moves no money and releases nothing. The hold stays until
 * the reconciler resolves it with evidence or an operator adjusts it on the
 * record.
 */
export async function markUncertain(
  client: PoolClient,
  scope: TenantScope,
  reservationId: ReservationId,
  reason: UncertainReason,
  now: InstantUtc,
): Promise<boolean> {
  await client.query('BEGIN');
  try {
    await applyScope(client, scope);
    const result = await client.query(
      `UPDATE ledger.reservations
          SET status = 'uncertain', uncertain_reason = $3, observed_at = $4::TIMESTAMPTZ
        WHERE tenant_id = $1 AND id = $2 AND status IN ('dispatched', 'uncertain')`,
      [scope.tenantId, reservationId, reason, formatInstantIsoUtc(now)],
    );
    await client.query('COMMIT');
    return result.rowCount === 1;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

export type ReleaseOutcome =
  | { readonly outcome: 'already_released' }
  | { readonly outcome: 'refused'; readonly reason: string }
  | { readonly outcome: 'released'; readonly releasedNanodollars: NonNegativeNanodollars };

/** Release a hold in full, returning the money to available. */
export async function releaseReservation(
  client: PoolClient,
  scope: TenantScope,
  reservationId: ReservationId,
  reason: ReleaseReason,
  now: InstantUtc,
): Promise<ReleaseOutcome> {
  const admissible: Record<ReleaseReason, readonly string[]> = {
    client_cancelled_before_dispatch: ['open'],
    expired_before_dispatch: ['open'],
    provider_refused_before_usage: ['dispatched'],
    reconciled_zero_usage: ['uncertain'],
  };

  await client.query('BEGIN');
  try {
    await applyScope(client, scope);
    const updated = await client.query<{ readonly released_nanodollars: string }>(
      `UPDATE ledger.reservations
          SET status = 'released',
              settled_nanodollars = 0,
              released_nanodollars = reserved_nanodollars,
              release_reason = $3,
              resolved_at = $4::TIMESTAMPTZ
        WHERE tenant_id = $1 AND id = $2 AND status = ANY($5::TEXT[])
        RETURNING released_nanodollars`,
      [scope.tenantId, reservationId, reason, formatInstantIsoUtc(now), [...admissible[reason]]],
    );

    const row = updated.rows[0];
    if (row === undefined) {
      const current = await client.query<{ readonly status: string }>(
        'SELECT status FROM ledger.reservations WHERE tenant_id = $1 AND id = $2',
        [scope.tenantId, reservationId],
      );
      const status = current.rows[0]?.status;
      await client.query('ROLLBACK');
      if (status === undefined) {
        throw new LedgerRepositoryError(
          'LEDGER_RESERVATION_MISSING',
          'No reservation with that identity exists for this tenant',
        );
      }
      if (status === 'released') {
        return { outcome: 'already_released' };
      }
      return {
        outcome: 'refused',
        reason: `A reservation in ${status} may not be released for reason ${reason}`,
      };
    }

    const released = nonNegativeNanodollars(parseNanodollars(row.released_nanodollars));
    await client.query(
      `UPDATE ledger.budgets
          SET reserved_nanodollars = reserved_nanodollars - $2::NUMERIC,
              updated_at = $3::TIMESTAMPTZ
        WHERE tenant_id = $1`,
      [scope.tenantId, formatNanodollars(released), formatInstantIsoUtc(now)],
    );

    const reservedAccount = await accountIdOf(client, scope, 'reserved');
    const availableAccount = await accountIdOf(client, scope, 'available');
    const version = await client.query<{ readonly price_book_version: string }>(
      'SELECT price_book_version FROM ledger.reservations WHERE tenant_id = $1 AND id = $2',
      [scope.tenantId, reservationId],
    );
    await client.query(
      `INSERT INTO ledger.entries
         (id, tenant_id, debit_account_id, credit_account_id, amount_nanodollars,
          kind, reservation_id, price_book_version, occurred_at, recorded_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4::NUMERIC, 'release_reserved', $5, $6,
               $7::TIMESTAMPTZ, now())`,
      [
        scope.tenantId,
        reservedAccount,
        availableAccount,
        formatNanodollars(released),
        reservationId,
        version.rows[0]?.price_book_version ?? null,
        formatInstantIsoUtc(now),
      ],
    );

    await client.query('COMMIT');
    return { outcome: 'released', releasedNanodollars: released };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

export interface InvariantReport {
  readonly derivedReservedNanodollars: NonNegativeNanodollars;
  readonly derivedSettledNanodollars: NonNegativeNanodollars;
  readonly entrySumNanodollars: bigint;
  readonly holds: boolean;
  readonly recordedReservedNanodollars: NonNegativeNanodollars;
  readonly recordedSettledNanodollars: NonNegativeNanodollars;
}

/**
 * The proof artifact.
 *
 * Recomputes what the hot row claims from the reservations themselves, and
 * independently checks that every entry sums to zero across accounts. Anything
 * other than `holds: true` means the fast state and the audit trail disagree, and
 * a tenant with an imbalance must have new authorizations blocked rather than
 * being quietly repaired — see the Tier 5 fail-closed requirement.
 *
 * Runs unscoped, so it must be executed by the owner identity rather than a
 * request path.
 */
export async function checkLedgerInvariant(
  client: PoolClient,
  tenantId: string,
): Promise<InvariantReport> {
  const derived = await client.query<{
    readonly reserved: string;
    readonly settled: string;
  }>(
    `SELECT
       COALESCE(SUM(CASE WHEN status IN ('open','dispatched','uncertain')
                         THEN reserved_nanodollars ELSE 0 END), 0)::TEXT AS reserved,
       COALESCE(SUM(COALESCE(settled_nanodollars, 0)), 0)::TEXT AS settled
     FROM ledger.reservations
     WHERE tenant_id = $1`,
    [tenantId],
  );
  const recorded = await client.query<{
    readonly reserved_nanodollars: string;
    readonly settled_nanodollars: string;
  }>(
    'SELECT reserved_nanodollars::TEXT, settled_nanodollars::TEXT FROM ledger.budgets WHERE tenant_id = $1',
    [tenantId],
  );
  const entrySum = await client.query<{ readonly total: string }>(
    `SELECT COALESCE(SUM(signed), 0)::TEXT AS total FROM (
       SELECT amount_nanodollars AS signed FROM ledger.entries WHERE tenant_id = $1
       UNION ALL
       SELECT -amount_nanodollars AS signed FROM ledger.entries WHERE tenant_id = $1
     ) AS both_sides`,
    [tenantId],
  );

  const derivedRow = derived.rows[0];
  const recordedRow = recorded.rows[0];
  const sumRow = entrySum.rows[0];
  if (derivedRow === undefined || recordedRow === undefined || sumRow === undefined) {
    throw new LedgerRepositoryError(
      'LEDGER_ROW_UNREADABLE',
      'The invariant check could not read the ledger state it must compare',
    );
  }

  const derivedReserved = nonNegativeNanodollars(parseNanodollars(derivedRow.reserved));
  const derivedSettled = nonNegativeNanodollars(parseNanodollars(derivedRow.settled));
  const recordedReserved = nonNegativeNanodollars(
    parseNanodollars(recordedRow.reserved_nanodollars),
  );
  const recordedSettled = nonNegativeNanodollars(parseNanodollars(recordedRow.settled_nanodollars));
  const sum = parseNanodollars(sumRow.total);

  return {
    derivedReservedNanodollars: derivedReserved,
    derivedSettledNanodollars: derivedSettled,
    entrySumNanodollars: sum,
    holds: derivedReserved === recordedReserved && derivedSettled === recordedSettled && sum === 0n,
    recordedReservedNanodollars: recordedReserved,
    recordedSettledNanodollars: recordedSettled,
  };
}
