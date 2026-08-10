/**
 * Exact monetary arithmetic for the authoritative ledger.
 *
 * Money is an integer count of nanodollars (1e-9 USD) carried as `bigint`, so
 * no representable amount can lose precision and no sequence of operations can
 * drift. Binary floating point is structurally excluded: there is no `number`
 * path into or out of an amount anywhere in this module.
 *
 * Every amount is bounded by {@link MAX_NANODOLLARS}. The bound is not cosmetic.
 * It is the same bound the PostgreSQL column asserts, so an amount that would
 * be rejected by the database is rejected here first, at the boundary, rather
 * than becoming a failed transaction inside an authorization path.
 *
 * Rounding, where a division is unavoidable, is always toward *more* money
 * reserved. See {@link ceilingDivideNanodollars}.
 */

declare const nanodollarsBrand: unique symbol;
declare const nonNegativeBrand: unique symbol;
declare const positiveBrand: unique symbol;

/** A signed, bounded, exact integer count of 1e-9 USD. */
export type Nanodollars = bigint & { readonly [nanodollarsBrand]: 'Nanodollars' };

/** A {@link Nanodollars} value proven to be greater than or equal to zero. */
export type NonNegativeNanodollars = Nanodollars & {
  readonly [nonNegativeBrand]: 'NonNegativeNanodollars';
};

/** A {@link Nanodollars} value proven to be strictly greater than zero. */
export type PositiveNanodollars = NonNegativeNanodollars & {
  readonly [positiveBrand]: 'PositiveNanodollars';
};

/** Nanodollars in one United States dollar. */
export const NANODOLLARS_PER_USD = 1_000_000_000n;

/**
 * Largest magnitude any single amount, balance, or intermediate result may
 * take: 1e24 nanodollars, which is 1e15 USD. Chosen to exceed any legitimate
 * tenant balance by many orders of magnitude while remaining far inside
 * `NUMERIC(38,0)`, so the database can assert the identical bound.
 */
const MAX_NANODOLLAR_MAGNITUDE = 10n ** 24n;
const MIN_NANODOLLAR_MAGNITUDE = 0n - MAX_NANODOLLAR_MAGNITUDE;

export const MAX_NANODOLLARS = MAX_NANODOLLAR_MAGNITUDE as Nanodollars;

/**
 * Most negative representable amount. A balance never reaches it — invariant I2
 * forbids that — but a ledger entry pair and a compensating adjustment are
 * signed, so the schema needs both ends of the bound.
 */
export const MIN_NANODOLLARS = MIN_NANODOLLAR_MAGNITUDE as Nanodollars;

export type MoneyErrorCode =
  | 'MONEY_DIVISOR_INVALID'
  | 'MONEY_MALFORMED_TEXT'
  | 'MONEY_NEGATIVE'
  | 'MONEY_NOT_BIGINT'
  | 'MONEY_NOT_POSITIVE'
  | 'MONEY_OUT_OF_RANGE';

/**
 * A refusal to represent or compute an amount. Every code is stable and safe
 * to expose: no message carries an operand value, because an operand can be a
 * tenant's balance.
 */
export class MoneyError extends Error {
  readonly code: MoneyErrorCode;

  constructor(code: MoneyErrorCode, message: string) {
    super(message);
    this.name = 'MoneyError';
    this.code = code;
  }
}

const CANONICAL_INTEGER = /^(?:0|-?[1-9][0-9]*)$/u;

function assertInRange(value: bigint): void {
  if (value > MAX_NANODOLLAR_MAGNITUDE || value < MIN_NANODOLLAR_MAGNITUDE) {
    throw new MoneyError(
      'MONEY_OUT_OF_RANGE',
      'A monetary amount exceeded the supported nanodollar magnitude',
    );
  }
}

/**
 * Admit a `bigint` as a signed amount. Rejects any non-bigint at the runtime
 * boundary even though the compile-time type forbids it, because amounts
 * arrive from JSON, SQL, and HTTP where the compiler has no authority.
 */
export function nanodollars(value: bigint): Nanodollars {
  if (typeof value !== 'bigint') {
    throw new MoneyError('MONEY_NOT_BIGINT', 'A monetary amount must be an exact bigint');
  }
  assertInRange(value);
  return value as Nanodollars;
}

/** Admit a `bigint` as an amount proven to be zero or greater. */
export function nonNegativeNanodollars(value: bigint): NonNegativeNanodollars {
  const amount = nanodollars(value);
  if (amount < 0n) {
    throw new MoneyError('MONEY_NEGATIVE', 'This monetary amount may not be negative');
  }
  return amount as NonNegativeNanodollars;
}

/** Admit a `bigint` as an amount proven to be strictly greater than zero. */
export function positiveNanodollars(value: bigint): PositiveNanodollars {
  const amount = nonNegativeNanodollars(value);
  if (amount === 0n) {
    throw new MoneyError('MONEY_NOT_POSITIVE', 'This monetary amount must be greater than zero');
  }
  return amount as PositiveNanodollars;
}

export const ZERO_NANODOLLARS: NonNegativeNanodollars = nonNegativeNanodollars(0n);

/**
 * Parse the canonical wire and storage form: an unpadded decimal integer, with
 * an optional leading minus sign and no other decoration.
 *
 * Deliberately refused: `+1`, `01`, `1.0`, `1e3`, `1_000`, `-0`, surrounding
 * whitespace, and the empty string. A permissive parser here would silently
 * accept a float-formatted amount from an upstream that had already lost
 * precision, which is exactly the class of bug this module exists to prevent.
 */
export function parseNanodollars(text: unknown): Nanodollars {
  if (typeof text !== 'string' || !CANONICAL_INTEGER.test(text)) {
    throw new MoneyError(
      'MONEY_MALFORMED_TEXT',
      'A monetary amount must be a canonical decimal integer string',
    );
  }
  return nanodollars(BigInt(text));
}

/** Render the canonical wire and storage form. Round-trips {@link parseNanodollars}. */
export function formatNanodollars(amount: Nanodollars): string {
  return amount.toString(10);
}

export function addNanodollars(left: Nanodollars, right: Nanodollars): Nanodollars {
  return nanodollars(left + right);
}

export function subtractNanodollars(left: Nanodollars, right: Nanodollars): Nanodollars {
  return nanodollars(left - right);
}

export function negateNanodollars(amount: Nanodollars): Nanodollars {
  return nanodollars(0n - amount);
}

export function sumNanodollars(amounts: readonly Nanodollars[]): Nanodollars {
  let total = 0n;
  for (const amount of amounts) {
    total = nanodollars(total + nanodollars(amount));
  }
  return nanodollars(total);
}

/** Sum of amounts already proven non-negative, which is itself non-negative. */
export function sumNonNegativeNanodollars(
  amounts: readonly NonNegativeNanodollars[],
): NonNegativeNanodollars {
  return nonNegativeNanodollars(sumNanodollars(amounts));
}

export function compareNanodollars(left: Nanodollars, right: Nanodollars): -1 | 0 | 1 {
  if (left < right) {
    return -1;
  }
  return left > right ? 1 : 0;
}

/**
 * Exact division rounded *up*.
 *
 * Every quote in this system is an upper bound on a cost that is not knowable
 * until the provider call finishes, so every division inside a quote must round
 * toward more money reserved. Rounding down — or, worse, rounding to nearest —
 * would let a per-token remainder settle above its own reservation, which is
 * the precise arithmetic that makes a cached-counter budget overshoot.
 */
export function ceilingDivideNanodollars(
  dividend: NonNegativeNanodollars,
  divisor: bigint,
): NonNegativeNanodollars {
  if (typeof divisor !== 'bigint' || divisor <= 0n) {
    throw new MoneyError('MONEY_DIVISOR_INVALID', 'A monetary divisor must be a positive bigint');
  }
  return nonNegativeNanodollars((dividend + divisor - 1n) / divisor);
}

/**
 * Human-facing rendering, exact to the nanodollar.
 *
 * Always shows at least two fraction digits and never more than nine, and never
 * rounds: a sub-cent amount reads as a sub-cent amount rather than as `$0.00`,
 * because `$0.00` next to a non-zero balance is a lie a user would act on.
 */
export function formatUsdExact(amount: Nanodollars): string {
  const negative = amount < 0n;
  const magnitude = negative ? 0n - amount : amount;
  const whole = magnitude / NANODOLLARS_PER_USD;
  const fraction = (magnitude % NANODOLLARS_PER_USD).toString(10).padStart(9, '0');
  const trimmed = fraction.replace(/0+$/u, '');
  const digits = trimmed.length < 2 ? fraction.slice(0, 2) : trimmed;
  return `${negative ? '-' : ''}$${whole.toString(10)}.${digits}`;
}
