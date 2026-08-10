import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  MAX_INSTANT_MICROSECONDS,
  MIN_INSTANT_MICROSECONDS,
  addMicroseconds,
  earlierInstant,
  formatInstantIsoUtc,
  instantFromIsoUtc,
  instantUtc,
  isAtOrAfter,
} from '../src/time.js';
import { attempt, refuses, returns } from './support/outcome.js';

const anyInstant = fc
  .bigInt({ max: 4_000_000_000_000_000n, min: 0n })
  .map((value) => instantUtc(value));

describe('instant admission', () => {
  it('refuses a non-bigint and an out-of-range instant', () => {
    expect(attempt(() => instantUtc(1 as unknown as bigint))).toStrictEqual(
      refuses('INSTANT_NOT_BIGINT'),
    );
    expect(attempt(() => instantUtc(MAX_INSTANT_MICROSECONDS + 1n))).toStrictEqual(
      refuses('INSTANT_OUT_OF_RANGE'),
    );
    expect(attempt(() => instantUtc(MIN_INSTANT_MICROSECONDS - 1n))).toStrictEqual(
      refuses('INSTANT_OUT_OF_RANGE'),
    );
    expect(attempt(() => instantUtc(MAX_INSTANT_MICROSECONDS))).toStrictEqual(
      returns(MAX_INSTANT_MICROSECONDS),
    );
  });

  it('refuses a timestamp carrying a non-UTC offset rather than converting it', () => {
    // Converting would make the stored instant depend on the caller's
    // formatting, and a caller that formats an offset may already have applied
    // one.
    const offsets = ['2026-08-10T12:00:00+05:30', '2026-08-10T12:00:00-07:00'];
    expect(offsets.map((text) => attempt(() => instantFromIsoUtc(text)))).toStrictEqual(
      offsets.map(() => refuses('INSTANT_NOT_UTC')),
    );
  });

  it('refuses every malformed or impossible calendar time', () => {
    const refused: readonly unknown[] = [
      '',
      '2026-08-10',
      '2026-08-10T12:00',
      '2026-08-10 12:00:00Z',
      '2026-13-01T00:00:00Z',
      '2026-02-30T00:00:00Z',
      '2026-08-10T25:00:00Z',
      '2026-08-10T12:00:60Z',
      '2026-8-10T12:00:00Z',
      'not-a-time',
      '2026-08-10T12:00:00.1234567Z',
      0,
      null,
    ];
    expect(refused.map((value) => attempt(() => instantFromIsoUtc(value)))).toStrictEqual(
      refused.map(() => refuses('INSTANT_MALFORMED_TEXT')),
    );
  });

  it('reads microsecond precision exactly, at every fraction width', () => {
    expect(instantFromIsoUtc('1970-01-01T00:00:00Z')).toBe(0n);
    expect(instantFromIsoUtc('1970-01-01T00:00:00.000001Z')).toBe(1n);
    expect(instantFromIsoUtc('1970-01-01T00:00:00.1Z')).toBe(100_000n);
    expect(instantFromIsoUtc('1970-01-01T00:00:00.123456Z')).toBe(123_456n);
    // Epoch second independently confirmed with the system clock, not with this
    // module: `date -u -j -f %Y-%m-%dT%H:%M:%SZ 2026-08-10T12:34:56Z +%s`
    // prints 1786365296.
    expect(instantFromIsoUtc('2026-08-10T12:34:56.654321Z')).toBe(1_786_365_296_654_321n);
  });
});

describe('canonical instant form (property, 1000 cases)', () => {
  it('round-trips every instant through text with no loss of microseconds', () => {
    fc.assert(
      fc.property(anyInstant, (instant) => {
        const rendered = formatInstantIsoUtc(instant);
        expect(rendered).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/u);
        expect(instantFromIsoUtc(rendered)).toBe(instant);
      }),
      { numRuns: 1_000, seed: 20260810 },
    );
  });

  it('orders text lexicographically in the same order as the instants', () => {
    fc.assert(
      fc.property(anyInstant, anyInstant, (left, right) => {
        const leftText = formatInstantIsoUtc(left);
        const rightText = formatInstantIsoUtc(right);
        const instantOrder = left < right ? -1 : left > right ? 1 : 0;
        const textOrder = leftText < rightText ? -1 : leftText > rightText ? 1 : 0;
        expect(textOrder).toBe(instantOrder);
      }),
      { numRuns: 1_000, seed: 20260810 },
    );
  });
});

describe('instant arithmetic', () => {
  it('refuses an offset that leaves the storable range instead of wrapping', () => {
    expect(attempt(() => addMicroseconds(instantUtc(MAX_INSTANT_MICROSECONDS), 1n))).toStrictEqual(
      refuses('INSTANT_OUT_OF_RANGE'),
    );
  });

  it('compares and selects without floating point (property, 1000 cases)', () => {
    fc.assert(
      fc.property(anyInstant, anyInstant, (left, right) => {
        expect(isAtOrAfter(left, right)).toBe(left >= right);
        expect(earlierInstant(left, right)).toBe(left <= right ? left : right);
      }),
      { numRuns: 1_000, seed: 20260810 },
    );
  });

  it('adds an expiry window exactly', () => {
    const base = instantFromIsoUtc('2026-08-10T12:00:00.000000Z');
    expect(formatInstantIsoUtc(addMicroseconds(base, 30_000_000n))).toBe(
      '2026-08-10T12:00:30.000000Z',
    );
  });
});
