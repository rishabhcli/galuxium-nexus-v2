import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { deterministicFixtureUsage, fixtureProviderRequestSchema } from '../src/fixture.js';

describe('deterministic fixture usage', () => {
  it('returns exactly the same identifier and usage for the same request', () => {
    const request = fixtureProviderRequestSchema.parse({
      max_tokens: 64,
      messages: [{ content: 'bounded fixture input', role: 'user' }],
      model: 'fixture-text-v1',
      stream: false,
    });

    expect(deterministicFixtureUsage(request)).toEqual(deterministicFixtureUsage(request));
  });

  it('keeps generated usage inside the declared maximum for 1,000 generated requests', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 256 }),
        fc.string({ maxLength: 2_048 }),
        (maximumTokens, content) => {
          const request = fixtureProviderRequestSchema.parse({
            max_tokens: maximumTokens,
            messages: [{ content, role: 'user' }],
            model: 'fixture-text-v1',
            stream: false,
          });
          const usage = deterministicFixtureUsage(request);
          expect(usage.completionTokens).toBeGreaterThanOrEqual(1);
          expect(usage.completionTokens).toBeLessThanOrEqual(maximumTokens);
          expect(usage.promptTokens).toBeGreaterThanOrEqual(1);
          expect(usage.id).toMatch(/^fixture-[a-f0-9]{24}$/);
        },
      ),
      { numRuns: 1_000, seed: 20_260_809 },
    );
  });
});

describe('fixture provider request boundary', () => {
  it.each([
    { max_tokens: 0, messages: [{ content: 'x', role: 'user' }], model: 'fixture-text-v1' },
    { max_tokens: 1, messages: [], model: 'fixture-text-v1' },
    { max_tokens: 1, messages: [{ content: 'x', role: 'user' }], model: 'unknown' },
    {
      max_tokens: 1,
      messages: [{ content: 'x', role: 'user' }],
      model: 'fixture-text-v1',
      stream: true,
    },
    {
      extra: 'not accepted',
      max_tokens: 1,
      messages: [{ content: 'x', role: 'user' }],
      model: 'fixture-text-v1',
    },
  ])('refuses unsupported input %#', (candidate) => {
    expect(fixtureProviderRequestSchema.safeParse(candidate).success).toBe(false);
  });
});
