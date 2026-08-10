import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  type CacheAdvice,
  type CacheDenialCode,
  type CacheUnknownReason,
  cacheDenial,
  cacheUnknown,
  requiresAuthoritativeCheck,
} from '../src/cache.js';

const DENIAL_CODES: readonly CacheDenialCode[] = [
  'TENANT_DISABLED',
  'TENANT_KILL_SWITCH_ENGAGED',
  'TENANT_OVER_CEILING',
];

const UNKNOWN_REASONS: readonly CacheUnknownReason[] = [
  'cache_miss',
  'cache_stale',
  'cache_unavailable',
  'cache_value_unparseable',
];

describe('I8: caches may deny unnecessarily but may never authorize money', () => {
  it('has no vocabulary for allowing anything (property, 1000 cases)', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc
            .constantFrom(...DENIAL_CODES)
            .map((code) => cacheDenial(code, '2026-08-10T12:00:00.000000Z')),
          fc.constantFrom(...UNKNOWN_REASONS).map((reason) => cacheUnknown(reason)),
        ),
        (advice: CacheAdvice) => {
          // The union is exhausted by exactly these two values. There is no
          // third variant to enumerate, so no cache read can produce one.
          expect(['deny', 'unknown']).toContain(advice.advice);
        },
      ),
      { numRuns: 1_000, seed: 20260810 },
    );
  });

  it('sends every failure mode to the authoritative ledger rather than past it', () => {
    for (const reason of UNKNOWN_REASONS) {
      expect(requiresAuthoritativeCheck(cacheUnknown(reason))).toBe(true);
    }
  });

  it('lets a denial short-circuit without consulting the ledger', () => {
    for (const code of DENIAL_CODES) {
      const advice = cacheDenial(code, '2026-08-10T12:00:00.000000Z');
      expect(requiresAuthoritativeCheck(advice)).toBe(false);
      expect(advice).toMatchObject({ advice: 'deny', code });
    }
  });

  it('treats an unavailable cache as unknown, never as permission', () => {
    // The precise failure the invariant exists for: a Redis outage or a restored
    // snapshot must cost availability or a database round trip, never dollars.
    expect(requiresAuthoritativeCheck(cacheUnknown('cache_unavailable'))).toBe(true);
    expect(requiresAuthoritativeCheck(cacheUnknown('cache_stale'))).toBe(true);
    expect(requiresAuthoritativeCheck(cacheUnknown('cache_value_unparseable'))).toBe(true);
  });
});
