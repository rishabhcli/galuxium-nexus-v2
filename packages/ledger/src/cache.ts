/**
 * Invariant I8, encoded as a type that cannot express the forbidden outcome.
 *
 * A cache in this system may say "deny" and it may say "I do not know". It has
 * no vocabulary for "allow", because {@link CacheAdvice} has no allow variant.
 * The consequence is that no amount of Redis misconfiguration, stale key,
 * failover, or restored snapshot can authorize money: the worst a poisoned cache
 * can do is deny a request that should have succeeded, which costs availability
 * and never costs dollars.
 *
 * This is deliberately stronger than a rule that a reviewer has to notice. There
 * is no code path from a cache read to an authorization, so a future change that
 * tries to add one has to first add a variant to this union, which is a visible,
 * reviewable, invariant-violating edit rather than an innocuous-looking `if`.
 */

/**
 * Everything a cache is permitted to conclude.
 *
 * `deny` is authoritative in the safe direction: a tenant known to be disabled,
 * over its ceiling, or subject to a kill switch can be refused without touching
 * PostgreSQL. `unknown` means the caller must consult the authoritative ledger.
 */
export type CacheAdvice =
  | {
      readonly advice: 'deny';
      readonly code: CacheDenialCode;
      readonly observedAt: string;
    }
  | {
      readonly advice: 'unknown';
      readonly reason: CacheUnknownReason;
    };

export type CacheDenialCode =
  'TENANT_DISABLED' | 'TENANT_KILL_SWITCH_ENGAGED' | 'TENANT_OVER_CEILING';

export type CacheUnknownReason =
  'cache_miss' | 'cache_stale' | 'cache_unavailable' | 'cache_value_unparseable';

/** Deny, cheaply and safely, without consulting the authoritative ledger. */
export function cacheDenial(code: CacheDenialCode, observedAt: string): CacheAdvice {
  return { advice: 'deny', code, observedAt };
}

/**
 * The only other thing a cache may return. Note that every failure mode maps
 * here rather than to a permissive default: an unavailable cache produces
 * `unknown`, which sends the caller to PostgreSQL, not past it.
 */
export function cacheUnknown(reason: CacheUnknownReason): CacheAdvice {
  return { advice: 'unknown', reason };
}

/**
 * True when the caller must consult the authoritative ledger before spending.
 *
 * Exhaustive over {@link CacheAdvice}: if an allow variant is ever added, this
 * function stops compiling, which is the point.
 */
export function requiresAuthoritativeCheck(advice: CacheAdvice): boolean {
  switch (advice.advice) {
    case 'deny':
      return false;
    case 'unknown':
      return true;
  }
}
