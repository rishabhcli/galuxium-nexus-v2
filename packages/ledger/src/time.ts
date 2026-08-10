/**
 * Instants, as an exact timezone-explicit type.
 *
 * An instant is an integer count of microseconds since the Unix epoch, in UTC,
 * carried as `bigint`. Microseconds because that is exactly PostgreSQL's
 * `timestamptz` resolution, so an instant written to the ledger and read back
 * is the same instant rather than a rounded neighbour. `bigint` because
 * `Date`'s millisecond `number` cannot represent that resolution and invites
 * float arithmetic into ordering comparisons.
 *
 * There is no local-time constructor and no local-time formatter in this
 * module. A reservation expiry compared against a local wall clock is a
 * money-losing bug in any deployment whose processes disagree about the zone.
 */

declare const instantBrand: unique symbol;

/** Microseconds since 1970-01-01T00:00:00Z. */
export type InstantUtc = bigint & { readonly [instantBrand]: 'InstantUtc' };

export const MICROSECONDS_PER_MILLISECOND = 1_000n;

/** 0001-01-01T00:00:00Z, the earliest instant PostgreSQL renders unambiguously. */
export const MIN_INSTANT_MICROSECONDS = -62_135_596_800_000_000n;

/** 9999-12-31T23:59:59.999999Z, the latest instant PostgreSQL stores. */
export const MAX_INSTANT_MICROSECONDS = 253_402_300_799_999_999n;

export type InstantErrorCode =
  'INSTANT_MALFORMED_TEXT' | 'INSTANT_NOT_BIGINT' | 'INSTANT_NOT_UTC' | 'INSTANT_OUT_OF_RANGE';

export class InstantError extends Error {
  readonly code: InstantErrorCode;

  constructor(code: InstantErrorCode, message: string) {
    super(message);
    this.name = 'InstantError';
    this.code = code;
  }
}

const ISO_UTC =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}:\d{2})$/u;

export function instantUtc(microseconds: bigint): InstantUtc {
  if (typeof microseconds !== 'bigint') {
    throw new InstantError('INSTANT_NOT_BIGINT', 'An instant must be an exact bigint');
  }
  if (microseconds < MIN_INSTANT_MICROSECONDS || microseconds > MAX_INSTANT_MICROSECONDS) {
    throw new InstantError('INSTANT_OUT_OF_RANGE', 'An instant is outside the storable range');
  }
  return microseconds as InstantUtc;
}

/**
 * Parse an RFC 3339 timestamp.
 *
 * A non-`Z` offset is refused rather than converted. Accepting `+05:30` here
 * would mean the ledger's stored instant depended on a caller's formatting
 * choice, and a caller that formats an offset is a caller that may have already
 * applied one. The one representation this system stores is UTC.
 */
export function instantFromIsoUtc(text: unknown): InstantUtc {
  if (typeof text !== 'string') {
    throw new InstantError('INSTANT_MALFORMED_TEXT', 'An instant must be an RFC 3339 UTC string');
  }
  const match = ISO_UTC.exec(text);
  if (match === null) {
    throw new InstantError('INSTANT_MALFORMED_TEXT', 'An instant must be an RFC 3339 UTC string');
  }
  const [, year, month, day, hour, minute, second, fraction, zone] = match;
  if (zone !== 'Z') {
    throw new InstantError('INSTANT_NOT_UTC', 'An instant must be expressed with a Z zone marker');
  }
  const fields = {
    day: Number(day),
    hour: Number(hour),
    minute: Number(minute),
    month: Number(month),
    second: Number(second),
    year: Number(year),
  };
  const milliseconds = Date.UTC(
    fields.year,
    fields.month - 1,
    fields.day,
    fields.hour,
    fields.minute,
    fields.second,
  );
  if (!Number.isFinite(milliseconds)) {
    throw new InstantError('INSTANT_MALFORMED_TEXT', 'An instant must be a real calendar time');
  }
  // `Date.UTC` silently normalises an impossible date: month 13 becomes January
  // of the next year, and 2026-02-30 becomes March 2nd. Compare the fields back
  // out so a normalised value is refused instead of stored as a different day.
  const roundTrip = new Date(milliseconds);
  if (
    roundTrip.getUTCFullYear() !== fields.year ||
    roundTrip.getUTCMonth() + 1 !== fields.month ||
    roundTrip.getUTCDate() !== fields.day ||
    roundTrip.getUTCHours() !== fields.hour ||
    roundTrip.getUTCMinutes() !== fields.minute ||
    roundTrip.getUTCSeconds() !== fields.second
  ) {
    throw new InstantError('INSTANT_MALFORMED_TEXT', 'An instant must be a real calendar time');
  }
  const microsecondFraction = BigInt((fraction ?? '').padEnd(6, '0'));
  return instantUtc(BigInt(milliseconds) * MICROSECONDS_PER_MILLISECOND + microsecondFraction);
}

/** Render the canonical storage form: RFC 3339 UTC with exactly six fraction digits. */
export function formatInstantIsoUtc(instant: InstantUtc): string {
  const microseconds = ((instant % 1_000_000n) + 1_000_000n) % 1_000_000n;
  const milliseconds = (instant - microseconds) / MICROSECONDS_PER_MILLISECOND;
  const base = new Date(Number(milliseconds)).toISOString().slice(0, 19);
  return `${base}.${microseconds.toString(10).padStart(6, '0')}Z`;
}

export function addMicroseconds(instant: InstantUtc, microseconds: bigint): InstantUtc {
  return instantUtc(instant + microseconds);
}

export function isAtOrAfter(instant: InstantUtc, other: InstantUtc): boolean {
  return instant >= other;
}

export function earlierInstant(left: InstantUtc, right: InstantUtc): InstantUtc {
  return left <= right ? left : right;
}
