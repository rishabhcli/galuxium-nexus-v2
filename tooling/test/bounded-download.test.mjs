import { Writable } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import { pipeBoundedResponse } from '../bounded-download.mjs';

function sink() {
  const chunks = [];
  return {
    chunks,
    stream: new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(Buffer.from(chunk));
        callback();
      },
    }),
  };
}

describe('bounded artifact response streaming', () => {
  it('accepts only an exact declared body within the byte cap', async () => {
    const destination = sink();
    const response = new Response('verified', { headers: { 'content-length': '8' } });

    await expect(
      pipeBoundedResponse(response, destination.stream, {
        label: 'test artifact',
        maximumBytes: 8,
      }),
    ).resolves.toBe(8);
    expect(Buffer.concat(destination.chunks).toString('utf8')).toBe('verified');
  });

  it.each([
    { headers: {}, name: 'missing' },
    { headers: { 'content-length': '0' }, name: 'zero' },
    { headers: { 'content-length': 'not-a-number' }, name: 'malformed' },
    { headers: { 'content-length': '9' }, name: 'over-limit' },
  ])('refuses a $name Content-Length before streaming', async ({ headers }) => {
    const destination = sink();
    const response = new Response('verified', { headers });
    const cancel = vi.spyOn(response.body, 'cancel');

    await expect(
      pipeBoundedResponse(response, destination.stream, {
        label: 'test artifact',
        maximumBytes: 8,
      }),
    ).rejects.toThrow(/Content-Length|download size/u);
    expect(destination.chunks).toHaveLength(0);
    expect(destination.stream.destroyed).toBe(true);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('destroys the pre-created destination when the response has no body', async () => {
    const destination = sink();
    const response = new Response(null, { headers: { 'content-length': '8' } });

    await expect(
      pipeBoundedResponse(response, destination.stream, {
        label: 'test artifact',
        maximumBytes: 8,
      }),
    ).rejects.toThrow('returned no response body');
    expect(destination.stream.destroyed).toBe(true);
  });

  it('aborts while streaming when a server lies with a smaller declared length', async () => {
    const destination = sink();
    const response = new Response('ninebytes', { headers: { 'content-length': '8' } });

    await expect(
      pipeBoundedResponse(response, destination.stream, {
        label: 'test artifact',
        maximumBytes: 8,
      }),
    ).rejects.toThrow('streamed more bytes');
    expect(destination.chunks).toHaveLength(0);
  });

  it('refuses a truncated body whose final size differs from the declaration', async () => {
    const destination = sink();
    const response = new Response('short', { headers: { 'content-length': '8' } });

    await expect(
      pipeBoundedResponse(response, destination.stream, {
        label: 'test artifact',
        maximumBytes: 8,
      }),
    ).rejects.toThrow('length mismatch');
  });
});
