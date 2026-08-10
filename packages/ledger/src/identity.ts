/**
 * Identity and scoping types for the authoritative ledger.
 *
 * Two rules are encoded here rather than documented.
 *
 * The first is invariant I7: tenant identity is scoped at every layer. A ledger
 * operation cannot be expressed without a {@link TenantScope}, and a
 * `TenantScope` cannot be produced except by validating a tenant identifier.
 * "Forgot to filter by tenant" therefore fails to compile rather than returning
 * another tenant's money.
 *
 * The second is that identifiers this system mints and identifiers a caller
 * supplies are different types. A client-supplied idempotency key is untrusted
 * input of caller-chosen shape; a reservation identifier is a UUID this system
 * generated. Conflating them is how a caller ends up able to address, or
 * collide with, a record it does not own.
 */

declare const tenantIdBrand: unique symbol;
declare const accountIdBrand: unique symbol;
declare const reservationIdBrand: unique symbol;
declare const attemptIdBrand: unique symbol;
declare const idempotencyKeyBrand: unique symbol;
declare const priceBookVersionBrand: unique symbol;
declare const fenceBrand: unique symbol;
declare const tenantScopeBrand: unique symbol;

/** A tenant, as a UUID this system minted. */
export type TenantId = string & { readonly [tenantIdBrand]: 'TenantId' };

/** A ledger account, as a UUID this system minted. */
export type AccountId = string & { readonly [accountIdBrand]: 'AccountId' };

/** A budget reservation, as a UUID this system minted. */
export type ReservationId = string & { readonly [reservationIdBrand]: 'ReservationId' };

/** One provider attempt against a reservation, as a UUID this system minted. */
export type AttemptId = string & { readonly [attemptIdBrand]: 'AttemptId' };

/**
 * A caller-supplied idempotency key: untrusted, caller-shaped, and the unit of
 * exactly-once settlement.
 */
export type IdempotencyKey = string & { readonly [idempotencyKeyBrand]: 'IdempotencyKey' };

/**
 * The immutable price book revision used to authorize an attempt. Retained
 * forever alongside the attempt (invariant I5), so a later price change can
 * never retroactively change what an old authorization meant.
 */
export type PriceBookVersion = string & { readonly [priceBookVersionBrand]: 'PriceBookVersion' };

/**
 * A monotonic fencing token for one reservation. A holder whose token is behind
 * the record's token has been superseded and may not move money.
 */
export type FenceToken = bigint & { readonly [fenceBrand]: 'FenceToken' };

/**
 * Proof that an operation has been scoped to exactly one tenant. Opaque by
 * construction: the only way to obtain one is {@link tenantScope}.
 */
export interface TenantScope {
  readonly [tenantScopeBrand]: 'TenantScope';
  readonly tenantId: TenantId;
}

export type IdentityErrorCode =
  | 'IDENTITY_FENCE_INVALID'
  | 'IDENTITY_IDEMPOTENCY_KEY_INVALID'
  | 'IDENTITY_NOT_UUID'
  | 'IDENTITY_PRICE_BOOK_VERSION_INVALID'
  | 'IDENTITY_SCOPE_MISMATCH';

export class IdentityError extends Error {
  readonly code: IdentityErrorCode;

  constructor(code: IdentityErrorCode, message: string) {
    super(message);
    this.name = 'IdentityError';
    this.code = code;
  }
}

/**
 * Lowercase RFC 9562 UUID, version 4 through 8, with a variant nibble of
 * 8/9/a/b. Uppercase is refused rather than normalised so that one record can
 * never be addressed by two distinct strings, which would defeat any uniqueness
 * constraint expressed over the text form.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[4-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

/** `2026-08-10.3`-shaped: an ISO date, a dot, and a monotonically rising revision. */
const PRICE_BOOK_VERSION = /^\d{4}-\d{2}-\d{2}\.(?:0|[1-9]\d{0,3})$/u;

/**
 * A caller-supplied key: 8 to 128 characters of ASCII letters, digits, hyphen,
 * underscore, colon, or dot. Excludes whitespace, slashes, and control
 * characters so a key can be logged, used in a URL path, and used as a database
 * key without a second escaping decision at each site.
 */
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,128}$/u;

function admitUuid(value: unknown, label: string): string {
  if (typeof value !== 'string' || !UUID.test(value)) {
    throw new IdentityError('IDENTITY_NOT_UUID', `${label} must be a lowercase UUID`);
  }
  return value;
}

export function tenantId(value: unknown): TenantId {
  return admitUuid(value, 'A tenant identifier') as TenantId;
}

export function accountId(value: unknown): AccountId {
  return admitUuid(value, 'An account identifier') as AccountId;
}

export function reservationId(value: unknown): ReservationId {
  return admitUuid(value, 'A reservation identifier') as ReservationId;
}

export function attemptId(value: unknown): AttemptId {
  return admitUuid(value, 'An attempt identifier') as AttemptId;
}

export function idempotencyKey(value: unknown): IdempotencyKey {
  if (typeof value !== 'string' || !IDEMPOTENCY_KEY.test(value)) {
    throw new IdentityError(
      'IDENTITY_IDEMPOTENCY_KEY_INVALID',
      'An idempotency key must be 8 to 128 characters of unreserved ASCII',
    );
  }
  return value as IdempotencyKey;
}

export function priceBookVersion(value: unknown): PriceBookVersion {
  if (typeof value !== 'string' || !PRICE_BOOK_VERSION.test(value)) {
    throw new IdentityError(
      'IDENTITY_PRICE_BOOK_VERSION_INVALID',
      'A price book version must be an ISO date and a revision number',
    );
  }
  return value as PriceBookVersion;
}

/** Fencing tokens start at 1 and only ever rise. Zero is reserved as "never fenced". */
export function fenceToken(value: bigint): FenceToken {
  if (typeof value !== 'bigint' || value < 1n || value > 2n ** 62n) {
    throw new IdentityError(
      'IDENTITY_FENCE_INVALID',
      'A fencing token must be a positive bigint within the storable range',
    );
  }
  return value as FenceToken;
}

export function nextFenceToken(current: FenceToken): FenceToken {
  return fenceToken(current + 1n);
}

/** The only constructor of a {@link TenantScope}. */
export function tenantScope(value: unknown): TenantScope {
  const scoped = tenantId(value);
  return Object.freeze({ tenantId: scoped }) as TenantScope;
}

/**
 * Assert that a record loaded from anywhere belongs to the scope that asked for
 * it. Defence in depth behind row-level security and query scoping: if either
 * of those is ever misconfigured, this refuses at the boundary instead of
 * handing one tenant another tenant's row.
 */
export function assertWithinScope(
  scope: TenantScope,
  record: { readonly tenantId: TenantId },
  label: string,
): void {
  if (record.tenantId !== scope.tenantId) {
    throw new IdentityError(
      'IDENTITY_SCOPE_MISMATCH',
      `${label} does not belong to the requesting tenant scope`,
    );
  }
}
