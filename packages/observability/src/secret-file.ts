import { constants as fileConstants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export type SecretFileErrorCode =
  | 'SECRET_FILE_EMPTY'
  | 'SECRET_FILE_NOT_CANONICAL'
  | 'SECRET_FILE_PERMISSIONS'
  | 'SECRET_FILE_REPLACED'
  | 'SECRET_FILE_SIZE'
  | 'SECRET_FILE_TYPE';

export class SecretFileError extends Error {
  readonly code: SecretFileErrorCode;

  constructor(code: SecretFileErrorCode, message: string) {
    super(message);
    this.name = 'SecretFileError';
    this.code = code;
  }
}

export function repositoryRootFromServiceModule(moduleUrl: string, serviceName: string): string {
  if (!/^[a-z0-9-]+$/.test(serviceName)) {
    throw new SecretFileError('SECRET_FILE_NOT_CANONICAL', 'Service name is invalid.');
  }

  let current = dirname(fileURLToPath(moduleUrl));
  for (;;) {
    const parent = dirname(current);
    if (basename(current) === serviceName && basename(parent) === 'services') {
      return dirname(parent);
    }
    if (parent === current) {
      throw new SecretFileError(
        'SECRET_FILE_NOT_CANONICAL',
        'Service module is not located in the expected repository structure.',
      );
    }
    current = parent;
  }
}

export async function readCanonicalSecretFile(options: {
  readonly expectedPath: string;
  readonly maximumBytes?: number;
  readonly path: string;
}): Promise<string> {
  const maximumBytes = options.maximumBytes ?? 4_096;
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    throw new SecretFileError('SECRET_FILE_SIZE', 'Secret file size limit is invalid.');
  }
  if (options.path !== options.expectedPath) {
    throw new SecretFileError(
      'SECRET_FILE_NOT_CANONICAL',
      'Secret file path does not match the expected repository path.',
    );
  }

  const metadata = await lstat(options.path);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new SecretFileError(
      'SECRET_FILE_TYPE',
      'Secret file must be a non-symlink regular file.',
    );
  }
  if (metadata.size === 0 || metadata.size > maximumBytes) {
    throw new SecretFileError(
      'SECRET_FILE_SIZE',
      'Secret file is empty or exceeds its size limit.',
    );
  }
  if ((metadata.mode & 0o077) !== 0) {
    throw new SecretFileError(
      'SECRET_FILE_PERMISSIONS',
      'Secret file permissions must deny group and other access.',
    );
  }

  const canonicalPath = await realpath(options.path);
  if (canonicalPath !== options.expectedPath) {
    throw new SecretFileError(
      'SECRET_FILE_NOT_CANONICAL',
      'Secret file or one of its parent directories is redirected.',
    );
  }

  const handle = await open(options.path, fileConstants.O_RDONLY | fileConstants.O_NOFOLLOW);
  try {
    const openedMetadata = await handle.stat();
    if (
      !openedMetadata.isFile() ||
      openedMetadata.dev !== metadata.dev ||
      openedMetadata.ino !== metadata.ino
    ) {
      throw new SecretFileError(
        'SECRET_FILE_REPLACED',
        'Secret file changed while it was being validated.',
      );
    }
    if (
      openedMetadata.size === 0 ||
      openedMetadata.size > maximumBytes ||
      (openedMetadata.mode & 0o077) !== 0
    ) {
      throw new SecretFileError(
        openedMetadata.size === 0 || openedMetadata.size > maximumBytes
          ? 'SECRET_FILE_SIZE'
          : 'SECRET_FILE_PERMISSIONS',
        'Opened secret file no longer satisfies its size and permission contract.',
      );
    }

    const buffer = Buffer.alloc(maximumBytes + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, 0);
    if (bytesRead === 0 || bytesRead > maximumBytes) {
      throw new SecretFileError(
        'SECRET_FILE_SIZE',
        'Secret file is empty or exceeds its size limit.',
      );
    }
    const secret = buffer.subarray(0, bytesRead).toString('utf8').trimEnd();
    if (secret.length === 0) {
      throw new SecretFileError('SECRET_FILE_EMPTY', 'Secret file contains no usable value.');
    }
    return secret;
  } finally {
    await handle.close();
  }
}
