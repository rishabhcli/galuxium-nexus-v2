import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

function declaredContentLength(response, label, maximumBytes) {
  const rawLength = response.headers.get('content-length');
  if (rawLength === null || !/^[1-9][0-9]*$/u.test(rawLength)) {
    throw new Error(`${label} has a missing or unsafe Content-Length.`);
  }
  const length = Number(rawLength);
  if (!Number.isSafeInteger(length) || length > maximumBytes) {
    throw new Error(`${label} exceeds its admitted download size.`);
  }
  return length;
}

export async function pipeBoundedResponse(response, destination, options) {
  const { label, maximumBytes } = options;
  let declaredLength;
  try {
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
      throw new Error('Download byte limit must be a positive safe integer.');
    }
    if (response.body === null) {
      throw new Error(`${label} returned no response body.`);
    }
    declaredLength = declaredContentLength(response, label, maximumBytes);
  } catch (error) {
    destination.destroy();
    if (response.body !== null && !response.body.locked) {
      await response.body.cancel('bounded download refused before streaming').catch(() => {});
    }
    throw error;
  }
  let receivedBytes = 0;
  const limiter = new Transform({
    transform(chunk, _encoding, callback) {
      const bytes = Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk);
      receivedBytes += bytes;
      if (receivedBytes > maximumBytes || receivedBytes > declaredLength) {
        callback(new Error(`${label} streamed more bytes than its admitted Content-Length.`));
        return;
      }
      callback(null, chunk);
    },
  });

  await pipeline(Readable.fromWeb(response.body), limiter, destination);
  if (receivedBytes !== declaredLength) {
    throw new Error(
      `${label} length mismatch: expected ${String(declaredLength)}, received ${String(receivedBytes)}.`,
    );
  }
  return receivedBytes;
}
