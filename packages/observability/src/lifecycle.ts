import type { Logger } from './logger.js';

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000;

export interface CloseableService {
  close(): Promise<void>;
  listen(): Promise<void>;
}

export interface CleanupOperation {
  readonly close: () => Promise<void> | void;
  readonly name: string;
}

export interface SignalSource {
  off(event: NodeJS.Signals, listener: () => void): unknown;
  once(event: NodeJS.Signals, listener: () => void): unknown;
}

export interface LifecycleOptions {
  readonly shutdownTimeoutMs?: number;
  readonly signalSource?: SignalSource;
}

export type LifecycleErrorCode =
  'SERVICE_CLEANUP_FAILED' | 'SERVICE_LIFECYCLE_CONFIGURATION_INVALID' | 'SERVICE_SHUTDOWN_TIMEOUT';

export class LifecycleError extends Error {
  readonly code: LifecycleErrorCode;

  constructor(code: LifecycleErrorCode, message: string) {
    super(message);
    this.name = 'LifecycleError';
    this.code = code;
  }
}

function validateShutdownTimeout(candidate: number): number {
  if (!Number.isSafeInteger(candidate) || candidate < 1 || candidate > 30_000) {
    throw new LifecycleError(
      'SERVICE_LIFECYCLE_CONFIGURATION_INVALID',
      'Service shutdown timeout must be an integer between 1 and 30000 milliseconds.',
    );
  }
  return candidate;
}

export function createIdempotentCleanup(
  operations: readonly CleanupOperation[],
  logger: Logger,
): () => Promise<void> {
  for (const operation of operations) {
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(operation.name)) {
      throw new LifecycleError(
        'SERVICE_LIFECYCLE_CONFIGURATION_INVALID',
        'Cleanup operation names must be stable lowercase identifiers.',
      );
    }
  }

  let cleanupPromise: Promise<void> | undefined;
  return (): Promise<void> => {
    cleanupPromise ??= (async () => {
      const results = await Promise.allSettled(
        operations.map(async (operation) => operation.close()),
      );
      let failed = false;
      for (const [index, result] of results.entries()) {
        if (result.status === 'rejected') {
          failed = true;
          logger.warn('service.cleanup_operation_failed', {
            error: result.reason as unknown,
            operation: operations[index]?.name ?? 'unknown',
          });
        }
      }
      if (failed) {
        throw new LifecycleError(
          'SERVICE_CLEANUP_FAILED',
          'One or more service cleanup operations failed.',
        );
      }
    })();
    return cleanupPromise;
  };
}

async function closeWithinDeadline(
  service: CloseableService,
  shutdownTimeoutMs: number,
): Promise<void> {
  let timeout: NodeJS.Timeout | undefined;
  const timedOut = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      reject(
        new LifecycleError(
          'SERVICE_SHUTDOWN_TIMEOUT',
          'The service did not shut down before its deadline.',
        ),
      );
    }, shutdownTimeoutMs);
  });

  try {
    await Promise.race([Promise.resolve().then(async () => service.close()), timedOut]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

export async function runUntilSignalled(
  service: CloseableService,
  logger: Logger,
  options: LifecycleOptions = {},
): Promise<void> {
  const shutdownTimeoutMs = validateShutdownTimeout(
    options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS,
  );
  const signalSource = options.signalSource ?? process;

  try {
    await service.listen();
  } catch (error) {
    try {
      await closeWithinDeadline(service, shutdownTimeoutMs);
    } catch (cleanupError) {
      logger.warn('service.listen_rollback_failed', { error: cleanupError });
    }
    throw error;
  }

  let onSigint: (() => void) | undefined;
  let onSigterm: (() => void) | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      let stopping = false;
      const stop = (signal: NodeJS.Signals): void => {
        if (stopping) {
          return;
        }
        stopping = true;
        logger.info('service.stop_requested', { signal });
        void closeWithinDeadline(service, shutdownTimeoutMs).then(resolve, reject);
      };
      onSigint = () => {
        stop('SIGINT');
      };
      onSigterm = () => {
        stop('SIGTERM');
      };
      signalSource.once('SIGINT', onSigint);
      signalSource.once('SIGTERM', onSigterm);
    });
  } finally {
    if (onSigint !== undefined) {
      signalSource.off('SIGINT', onSigint);
    }
    if (onSigterm !== undefined) {
      signalSource.off('SIGTERM', onSigterm);
    }
  }
}
