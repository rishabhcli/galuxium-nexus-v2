const REDACTED = '[REDACTED]';
const CIRCULAR_REFERENCE = '[CIRCULAR]';
const DEPTH_LIMIT_REACHED = '[TRUNCATED:DEPTH_LIMIT]';
const ENTRY_LIMIT_REACHED = '[TRUNCATED:ENTRY_LIMIT]';
const ACCESSOR_SKIPPED = '[ACCESSOR_SKIPPED]';
const MAXIMUM_DEPTH = 12;
const MAXIMUM_ENTRIES = 256;
const MAXIMUM_KEY_LENGTH = 256;
const MAXIMUM_STRING_LENGTH = 4_096;

const SENSITIVE_FIELDS = new Set([
  'accesstoken',
  'apikey',
  'authorization',
  'clientsecret',
  'cookie',
  'databasepassword',
  'password',
  'providerapikey',
  'secret',
  'setcookie',
  'token',
]);

export type LogValue =
  boolean | number | string | null | readonly LogValue[] | { readonly [key: string]: LogValue };

interface RedactionState {
  readonly activeObjects: WeakSet<object>;
  remainingEntries: number;
}

function boundedString(value: string, maximumLength = MAXIMUM_STRING_LENGTH): string {
  if (value.length <= maximumLength) {
    return value;
  }
  const marker = '[TRUNCATED]';
  return `${value.slice(0, maximumLength - marker.length)}${marker}`;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  try {
    return Object.getPrototypeOf(value) === Object.prototype;
  } catch {
    return false;
  }
}

function isSensitiveField(key: string): boolean {
  // Field-name matching is structural and case/separator independent. This
  // catches common boundary spellings without searching arbitrary values.
  const canonicalKey = key.toLowerCase().replaceAll('-', '').replaceAll('_', '');
  return SENSITIVE_FIELDS.has(canonicalKey);
}

function safeErrorIdentifier(candidate: unknown, fallback: string): string {
  return typeof candidate === 'string' && /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/.test(candidate)
    ? candidate
    : fallback;
}

function errorValue(error: Error): LogValue {
  let name: unknown;
  let code: unknown;
  try {
    name = error.name;
    code = (error as Error & { readonly code?: unknown }).code;
  } catch {
    return { name: 'Error' };
  }

  const safeName = safeErrorIdentifier(name, 'Error');
  if (
    (typeof code === 'string' || typeof code === 'number') &&
    /^[A-Za-z0-9_.:-]{1,128}$/.test(String(code))
  ) {
    return { code: String(code), name: safeName };
  }
  return { name: safeName };
}

function ownEnumerableEntries(
  value: Record<string, unknown>,
): readonly (readonly [string, unknown])[] {
  try {
    return Object.keys(value).map((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return [
        key,
        descriptor !== undefined && 'value' in descriptor ? descriptor.value : ACCESSOR_SKIPPED,
      ] as const;
    });
  } catch {
    return [];
  }
}

function redact(value: unknown, state: RedactionState, depth: number): LogValue {
  if (value === null || typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'string') {
    return boundedString(value);
  }

  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : String(value);
  }

  if (typeof value === 'bigint') {
    return value.toString(10);
  }

  if (typeof value === 'undefined') {
    return '[UNDEFINED]';
  }

  if (typeof value === 'symbol') {
    return '[SYMBOL]';
  }

  if (value instanceof Error) {
    // Error messages, stacks, causes, and arbitrary attached fields can contain
    // credentials or user content. Only bounded identifiers are safe to retain.
    return errorValue(value);
  }

  if (depth >= MAXIMUM_DEPTH) {
    return DEPTH_LIMIT_REACHED;
  }

  if (Array.isArray(value)) {
    if (state.activeObjects.has(value)) {
      return CIRCULAR_REFERENCE;
    }
    state.activeObjects.add(value);
    try {
      const redacted: LogValue[] = [];
      for (const entry of value) {
        if (state.remainingEntries === 0) {
          redacted.push(ENTRY_LIMIT_REACHED);
          break;
        }
        state.remainingEntries -= 1;
        redacted.push(redact(entry, state, depth + 1));
      }
      return redacted;
    } finally {
      state.activeObjects.delete(value);
    }
  }

  if (isPlainRecord(value)) {
    if (state.activeObjects.has(value)) {
      return CIRCULAR_REFERENCE;
    }
    state.activeObjects.add(value);
    try {
      const redacted: Record<string, LogValue> = {};
      for (const [rawKey, entry] of ownEnumerableEntries(value)) {
        if (state.remainingEntries === 0) {
          redacted['[TRUNCATED]'] = ENTRY_LIMIT_REACHED;
          break;
        }
        state.remainingEntries -= 1;
        const key = boundedString(rawKey, MAXIMUM_KEY_LENGTH);
        redacted[key] = isSensitiveField(rawKey) ? REDACTED : redact(entry, state, depth + 1);
      }
      return redacted;
    } finally {
      state.activeObjects.delete(value);
    }
  }

  return '[UNSUPPORTED_LOG_VALUE]';
}

/**
 * Redacts complete values at typed structural fields and places deterministic
 * bounds on recursive or attacker-controlled log context. It never searches or
 * rewrites arbitrary message text, which avoids partial-secret leakage.
 */
export function redactLogValue(value: unknown): LogValue {
  try {
    return redact(
      value,
      {
        activeObjects: new WeakSet<object>(),
        remainingEntries: MAXIMUM_ENTRIES,
      },
      0,
    );
  } catch {
    // Proxies can throw from fundamental classification operations including
    // Array.isArray and instanceof. Logging must always fail closed rather than
    // crash the application or retry with an unsafe serializer.
    return '[UNSUPPORTED_LOG_VALUE]';
  }
}
