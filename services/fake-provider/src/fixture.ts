import { createHash } from 'node:crypto';

import { z } from 'zod';

export const fixtureProviderRequestSchema = z
  .object({
    max_tokens: z.number().int().min(1).max(256),
    messages: z
      .array(
        z
          .object({
            content: z.string().max(8_192),
            role: z.enum(['assistant', 'system', 'user']),
          })
          .strict(),
      )
      .min(1)
      .max(32),
    model: z.literal('fixture-text-v1'),
    stream: z.literal(false).optional().default(false),
  })
  .strict();

export const fixtureProviderModeSchema = z.enum(['success', 'http_error', 'malformed', 'slow']);

export interface DeterministicFixtureUsage {
  readonly completionTokens: number;
  readonly id: string;
  readonly promptTokens: number;
}

export function deterministicFixtureUsage(
  request: z.infer<typeof fixtureProviderRequestSchema>,
): DeterministicFixtureUsage {
  const canonical = JSON.stringify(request);
  const digest = createHash('sha256').update(canonical).digest('hex');
  const promptCharacters = request.messages.reduce(
    (total, message) => total + Array.from(message.content).length,
    0,
  );
  const promptTokens = Math.max(1, Math.ceil(promptCharacters / 4));
  const sample = Number.parseInt(digest.slice(0, 8), 16);
  const completionTokens = 1 + (sample % request.max_tokens);
  return { completionTokens, id: `fixture-${digest.slice(0, 24)}`, promptTokens };
}
