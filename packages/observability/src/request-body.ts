import type { IncomingMessage } from 'node:http';

export type RequestBodyErrorCode = 'BODY_ABORTED' | 'BODY_INVALID_LENGTH' | 'BODY_TOO_LARGE';

export class RequestBodyError extends Error {
  readonly code: RequestBodyErrorCode;

  constructor(code: RequestBodyErrorCode, message: string) {
    super(message);
    this.name = 'RequestBodyError';
    this.code = code;
  }
}

function declaredLength(request: IncomingMessage): number | undefined {
  const raw = request.headers['content-length'];
  if (raw === undefined) {
    return undefined;
  }
  if (Array.isArray(raw) || !/^[0-9]+$/.test(raw)) {
    throw new RequestBodyError('BODY_INVALID_LENGTH', 'Content-Length is invalid.');
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed)) {
    throw new RequestBodyError('BODY_INVALID_LENGTH', 'Content-Length is too large.');
  }
  return parsed;
}

export async function readRequestBody(
  request: IncomingMessage,
  options: { readonly maximumBytes: number; readonly signal: AbortSignal },
): Promise<Buffer> {
  const length = declaredLength(request);
  if (length !== undefined && length > options.maximumBytes) {
    throw new RequestBodyError('BODY_TOO_LARGE', 'The request body exceeds the size limit.');
  }

  if (options.signal.aborted) {
    throw new RequestBodyError('BODY_ABORTED', 'The request body read was cancelled.');
  }

  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let receivedBytes = 0;

    const cleanup = (): void => {
      request.off('aborted', onRequestAborted);
      request.off('data', onData);
      request.off('end', onEnd);
      request.off('error', onError);
      options.signal.removeEventListener('abort', onSignalAborted);
    };
    const rejectAndDrain = (error: Error): void => {
      cleanup();
      request.resume();
      reject(error);
    };
    const onData = (chunk: Buffer | Uint8Array | string): void => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      receivedBytes += buffer.byteLength;
      if (receivedBytes > options.maximumBytes) {
        rejectAndDrain(
          new RequestBodyError('BODY_TOO_LARGE', 'The request body exceeds the size limit.'),
        );
        return;
      }
      chunks.push(buffer);
    };
    const onEnd = (): void => {
      cleanup();
      resolve(Buffer.concat(chunks, receivedBytes));
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const onRequestAborted = (): void => {
      rejectAndDrain(new RequestBodyError('BODY_ABORTED', 'The request body read was cancelled.'));
    };
    const onSignalAborted = (): void => {
      rejectAndDrain(new RequestBodyError('BODY_ABORTED', 'The request body read was cancelled.'));
    };

    request.once('aborted', onRequestAborted);
    request.on('data', onData);
    request.once('end', onEnd);
    request.once('error', onError);
    options.signal.addEventListener('abort', onSignalAborted, { once: true });
    if (options.signal.aborted) {
      onSignalAborted();
    }
  });
}
