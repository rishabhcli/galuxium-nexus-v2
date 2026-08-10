import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  MAX_HEALTH_BODY_BYTES,
  READINESS_REQUEST_TIMEOUT_MS,
  SERVICE_BY_NAME,
  SERVICE_VERSION,
} from '../constants.mjs';
import { checkHttpReadiness, waitForReadiness } from '../readiness.mjs';

const SERVICE_REQUEST_DEADLINE_MS = 5_000;
const MAX_LOCAL_READINESS_WAIT_MS = 10_000;

describe('bounded readiness timeout contract', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('waits past the server deadline but remains bounded', () => {
    expect(READINESS_REQUEST_TIMEOUT_MS).toBe(6_000);
    expect(READINESS_REQUEST_TIMEOUT_MS).toBeGreaterThan(SERVICE_REQUEST_DEADLINE_MS);
    expect(READINESS_REQUEST_TIMEOUT_MS).toBeLessThanOrEqual(MAX_LOCAL_READINESS_WAIT_MS);
  });

  it('applies the exported bound to each HTTP readiness request', async () => {
    const service = SERVICE_BY_NAME.get('metrics');
    const signal = new AbortController().signal;
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(signal);
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          service: service.name,
          status: 'ready',
          version: SERVICE_VERSION,
        }),
        {
          headers: { 'content-type': 'application/json' },
          status: 200,
        },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(checkHttpReadiness(service)).resolves.toMatchObject({
      service: 'metrics',
    });
    expect(timeoutSpy).toHaveBeenCalledOnce();
    expect(timeoutSpy).toHaveBeenCalledWith(READINESS_REQUEST_TIMEOUT_MS);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:4167/readyz',
      expect.objectContaining({
        redirect: 'error',
        signal,
      }),
    );
  });

  it('stops streaming an oversized response before buffering it', async () => {
    const service = SERVICE_BY_NAME.get('gateway');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response('x'.repeat(MAX_HEALTH_BODY_BYTES + 1), {
          headers: { 'content-type': 'application/json' },
          status: 200,
        }),
      ),
    );

    await expect(checkHttpReadiness(service)).rejects.toMatchObject({
      code: 'DEV_HEALTH_BODY_TOO_LARGE',
    });
  });

  it('summarizes a hostile schema without copying attacker content into error details', async () => {
    const service = SERVICE_BY_NAME.get('gateway');
    const secret = 'hostile-readiness-secret-must-not-be-printed';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            nested: { secret },
            service: secret,
            status: secret,
            version: secret,
          }),
          { headers: { 'content-type': 'application/json' }, status: 200 },
        ),
      ),
    );

    let failure;
    try {
      await checkHttpReadiness(service);
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      code: 'DEV_HEALTH_SCHEMA',
      details: {
        receivedArray: false,
        receivedObject: true,
        serviceMatches: false,
        statusMatches: false,
        versionMatches: false,
      },
    });
    expect(JSON.stringify(failure)).not.toContain(secret);
  });

  it('actually retries transient failures until the service becomes ready', async () => {
    vi.useFakeTimers();
    const service = SERVICE_BY_NAME.get('gateway');
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('listener not bound yet'))
      .mockRejectedValueOnce(new Error('service still initializing'))
      .mockResolvedValue(
        new Response(
          JSON.stringify({
            service: service.name,
            status: 'ready',
            version: SERVICE_VERSION,
          }),
          { headers: { 'content-type': 'application/json' }, status: 200 },
        ),
      );
    vi.stubGlobal('fetch', fetchMock);

    const readiness = waitForReadiness(service, { timeoutMs: 1_000 });
    await vi.advanceTimersByTimeAsync(200);

    await expect(readiness).resolves.toMatchObject({ service: 'gateway' });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('fails nonzero through the actual polling loop when its deadline is exhausted', async () => {
    vi.useFakeTimers();
    const service = SERVICE_BY_NAME.get('gateway');
    const fetchMock = vi.fn().mockRejectedValue(new Error('service unavailable'));
    vi.stubGlobal('fetch', fetchMock);

    const readiness = waitForReadiness(service, { timeoutMs: 100 });
    const expectation = expect(readiness).rejects.toMatchObject({
      code: 'DEV_READINESS_TIMEOUT',
      message: expect.stringContaining('within 100 ms'),
    });
    await vi.advanceTimersByTimeAsync(150);

    await expectation;
    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
  });
});
