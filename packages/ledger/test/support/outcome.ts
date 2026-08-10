/**
 * Test support: turn "did this refuse, and with which code" into a value.
 *
 * Assertions about refusals are easy to write in a way that can silently stop
 * asserting — an `expect` inside a `catch`, or inside a branch of a property
 * test, runs only when the code under test behaves the way the test already
 * assumed. Converting the outcome into a comparable value instead means every
 * test compares one whole result against one whole expectation, unconditionally,
 * so a refusal that stops happening fails loudly rather than passing quietly.
 */

export type Attempt<T> =
  { readonly ok: true; readonly value: T } | { readonly code: string; readonly ok: false };

/**
 * Run an operation and describe what happened.
 *
 * A thrown value carrying a string `code` reports that code; anything else
 * reports its constructor name, so an unexpected `TypeError` can never be
 * mistaken for an expected domain refusal.
 */
export function attempt<T>(operation: () => T): Attempt<T> {
  try {
    return { ok: true, value: operation() };
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error) {
      const { code } = error;
      if (typeof code === 'string') {
        return { code, ok: false };
      }
    }
    return { code: `UNEXPECTED_${error instanceof Error ? error.name : typeof error}`, ok: false };
  }
}

/** The expectation that an operation returned this value. */
export function returns<T>(value: T): Attempt<T> {
  return { ok: true, value };
}

/** The expectation that an operation refused with this stable code. */
export function refuses(code: string): Attempt<never> {
  return { code, ok: false };
}
