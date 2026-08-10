import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { createLogger } from '../src/logger.js';
import { redactLogValue } from '../src/redaction.js';

const SENSITIVE_KEYS = [
  'authorization',
  'Authorization',
  'access_token',
  'accessToken',
  'api-key',
  'client_secret',
  'cookie',
  'Cookie',
  'database_password',
  'password',
  'PASSWORD',
  'providerApiKey',
  'provider_api_key',
  'secret',
  'set-cookie',
  'token',
] as const;

function nestThroughObjectsAndArrays(value: unknown, arrayPath: readonly boolean[]): unknown {
  return arrayPath.reduceRight<unknown>((nested, useArray, index) => {
    if (useArray) {
      return [{ visible: `public-${String(index)}` }, nested];
    }
    return {
      [`safe_level_${String(index)}`]: nested,
      visible: `public-${String(index)}`,
    };
  }, value);
}

describe('redactLogValue', () => {
  it('redacts every declared sensitive structural key at arbitrary object and array depth', () => {
    const sensitiveRecord = Object.fromEntries(
      SENSITIVE_KEYS.map((key) => [key, { nested: `private-${key}` }]),
    );

    expect(
      redactLogValue({
        list: [{ visible: 'public' }, sensitiveRecord],
        nested: {
          authorization: 'Bearer private-credential',
          visible: 'still-public',
        },
      }),
    ).toEqual({
      list: [
        { visible: 'public' },
        Object.fromEntries(SENSITIVE_KEYS.map((key) => [key, '[REDACTED]'])),
      ],
      nested: {
        authorization: '[REDACTED]',
        visible: 'still-public',
      },
    });
  });

  it('does not perform unsafe substring rewriting of non-sensitive structural fields', () => {
    expect(
      redactLogValue({
        authorizationStatus: 'authorization denied',
        message: 'the token field was absent',
        passwordLength: 20,
      }),
    ).toEqual({
      authorizationStatus: 'authorization denied',
      message: 'the token field was absent',
      passwordLength: 20,
    });
  });

  it('never serializes an Error message, stack, cause, or unsafe error identifier', () => {
    const secretMarker = 'private-error-message-credential';
    const error = new Error(secretMarker, {
      cause: new Error(`cause-${secretMarker}`),
    }) as Error & {
      code?: string;
      password?: string;
    };
    error.name = `Unsafe Name ${secretMarker}`;
    error.code = `unsafe code ${secretMarker}`;
    error.password = secretMarker;

    const serialized = JSON.stringify(redactLogValue({ error }));

    expect(serialized).toBe('{"error":{"name":"Error"}}');
    expect(serialized).not.toContain(secretMarker);
  });

  it('retains only allow-listed Error name and code identifiers', () => {
    const error = new Error('hostile message') as NodeJS.ErrnoException;
    error.name = 'DependencyError';
    error.code = 'ECONNREFUSED';

    expect(redactLogValue(error)).toEqual({ code: 'ECONNREFUSED', name: 'DependencyError' });
  });

  it('fails closed when a revoked Proxy throws during value classification', () => {
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();

    expect(() => redactLogValue(proxy)).not.toThrow();
    expect(redactLogValue(proxy)).toBe('[UNSUPPORTED_LOG_VALUE]');
  });

  it('bounds circular references, depth, entry count, string size, and accessor execution', () => {
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    let deeplyNested: unknown = 'leaf';
    for (let index = 0; index < 20; index += 1) {
      deeplyNested = { nested: deeplyNested };
    }
    const oversizedEntries = Object.fromEntries(
      Array.from({ length: 400 }, (_, index) => [`entry-${String(index)}`, index]),
    );
    const accessorRecord: Record<string, unknown> = {};
    Object.defineProperty(accessorRecord, 'unsafeAccessor', {
      enumerable: true,
      get: () => {
        throw new Error('must not execute');
      },
    });

    const redactedCircular = redactLogValue(circular);
    const redactedDepth = JSON.stringify(redactLogValue(deeplyNested));
    const redactedEntries = redactLogValue(oversizedEntries) as Record<string, unknown>;
    const redactedString = redactLogValue('x'.repeat(8_192));

    expect(redactedCircular).toEqual({ self: '[CIRCULAR]' });
    expect(redactedDepth).toContain('[TRUNCATED:DEPTH_LIMIT]');
    expect(Object.keys(redactedEntries)).toHaveLength(257);
    expect(redactedEntries['[TRUNCATED]']).toBe('[TRUNCATED:ENTRY_LIMIT]');
    expect(typeof redactedString).toBe('string');
    expect((redactedString as string).length).toBe(4_096);
    expect(redactLogValue(accessorRecord)).toEqual({ unsafeAccessor: '[ACCESSOR_SKIPPED]' });
  });

  it('property: sensitive structural values never serialize (1,000 cases)', () => {
    const sensitiveKeyArbitrary = fc.constantFrom(...SENSITIVE_KEYS);
    const secretMarkerArbitrary = fc.uuid().map((identifier) => `private-marker-${identifier}`);
    const pathArbitrary = fc.array(fc.boolean(), { maxLength: 8 });

    fc.assert(
      fc.property(
        sensitiveKeyArbitrary,
        secretMarkerArbitrary,
        pathArbitrary,
        fc.boolean(),
        (sensitiveKey, secretMarker, arrayPath, useStructuredSecret) => {
          const secretValue = useStructuredSecret
            ? {
                array: [secretMarker, { repeated: secretMarker }],
                nested: secretMarker,
              }
            : secretMarker;
          const context = nestThroughObjectsAndArrays(
            {
              [sensitiveKey]: secretValue,
              visible: 'public-value',
            },
            arrayPath,
          );
          const serializedLines: string[] = [];
          const logger = createLogger({
            minimumLevel: 'debug',
            now: () => new Date('2026-08-09T00:00:00.000Z'),
            service: 'redaction-property-test',
            write: (line) => serializedLines.push(line),
          });

          logger.info('observability.redaction_property', context);

          const serialized = serializedLines.at(0);
          if (serialized === undefined) {
            throw new Error('The logger did not serialize the accepted record.');
          }
          expect(serializedLines).toHaveLength(1);
          expect(serialized).toContain('[REDACTED]');
          expect(serialized).not.toContain(secretMarker);
        },
      ),
      {
        numRuns: 1_000,
        seed: 1_592_637_662,
      },
    );
  });
});
