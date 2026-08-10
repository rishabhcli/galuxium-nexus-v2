import { beforeEach, describe, expect, it, vi } from 'vitest';

const downMocks = vi.hoisted(() => ({ stopOwnedServices: vi.fn() }));
const filesystemMocks = vi.hoisted(() => ({
  ensureDevTree: vi.fn(),
  ensureSecretFile: vi.fn(),
}));
const healthMocks = vi.hoisted(() => ({ health: vi.fn() }));
const ownershipMocks = vi.hoisted(() => ({
  acquireOrchestratorLock: vi.fn(),
  loadVerifiedOwnershipRecords: vi.fn(),
}));
const preflightMocks = vi.hoisted(() => ({ preflight: vi.fn() }));
const runtimeMocks = vi.hoisted(() => ({
  createRunId: vi.fn(),
  startNodeService: vi.fn(),
  startPostgres: vi.fn(),
  startRedis: vi.fn(),
  validateCompiledEntries: vi.fn(),
}));

vi.mock('../down.mjs', () => downMocks);
vi.mock('../filesystem.mjs', () => filesystemMocks);
vi.mock('../health.mjs', () => healthMocks);
vi.mock('../ownership.mjs', () => ownershipMocks);
vi.mock('../preflight.mjs', () => preflightMocks);
vi.mock('../runtime.mjs', () => runtimeMocks);

const { SERVICE_DEFINITIONS } = await import('../constants.mjs');
const { up } = await import('../up.mjs');
const RUN_ID = '01234567-89ab-cdef-0123-456789abcdef';

function completeRecords(runId = RUN_ID) {
  return new Map(
    SERVICE_DEFINITIONS.map((service) => [service.name, { runId, service: service.name }]),
  );
}

describe('dev up partial and repeated lifecycle', () => {
  beforeEach(() => {
    downMocks.stopOwnedServices.mockReset().mockResolvedValue([]);
    filesystemMocks.ensureDevTree.mockReset().mockResolvedValue(undefined);
    filesystemMocks.ensureSecretFile.mockReset().mockResolvedValue('test-secret-value');
    healthMocks.health.mockReset().mockResolvedValue(undefined);
    ownershipMocks.acquireOrchestratorLock.mockReset().mockResolvedValue(vi.fn());
    ownershipMocks.loadVerifiedOwnershipRecords.mockReset().mockResolvedValue(new Map());
    preflightMocks.preflight.mockReset().mockResolvedValue({ tools: {} });
    runtimeMocks.createRunId.mockReset().mockReturnValue(RUN_ID);
    runtimeMocks.startNodeService.mockReset().mockResolvedValue({});
    runtimeMocks.startPostgres.mockReset().mockResolvedValue({});
    runtimeMocks.startRedis.mockReset().mockResolvedValue({});
    runtimeMocks.validateCompiledEntries.mockReset().mockResolvedValue(undefined);
  });

  it('returns an already-running coherent topology without starting or stopping anything', async () => {
    ownershipMocks.loadVerifiedOwnershipRecords.mockResolvedValue(completeRecords());

    await expect(up({ quiet: true })).resolves.toEqual({
      alreadyRunning: true,
      runId: RUN_ID,
    });

    expect(runtimeMocks.validateCompiledEntries).not.toHaveBeenCalled();
    expect(downMocks.stopOwnedServices).not.toHaveBeenCalled();
    expect(runtimeMocks.startNodeService).not.toHaveBeenCalled();
    expect(ownershipMocks.loadVerifiedOwnershipRecords).toHaveBeenCalledExactlyOnceWith({
      removeStale: true,
    });
    expect(filesystemMocks.ensureDevTree.mock.invocationCallOrder[0]).toBeLessThan(
      ownershipMocks.acquireOrchestratorLock.mock.invocationCallOrder[0],
    );
    expect(ownershipMocks.acquireOrchestratorLock.mock.invocationCallOrder[0]).toBeLessThan(
      ownershipMocks.loadVerifiedOwnershipRecords.mock.invocationCallOrder[0],
    );
    expect(ownershipMocks.loadVerifiedOwnershipRecords.mock.invocationCallOrder[0]).toBeLessThan(
      preflightMocks.preflight.mock.invocationCallOrder[0],
    );
  });

  it('stops an exact-owned partial topology before starting a coherent replacement', async () => {
    preflightMocks.preflight
      .mockResolvedValueOnce({ tools: { marker: 'initial-audit' } })
      .mockResolvedValueOnce({ tools: { marker: 'final-audit' } });
    ownershipMocks.loadVerifiedOwnershipRecords.mockResolvedValue(
      new Map([
        ['postgres', { runId: 'old-run', service: 'postgres' }],
        ['redis', { runId: 'old-run', service: 'redis' }],
      ]),
    );

    await expect(up({ quiet: true })).resolves.toEqual({
      alreadyRunning: false,
      runId: RUN_ID,
    });

    expect(downMocks.stopOwnedServices).toHaveBeenCalledExactlyOnceWith({ quiet: true });
    expect(preflightMocks.preflight).toHaveBeenCalledTimes(2);
    expect(runtimeMocks.startPostgres).toHaveBeenCalledOnce();
    expect(runtimeMocks.startPostgres).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'postgres' }),
      expect.objectContaining({ tools: { marker: 'final-audit' } }),
    );
    expect(runtimeMocks.startRedis).toHaveBeenCalledOnce();
    expect(runtimeMocks.startNodeService).toHaveBeenCalledTimes(5);
    expect(healthMocks.health).toHaveBeenCalledWith({ quiet: true });
  });

  it('rolls back only the new run when a later service fails to start', async () => {
    runtimeMocks.startNodeService.mockRejectedValueOnce(new Error('fake provider failed'));

    await expect(up({ quiet: true })).rejects.toThrow('fake provider failed');

    expect(downMocks.stopOwnedServices).toHaveBeenCalledExactlyOnceWith({
      onlyRunId: RUN_ID,
      quiet: true,
    });
  });

  it('repairs a fully recorded but unhealthy topology instead of returning it as healthy', async () => {
    ownershipMocks.loadVerifiedOwnershipRecords.mockResolvedValue(completeRecords());
    healthMocks.health
      .mockRejectedValueOnce(new Error('stale readiness'))
      .mockResolvedValue(undefined);

    await expect(up({ quiet: true })).resolves.toEqual({ alreadyRunning: false, runId: RUN_ID });

    expect(downMocks.stopOwnedServices).toHaveBeenCalledExactlyOnceWith({ quiet: true });
    expect(runtimeMocks.startPostgres).toHaveBeenCalledOnce();
    expect(healthMocks.health).toHaveBeenCalledTimes(2);
  });
});
