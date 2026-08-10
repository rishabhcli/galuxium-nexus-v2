import { z } from 'zod';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  DependencyFetchError,
  fetchBoundedJson,
  fetchServiceReadiness,
} from '../src/dependency-fetch.js';

const readinessDocument = {
  checks: [],
  service: 'gateway',
  status: 'ready',
  version: '0.1.0',
} as const;

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json; charset=utf-8' },
    status: 200,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchBoundedJson', () => {
  it('rejects redirects, propagates the exact signal, and validates a strict schema', async () => {
    const signal = new AbortController().signal;
    const fetchMock = vi.fn((_input: string | URL | Request, init?: RequestInit) => {
      expect(init?.redirect).toBe('error');
      expect(init?.signal).toBe(signal);
      return Promise.resolve(jsonResponse({ ready: true }));
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      fetchBoundedJson({
        schema: z.strictObject({ ready: z.literal(true) }),
        signal,
        url: 'http://127.0.0.1:4160/readyz',
      }),
    ).resolves.toEqual({ ready: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('enforces the streaming byte cap when Content-Length understates the body', async () => {
    let cancelled = false;
    let pulled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel: () => {
        cancelled = true;
      },
      pull: (controller) => {
        if (!pulled) {
          pulled = true;
          controller.enqueue(new Uint8Array(200));
        }
      },
      start: (controller) => {
        controller.enqueue(new Uint8Array(200));
      },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Promise.resolve(
          new Response(body, {
            headers: {
              'content-length': '1',
              'content-type': 'application/json',
            },
          }),
        ),
      ),
    );

    await expect(
      fetchBoundedJson({
        maximumBytes: 256,
        schema: z.unknown(),
        signal: new AbortController().signal,
        url: 'http://127.0.0.1:4160/readyz',
      }),
    ).rejects.toMatchObject({ code: 'DEPENDENCY_RESPONSE_TOO_LARGE' });
    expect(cancelled).toBe(true);
  });

  it('cancels a stalled response stream when the caller signal aborts', async () => {
    let streamCancelled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel: () => {
        streamCancelled = true;
      },
    });
    const fetchMock = vi.fn(async () =>
      Promise.resolve(
        new Response(body, {
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();

    const fetching = fetchBoundedJson({
      schema: z.unknown(),
      signal: controller.signal,
      url: 'http://127.0.0.1:4160/readyz',
    });
    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    controller.abort(new Error('caller-controlled abort detail'));

    await expect(fetching).rejects.toMatchObject({ code: 'DEPENDENCY_FETCH_ABORTED' });
    expect(streamCancelled).toBe(true);
  });
});

describe('fetchServiceReadiness', () => {
  it('accepts only the exact readiness schema and expected service identity', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.resolve(jsonResponse(readinessDocument))),
    );

    await expect(
      fetchServiceReadiness({
        expectedService: 'gateway',
        signal: new AbortController().signal,
        url: 'http://127.0.0.1:4160/readyz',
      }),
    ).resolves.toEqual(readinessDocument);
  });

  it.each([
    { ...readinessDocument, extra: 'not-allowed' },
    { ...readinessDocument, service: 'other-service' },
    { ...readinessDocument, checks: [{ name: 'db', status: 'ready' }] },
  ])('rejects a non-exact readiness document', async (body) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.resolve(jsonResponse(body))),
    );

    await expect(
      fetchServiceReadiness({
        expectedService: 'gateway',
        signal: new AbortController().signal,
        url: 'http://127.0.0.1:4160/readyz',
      }),
    ).rejects.toBeInstanceOf(DependencyFetchError);
    await expect(
      fetchServiceReadiness({
        expectedService: 'gateway',
        signal: new AbortController().signal,
        url: 'http://127.0.0.1:4160/readyz',
      }),
    ).rejects.toMatchObject({ code: 'DEPENDENCY_RESPONSE_SCHEMA_INVALID' });
  });
});
