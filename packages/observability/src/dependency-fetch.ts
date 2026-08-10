import { z } from 'zod';

const DEFAULT_MAXIMUM_BYTES = 16_384;
const MINIMUM_MAXIMUM_BYTES = 256;
const MAXIMUM_MAXIMUM_BYTES = 1_048_576;

export type DependencyFetchErrorCode =
  | 'DEPENDENCY_FETCH_ABORTED'
  | 'DEPENDENCY_FETCH_FAILED'
  | 'DEPENDENCY_HTTP_STATUS_INVALID'
  | 'DEPENDENCY_JSON_INVALID'
  | 'DEPENDENCY_RESPONSE_BODY_MISSING'
  | 'DEPENDENCY_RESPONSE_CONTENT_TYPE_INVALID'
  | 'DEPENDENCY_RESPONSE_SCHEMA_INVALID'
  | 'DEPENDENCY_RESPONSE_TOO_LARGE';

export class DependencyFetchError extends Error {
  readonly code: DependencyFetchErrorCode;

  constructor(code: DependencyFetchErrorCode, message: string) {
    super(message);
    this.name = 'DependencyFetchError';
    this.code = code;
  }
}

export interface BoundedJsonFetchOptions<Output> {
  readonly maximumBytes?: number;
  readonly schema: z.ZodType<Output>;
  readonly signal: AbortSignal;
  readonly url: string | URL;
}

const readinessCheckSchema = z.strictObject({
  durationMs: z.number().nonnegative(),
  name: z.string().min(1).max(128),
  status: z.enum(['ready', 'not_ready']),
});

const serviceReadinessSchema = z.strictObject({
  checks: z.array(readinessCheckSchema).max(64),
  service: z.string().min(1).max(128),
  status: z.enum(['ready', 'not_ready']),
  version: z.string().min(1).max(128),
});

export type ServiceReadinessDocument = z.infer<typeof serviceReadinessSchema>;

function abortedError(): DependencyFetchError {
  return new DependencyFetchError(
    'DEPENDENCY_FETCH_ABORTED',
    'The dependency request was cancelled.',
  );
}

function isAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}

function validateMaximumBytes(candidate: number): number {
  if (
    !Number.isSafeInteger(candidate) ||
    candidate < MINIMUM_MAXIMUM_BYTES ||
    candidate > MAXIMUM_MAXIMUM_BYTES
  ) {
    throw new RangeError(
      `Dependency response limit must be an integer between ${String(MINIMUM_MAXIMUM_BYTES)} and ${String(MAXIMUM_MAXIMUM_BYTES)} bytes.`,
    );
  }
  return candidate;
}

async function readBoundedBody(
  response: Response,
  maximumBytes: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const body = response.body;
  if (body === null) {
    throw new DependencyFetchError(
      'DEPENDENCY_RESPONSE_BODY_MISSING',
      'The dependency response did not include a body.',
    );
  }

  const reader = (body as ReadableStream<Uint8Array>).getReader();
  let rejectForAbort: ((error: DependencyFetchError) => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectForAbort = reject;
  });
  const onAbort = (): void => {
    rejectForAbort?.(abortedError());
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener('abort', onAbort, { once: true });

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    if (isAborted(signal)) {
      await reader.cancel().catch(() => undefined);
      throw abortedError();
    }
    for (;;) {
      const result = await Promise.race([reader.read(), aborted]);
      if (result.done) {
        break;
      }
      totalBytes += result.value.byteLength;
      if (totalBytes > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        throw new DependencyFetchError(
          'DEPENDENCY_RESPONSE_TOO_LARGE',
          'The dependency response exceeded its byte limit.',
        );
      }
      chunks.push(result.value);
    }
  } finally {
    signal.removeEventListener('abort', onAbort);
    reader.releaseLock();
  }

  const combined = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return combined;
}

/**
 * Fetches and validates a bounded JSON dependency document. Redirects are
 * rejected and the streaming byte limit is enforced even when Content-Length
 * is absent or dishonest.
 */
export async function fetchBoundedJson<Output>(
  options: BoundedJsonFetchOptions<Output>,
): Promise<Output> {
  const maximumBytes = validateMaximumBytes(options.maximumBytes ?? DEFAULT_MAXIMUM_BYTES);
  if (isAborted(options.signal)) {
    throw abortedError();
  }

  let response: Response;
  try {
    response = await fetch(options.url, {
      headers: { accept: 'application/json' },
      redirect: 'error',
      signal: options.signal,
    });
  } catch {
    if (isAborted(options.signal)) {
      throw abortedError();
    }
    throw new DependencyFetchError('DEPENDENCY_FETCH_FAILED', 'The dependency request failed.');
  }

  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new DependencyFetchError(
      'DEPENDENCY_HTTP_STATUS_INVALID',
      'The dependency returned an unsuccessful HTTP status.',
    );
  }

  const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (contentType !== 'application/json') {
    await response.body?.cancel().catch(() => undefined);
    throw new DependencyFetchError(
      'DEPENDENCY_RESPONSE_CONTENT_TYPE_INVALID',
      'The dependency response content type was not JSON.',
    );
  }

  const declaredLength = response.headers.get('content-length');
  if (declaredLength !== null && /^\d+$/.test(declaredLength)) {
    const parsedLength = Number(declaredLength);
    if (Number.isSafeInteger(parsedLength) && parsedLength > maximumBytes) {
      await response.body?.cancel().catch(() => undefined);
      throw new DependencyFetchError(
        'DEPENDENCY_RESPONSE_TOO_LARGE',
        'The dependency response exceeded its byte limit.',
      );
    }
  }

  const encoded = await readBoundedBody(response, maximumBytes, options.signal);
  let body: unknown;
  try {
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(encoded);
    body = JSON.parse(decoded) as unknown;
  } catch {
    throw new DependencyFetchError(
      'DEPENDENCY_JSON_INVALID',
      'The dependency response was not valid UTF-8 JSON.',
    );
  }

  const parsed = options.schema.safeParse(body);
  if (!parsed.success) {
    throw new DependencyFetchError(
      'DEPENDENCY_RESPONSE_SCHEMA_INVALID',
      'The dependency response did not match its exact schema.',
    );
  }
  return parsed.data;
}

export async function fetchServiceReadiness(options: {
  readonly expectedService: string;
  readonly maximumBytes?: number;
  readonly signal: AbortSignal;
  readonly url: string | URL;
}): Promise<ServiceReadinessDocument> {
  const readiness = await fetchBoundedJson({
    ...(options.maximumBytes === undefined ? {} : { maximumBytes: options.maximumBytes }),
    schema: serviceReadinessSchema,
    signal: options.signal,
    url: options.url,
  });
  if (readiness.service !== options.expectedService) {
    throw new DependencyFetchError(
      'DEPENDENCY_RESPONSE_SCHEMA_INVALID',
      'The dependency response identified an unexpected service.',
    );
  }
  return readiness;
}
