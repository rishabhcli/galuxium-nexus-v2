import type { IncomingMessage } from 'node:http';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';

import { readRequestBody } from '../src/request-body.js';

function requestWithLength(length?: string): PassThrough {
  const request = new PassThrough() as PassThrough & {
    headers: Readonly<Record<string, string | undefined>>;
  };
  request.headers = length === undefined ? {} : { 'content-length': length };
  return request;
}

describe('readRequestBody', () => {
  it('settles immediately and drains input when its abort signal fires mid-read', async () => {
    const request = requestWithLength();
    const controller = new AbortController();
    const reading = readRequestBody(request as unknown as IncomingMessage, {
      maximumBytes: 1_024,
      signal: controller.signal,
    });

    request.write('partial');
    controller.abort(new Error('deadline'));

    await expect(reading).rejects.toMatchObject({
      code: 'BODY_ABORTED',
    });
    expect(request.readableFlowing).toBe(true);
    request.end();
  });

  it('refuses an oversized declared length before consuming body data', async () => {
    const request = requestWithLength('1025');

    await expect(
      readRequestBody(request as unknown as IncomingMessage, {
        maximumBytes: 1_024,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: 'BODY_TOO_LARGE' });
  });
});
