import { Client } from 'pg';

export interface LedgerHealthConfiguration {
  readonly expectedDatabase: string;
  readonly expectedRole: string;
  readonly host: string;
  readonly maximumConnections?: number;
  readonly password: string;
  readonly port: number;
  readonly timeoutMs?: number;
  readonly user: string;
}

export interface LedgerHealthProbe {
  check(signal: AbortSignal): Promise<void>;
  close(): Promise<void>;
}

export type LedgerHealthErrorCode =
  | 'LEDGER_HEALTH_CAPACITY_EXHAUSTED'
  | 'LEDGER_HEALTH_CLOSED'
  | 'LEDGER_HEALTH_CLOSING'
  | 'LEDGER_HEALTH_CONFIGURATION_INVALID'
  | 'LEDGER_HEALTH_DATABASE_MISMATCH'
  | 'LEDGER_HEALTH_EMPTY_RESULT'
  | 'LEDGER_HEALTH_ROLE_MISMATCH';

export class LedgerHealthError extends Error {
  readonly code: LedgerHealthErrorCode;

  constructor(code: LedgerHealthErrorCode, message: string) {
    super(message);
    this.name = 'LedgerHealthError';
    this.code = code;
  }
}

interface IdentityRow {
  readonly database_name: string;
  readonly role_name: string;
}

interface ActiveCheck {
  readonly cancel: (reason: Error) => void;
  readonly client: Client;
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('operation aborted');
}

export function createLedgerHealthProbe(
  configuration: LedgerHealthConfiguration,
): LedgerHealthProbe {
  const timeoutMs = configuration.timeoutMs ?? 2_000;
  const maximumConnections = configuration.maximumConnections ?? 2;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
    throw new LedgerHealthError(
      'LEDGER_HEALTH_CONFIGURATION_INVALID',
      'PostgreSQL readiness timeout is outside its supported bounds',
    );
  }
  if (
    !Number.isSafeInteger(maximumConnections) ||
    maximumConnections < 1 ||
    maximumConnections > 32
  ) {
    throw new LedgerHealthError(
      'LEDGER_HEALTH_CONFIGURATION_INVALID',
      'PostgreSQL readiness connection limit is outside its supported bounds',
    );
  }
  const activeChecks = new Set<ActiveCheck>();
  const endingClients = new WeakMap<Client, Promise<void>>();
  let closed = false;

  const endClient = (client: Client): Promise<void> => {
    const existing = endingClients.get(client);
    if (existing !== undefined) {
      return existing;
    }
    // node-postgres force-closes the connection when Client.end() observes an
    // active query. A fresh client per probe plus connection, statement, and
    // query timeouts ensures cancellation cannot leave pooled work accumulating.
    const ending = client.end();
    endingClients.set(client, ending);
    return ending;
  };

  return {
    check: async (signal) => {
      if (closed) {
        throw new LedgerHealthError('LEDGER_HEALTH_CLOSED', 'PostgreSQL readiness probe is closed');
      }
      if (signal.aborted) {
        throw abortReason(signal);
      }
      if (activeChecks.size >= maximumConnections) {
        throw new LedgerHealthError(
          'LEDGER_HEALTH_CAPACITY_EXHAUSTED',
          'PostgreSQL readiness connection limit is exhausted',
        );
      }

      const client = new Client({
        application_name: 'galuxium-nexus-v2-health',
        connectionTimeoutMillis: timeoutMs,
        database: configuration.expectedDatabase,
        host: configuration.host,
        password: configuration.password,
        port: configuration.port,
        query_timeout: timeoutMs,
        statement_timeout: timeoutMs,
        user: configuration.user,
      });

      let rejectCancellation: ((reason: Error) => void) | undefined;
      const cancelled = new Promise<never>((_resolve, reject) => {
        rejectCancellation = reject;
      });
      const cancel = (reason: Error): void => {
        rejectCancellation?.(reason);
        void endClient(client).catch(() => undefined);
      };
      const activeCheck: ActiveCheck = { cancel, client };
      activeChecks.add(activeCheck);
      const onAbort = (): void => {
        cancel(abortReason(signal));
      };
      signal.addEventListener('abort', onAbort, { once: true });

      try {
        await Promise.race([client.connect(), cancelled]);
        const result = await Promise.race([
          client.query<IdentityRow>(
            'SELECT current_database() AS database_name, current_user AS role_name',
          ),
          cancelled,
        ]);
        const identity = result.rows[0];
        if (identity === undefined) {
          throw new LedgerHealthError(
            'LEDGER_HEALTH_EMPTY_RESULT',
            'PostgreSQL readiness query returned no identity row',
          );
        }
        if (identity.database_name !== configuration.expectedDatabase) {
          throw new LedgerHealthError(
            'LEDGER_HEALTH_DATABASE_MISMATCH',
            'PostgreSQL readiness connected to an unexpected database',
          );
        }
        if (identity.role_name !== configuration.expectedRole) {
          throw new LedgerHealthError(
            'LEDGER_HEALTH_ROLE_MISMATCH',
            'PostgreSQL readiness connected as an unexpected role',
          );
        }
      } finally {
        signal.removeEventListener('abort', onAbort);
        try {
          await endClient(client);
        } finally {
          activeChecks.delete(activeCheck);
        }
      }
    },
    close: async () => {
      closed = true;
      const closingReason = new LedgerHealthError(
        'LEDGER_HEALTH_CLOSING',
        'PostgreSQL readiness probe is closing',
      );
      const checks = [...activeChecks];
      for (const check of checks) {
        check.cancel(closingReason);
      }
      await Promise.all(checks.map(async (check) => endClient(check.client)));
    },
  };
}
