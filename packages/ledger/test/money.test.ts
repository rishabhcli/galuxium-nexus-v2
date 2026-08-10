import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  MAX_NANODOLLARS,
  MIN_NANODOLLARS,
  NANODOLLARS_PER_USD,
  ZERO_NANODOLLARS,
  addNanodollars,
  ceilingDivideNanodollars,
  compareNanodollars,
  formatNanodollars,
  formatUsdExact,
  nanodollars,
  negateNanodollars,
  nonNegativeNanodollars,
  parseNanodollars,
  positiveNanodollars,
  subtractNanodollars,
  sumNanodollars,
} from '../src/money.js';
import { attempt, refuses, returns } from './support/outcome.js';

const anyAmount = fc.bigInt({ max: MAX_NANODOLLARS, min: MIN_NANODOLLARS }).map(nanodollars);
const anyNonNegative = fc
  .bigInt({ max: MAX_NANODOLLARS, min: 0n })
  .map((value) => nonNegativeNanodollars(value));
const anyDivisor = fc.bigInt({ max: 10n ** 12n, min: 1n });

describe('nanodollar admission', () => {
  it('refuses a non-bigint amount even where the compiler forbids one', () => {
    // Amounts arrive from SQL, JSON, and HTTP, where the compiler has no say.
    expect(attempt(() => nanodollars(1 as unknown as bigint))).toStrictEqual(
      refuses('MONEY_NOT_BIGINT'),
    );
    expect(attempt(() => nanodollars('1' as unknown as bigint))).toStrictEqual(
      refuses('MONEY_NOT_BIGINT'),
    );
    expect(attempt(() => nanodollars(null as unknown as bigint))).toStrictEqual(
      refuses('MONEY_NOT_BIGINT'),
    );
  });

  it('refuses an amount one nanodollar beyond the supported magnitude in both directions', () => {
    expect(attempt(() => nanodollars(MAX_NANODOLLARS))).toStrictEqual(returns(MAX_NANODOLLARS));
    expect(attempt(() => nanodollars(MIN_NANODOLLARS))).toStrictEqual(returns(MIN_NANODOLLARS));
    expect(attempt(() => nanodollars(MAX_NANODOLLARS + 1n))).toStrictEqual(
      refuses('MONEY_OUT_OF_RANGE'),
    );
    expect(attempt(() => nanodollars(MIN_NANODOLLARS - 1n))).toStrictEqual(
      refuses('MONEY_OUT_OF_RANGE'),
    );
  });

  it('separates zero-or-greater from strictly-greater-than-zero', () => {
    expect(attempt(() => nonNegativeNanodollars(0n))).toStrictEqual(returns(0n));
    expect(attempt(() => positiveNanodollars(1n))).toStrictEqual(returns(1n));
    expect(attempt(() => nonNegativeNanodollars(-1n))).toStrictEqual(refuses('MONEY_NEGATIVE'));
    expect(attempt(() => positiveNanodollars(0n))).toStrictEqual(refuses('MONEY_NOT_POSITIVE'));
  });
});

describe('I2 boundary: bounded exact arithmetic', () => {
  it('never silently produces an amount outside the supported magnitude (property, 1000 cases)', () => {
    fc.assert(
      fc.property(anyAmount, anyAmount, (left, right) => {
        const exactSum = left + right;
        const expected =
          exactSum > MAX_NANODOLLARS || exactSum < MIN_NANODOLLARS
            ? refuses('MONEY_OUT_OF_RANGE')
            : returns(exactSum);
        expect(attempt(() => addNanodollars(left, right))).toStrictEqual(expected);
      }),
      { numRuns: 1_000, seed: 20260810 },
    );
  });

  it('keeps addition and subtraction exactly inverse with no accumulated drift (property, 1000 cases)', () => {
    fc.assert(
      fc.property(anyAmount, anyAmount, (left, right) => {
        const exactSum = left + right;
        fc.pre(exactSum <= MAX_NANODOLLARS && exactSum >= MIN_NANODOLLARS);
        expect(subtractNanodollars(addNanodollars(left, right), right)).toBe(left);
        expect(negateNanodollars(negateNanodollars(left))).toBe(left);
      }),
      { numRuns: 1_000, seed: 20260810 },
    );
  });

  it('sums a list identically regardless of order (property, 1000 cases)', () => {
    fc.assert(
      fc.property(
        fc.array(fc.bigInt({ max: 10n ** 15n, min: -(10n ** 15n) }).map(nanodollars), {
          maxLength: 64,
          minLength: 0,
        }),
        (amounts) => {
          const forward = sumNanodollars(amounts);
          expect(forward).toBe(sumNanodollars([...amounts].reverse()));
          expect(forward).toBe(amounts.reduce<bigint>((total, amount) => total + amount, 0n));
        },
      ),
      { numRuns: 1_000, seed: 20260810 },
    );
  });
});

describe('canonical wire form', () => {
  it('round-trips every representable amount through text without loss (property, 1000 cases)', () => {
    fc.assert(
      fc.property(anyAmount, (amount) => {
        expect(parseNanodollars(formatNanodollars(amount))).toBe(amount);
      }),
      { numRuns: 1_000, seed: 20260810 },
    );
  });

  it('refuses every non-canonical spelling of a number', () => {
    const refused = [
      '',
      ' 1',
      '1 ',
      '+1',
      '01',
      '-01',
      '-0',
      '1.0',
      '0.000000001',
      '1e3',
      '1_000',
      '0x10',
      'NaN',
      'Infinity',
      '--1',
      '1n',
    ];
    expect(refused.map((text) => attempt(() => parseNanodollars(text)))).toStrictEqual(
      refused.map(() => refuses('MONEY_MALFORMED_TEXT')),
    );
    expect(attempt(() => parseNanodollars(1n))).toStrictEqual(refuses('MONEY_MALFORMED_TEXT'));
    expect(parseNanodollars('0')).toBe(0n);
    expect(parseNanodollars('-1')).toBe(-1n);
  });

  it('refuses a float-formatted amount that has already lost precision upstream', () => {
    // 0.1 + 0.2 in binary floating point; a permissive parser would accept the
    // drifted value and the ledger would inherit somebody else's rounding.
    expect(attempt(() => parseNanodollars(String(0.1 + 0.2)))).toStrictEqual(
      refuses('MONEY_MALFORMED_TEXT'),
    );
    expect(attempt(() => parseNanodollars(String(1e21)))).toStrictEqual(
      refuses('MONEY_MALFORMED_TEXT'),
    );
  });
});

describe('worst-case rounding direction', () => {
  it('always rounds a division up, never down and never to nearest (property, 1000 cases)', () => {
    fc.assert(
      fc.property(anyNonNegative, anyDivisor, (dividend, divisor) => {
        const result = ceilingDivideNanodollars(dividend, divisor);
        const floor = dividend / divisor;
        expect(result).toBe(dividend % divisor === 0n ? floor : floor + 1n);
        // The defining property: multiplying back never under-covers the input.
        expect(result * divisor >= dividend).toBe(true);
        expect((result - 1n) * divisor < dividend).toBe(true);
      }),
      { numRuns: 1_000, seed: 20260810 },
    );
  });

  it('is monotonically non-decreasing in the dividend (property, 1000 cases)', () => {
    fc.assert(
      fc.property(anyNonNegative, anyNonNegative, anyDivisor, (left, right, divisor) => {
        const [smaller, larger] = left <= right ? [left, right] : [right, left];
        expect(
          ceilingDivideNanodollars(larger, divisor) >= ceilingDivideNanodollars(smaller, divisor),
        ).toBe(true);
      }),
      { numRuns: 1_000, seed: 20260810 },
    );
  });

  it('refuses a zero or negative divisor rather than returning an unbounded amount', () => {
    expect(attempt(() => ceilingDivideNanodollars(ZERO_NANODOLLARS, 0n))).toStrictEqual(
      refuses('MONEY_DIVISOR_INVALID'),
    );
    expect(attempt(() => ceilingDivideNanodollars(ZERO_NANODOLLARS, -1n))).toStrictEqual(
      refuses('MONEY_DIVISOR_INVALID'),
    );
    expect(
      attempt(() => ceilingDivideNanodollars(ZERO_NANODOLLARS, 1 as unknown as bigint)),
    ).toStrictEqual(refuses('MONEY_DIVISOR_INVALID'));
  });
});

describe('ordering', () => {
  it('orders amounts by exact value (property, 1000 cases)', () => {
    fc.assert(
      fc.property(anyAmount, anyAmount, (left, right) => {
        const ordering = compareNanodollars(left, right);
        expect(ordering).toBe(left < right ? -1 : left > right ? 1 : 0);
        // Written without unary negation so a reversed zero stays exactly `0`
        // rather than `-0`, which `Object.is` treats as a different value.
        expect(compareNanodollars(right, left)).toBe(ordering === 0 ? 0 : ordering * -1);
      }),
      { numRuns: 1_000, seed: 20260810 },
    );
  });
});

describe('human-facing rendering', () => {
  it('never renders a non-zero amount as zero', () => {
    expect(formatUsdExact(nanodollars(1n))).toBe('$0.000000001');
    expect(formatUsdExact(nanodollars(499_700_000n))).toBe('$0.4997');
    expect(formatUsdExact(nanodollars(NANODOLLARS_PER_USD))).toBe('$1.00');
    expect(formatUsdExact(nanodollars(-2_500_000_000n))).toBe('-$2.50');
    expect(formatUsdExact(ZERO_NANODOLLARS)).toBe('$0.00');
  });

  it('renders every non-zero amount as something other than a zero string (property, 1000 cases)', () => {
    fc.assert(
      fc.property(anyAmount, (amount) => {
        const rendered = formatUsdExact(amount);
        const zeroStrings = amount === 0n ? [] : ['$0.00', '-$0.00'];
        expect(zeroStrings.includes(rendered)).toBe(false);
        expect(rendered).toMatch(/^-?\$[0-9]+\.[0-9]{2,9}$/u);
      }),
      { numRuns: 1_000, seed: 20260810 },
    );
  });
});
