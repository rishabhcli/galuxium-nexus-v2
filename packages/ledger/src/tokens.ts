/**
 * Token counts as a bounded domain type.
 *
 * Token counts arrive from three places that all lie in different ways: a
 * client's requested `max_tokens`, a provider's reported usage, and this
 * system's own count of tokens it actually forwarded. All three are admitted
 * through {@link tokenCount}, so a negative, fractional, `NaN`, or absurd count
 * is refused at the boundary instead of propagating into a quote.
 */

declare const tokenCountBrand: unique symbol;

/** A count of tokens: an integer between zero and {@link MAX_TOKEN_COUNT}. */
export type TokenCount = number & { readonly [tokenCountBrand]: 'TokenCount' };

/**
 * Largest admitted token count for a single counted quantity: 1e8.
 *
 * Two orders of magnitude above any published context window, and chosen so
 * that `MAX_TOKEN_COUNT * MAX_NANODOLLARS_PER_MILLION_TOKENS` stays far inside
 * the ledger's amount bound, making token-priced arithmetic incapable of
 * overflowing before the amount bound itself refuses.
 */
export const MAX_TOKEN_COUNT = 100_000_000;

export type TokenCountErrorCode = 'TOKEN_COUNT_NOT_INTEGER' | 'TOKEN_COUNT_OUT_OF_RANGE';

export class TokenCountError extends Error {
  readonly code: TokenCountErrorCode;

  constructor(code: TokenCountErrorCode, message: string) {
    super(message);
    this.name = 'TokenCountError';
    this.code = code;
  }
}

/**
 * Admit an untrusted value as a token count.
 *
 * `-0` is normalised to `0` so that a count cannot round-trip through JSON as
 * `-0` and then compare unequal to a structurally identical count.
 */
export function tokenCount(value: unknown): TokenCount {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new TokenCountError('TOKEN_COUNT_NOT_INTEGER', 'A token count must be a safe integer');
  }
  if (value < 0 || value > MAX_TOKEN_COUNT) {
    throw new TokenCountError(
      'TOKEN_COUNT_OUT_OF_RANGE',
      'A token count must be between zero and the supported maximum',
    );
  }
  return (value === 0 ? 0 : value) as TokenCount;
}

export const ZERO_TOKENS: TokenCount = tokenCount(0);

export function addTokenCounts(left: TokenCount, right: TokenCount): TokenCount {
  return tokenCount(left + right);
}

/** Widen a token count into exact integer arithmetic for monetary use. */
export function tokenCountToBigInt(count: TokenCount): bigint {
  return BigInt(count);
}
