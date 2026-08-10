import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  MAX_TOKEN_COUNT,
  ZERO_TOKENS,
  addTokenCounts,
  tokenCount,
  tokenCountToBigInt,
} from '../src/tokens.js';
import { attempt, refuses, returns } from './support/outcome.js';

describe('token count admission', () => {
  it('refuses every untrusted shape a provider or client can send', () => {
    const hostile: readonly unknown[] = [
      '10',
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1,
      null,
      undefined,
      {},
      [],
      10n,
      true,
    ];
    expect(hostile.map((value) => attempt(() => tokenCount(value)))).toStrictEqual(
      hostile.map(() => refuses('TOKEN_COUNT_NOT_INTEGER')),
    );
  });

  it('refuses a negative or absurd count at the boundary', () => {
    expect(attempt(() => tokenCount(-1))).toStrictEqual(refuses('TOKEN_COUNT_OUT_OF_RANGE'));
    expect(attempt(() => tokenCount(MAX_TOKEN_COUNT + 1))).toStrictEqual(
      refuses('TOKEN_COUNT_OUT_OF_RANGE'),
    );
    expect(tokenCount(MAX_TOKEN_COUNT)).toBe(MAX_TOKEN_COUNT);
    expect(ZERO_TOKENS).toBe(0);
  });

  it('normalises negative zero so a JSON round trip cannot create two distinct zeros', () => {
    expect(Object.is(tokenCount(-0), 0)).toBe(true);
  });

  it('accepts every admitted count and preserves it exactly (property, 1000 cases)', () => {
    fc.assert(
      fc.property(fc.integer({ max: MAX_TOKEN_COUNT, min: 0 }), (value) => {
        const count = tokenCount(value);
        expect(count).toBe(value);
        expect(tokenCountToBigInt(count)).toBe(BigInt(value));
      }),
      { numRuns: 1_000, seed: 20260810 },
    );
  });

  it('refuses an addition that would leave the admitted range (property, 1000 cases)', () => {
    fc.assert(
      fc.property(
        fc.integer({ max: MAX_TOKEN_COUNT, min: 0 }),
        fc.integer({ max: MAX_TOKEN_COUNT, min: 0 }),
        (left, right) => {
          const first = tokenCount(left);
          const second = tokenCount(right);
          const expected =
            left + right > MAX_TOKEN_COUNT
              ? refuses('TOKEN_COUNT_OUT_OF_RANGE')
              : returns(left + right);
          expect(attempt(() => addTokenCounts(first, second))).toStrictEqual(expected);
        },
      ),
      { numRuns: 1_000, seed: 20260810 },
    );
  });
});
