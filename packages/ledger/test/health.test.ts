import { beforeEach, describe, expect, it, vi } from 'vitest';

const pgMock = vi.hoisted(() => {
  interface MockClientInstance {
    readonly configuration: Record<string, unknown>;
    endCalls: number;
  }

  return {
    clients: [] as MockClientInstance[],
    connect: vi.fn((client: MockClientInstance) => {
      void client;
      return Promise.resolve();
    }),
    end: vi.fn((client: MockClientInstance) => {
      client.endCalls += 1;
      return Promise.resolve();
    }),
    query: vi.fn((client: MockClientInstance) => {
      void client;
      return Promise.resolve({
        rows: [{ database_name: 'galuxium_nexus_v2', role_name: 'galuxium_nexus_v2' }],
      });
    }),
  };
});

vi.mock('pg', () => ({
  Client: class MockClient {
    readonly configuration: Record<string, unknown>;
    endCalls = 0;

    constructor(configuration: Record<string, unknown>) {
      this.configuration = configuration;
      pgMock.clients.push(this);
    }

    async connect(): Promise<void> {
      await pgMock.connect(this);
    }

    async end(): Promise<void> {
      await pgMock.end(this);
    }

    async query(): Promise<unknown> {
      return pgMock.query(this);
    }
  },
}));

import { createLedgerHealthProbe } from '../src/health.js';

const CONFIGURATION = {
  expectedDatabase: 'galuxium_nexus_v2',
  expectedRole: 'galuxium_nexus_v2',
  host: '127.0.0.1',
  password: 'not-a-real-secret',
  port: 4165,
  timeoutMs: 73,
  user: 'galuxium_nexus_v2',
} as const;

describe('createLedgerHealthProbe', () => {
  beforeEach(() => {
    pgMock.clients.length = 0;
    pgMock.connect.mockClear();
    pgMock.end.mockClear();
    pgMock.query.mockClear();
    pgMock.connect.mockImplementation(() => Promise.resolve());
    pgMock.end.mockImplementation((client) => {
      client.endCalls += 1;
      return Promise.resolve();
    });
    pgMock.query.mockImplementation(() =>
      Promise.resolve({
        rows: [{ database_name: 'galuxium_nexus_v2', role_name: 'galuxium_nexus_v2' }],
      }),
    );
  });

  it('uses a fresh, hard-bounded connection for every successful readiness query', async () => {
    const probe = createLedgerHealthProbe(CONFIGURATION);

    await probe.check(new AbortController().signal);
    await probe.check(new AbortController().signal);

    expect(pgMock.clients).toHaveLength(2);
    expect(pgMock.clients[0]?.configuration).toMatchObject({
      connectionTimeoutMillis: 73,
      query_timeout: 73,
      statement_timeout: 73,
    });
    expect(pgMock.end).toHaveBeenCalledTimes(2);
    expect(pgMock.clients.every((client) => client.endCalls === 1)).toBe(true);
  });

  it('ends the underlying client when cancellation interrupts an in-flight query', async () => {
    pgMock.query.mockImplementation(() => new Promise<never>(() => undefined));
    const probe = createLedgerHealthProbe(CONFIGURATION);
    const controller = new AbortController();
    const checking = probe.check(controller.signal);
    await vi.waitFor(() => {
      expect(pgMock.query).toHaveBeenCalledTimes(1);
    });

    controller.abort(new Error('readiness cancelled'));

    await expect(checking).rejects.toThrow('readiness cancelled');
    expect(pgMock.end).toHaveBeenCalledTimes(1);
    expect(pgMock.clients[0]?.endCalls).toBe(1);
  });

  it('terminates active checks on close and refuses future checks', async () => {
    pgMock.query.mockImplementation(() => new Promise<never>(() => undefined));
    const probe = createLedgerHealthProbe(CONFIGURATION);
    const checking = probe.check(new AbortController().signal);
    await vi.waitFor(() => {
      expect(pgMock.query).toHaveBeenCalledTimes(1);
    });

    await probe.close();

    await expect(checking).rejects.toThrow('PostgreSQL readiness probe is closing');
    expect(pgMock.end).toHaveBeenCalledTimes(1);
    await expect(probe.check(new AbortController().signal)).rejects.toThrow(
      'PostgreSQL readiness probe is closed',
    );
  });

  it('refuses excess concurrent checks instead of creating unbounded clients', async () => {
    pgMock.query.mockImplementation(() => new Promise<never>(() => undefined));
    const probe = createLedgerHealthProbe({ ...CONFIGURATION, maximumConnections: 2 });
    const firstController = new AbortController();
    const secondController = new AbortController();
    const first = probe.check(firstController.signal);
    const second = probe.check(secondController.signal);
    await vi.waitFor(() => {
      expect(pgMock.query).toHaveBeenCalledTimes(2);
    });

    await expect(probe.check(new AbortController().signal)).rejects.toMatchObject({
      code: 'LEDGER_HEALTH_CAPACITY_EXHAUSTED',
      message: 'PostgreSQL readiness connection limit is exhausted',
    });
    expect(pgMock.clients).toHaveLength(2);

    firstController.abort(new Error('first cancelled'));
    secondController.abort(new Error('second cancelled'));
    await Promise.all([
      expect(first).rejects.toThrow('first cancelled'),
      expect(second).rejects.toThrow('second cancelled'),
    ]);
    expect(pgMock.clients.every((client) => client.endCalls === 1)).toBe(true);
  });

  it('refuses an unexpected database or role and still closes the connection', async () => {
    pgMock.query.mockResolvedValueOnce({
      rows: [{ database_name: 'foreign_database', role_name: 'foreign_role' }],
    });
    const probe = createLedgerHealthProbe(CONFIGURATION);

    await expect(probe.check(new AbortController().signal)).rejects.toThrow('unexpected database');
    expect(pgMock.end).toHaveBeenCalledTimes(1);
  });
});
