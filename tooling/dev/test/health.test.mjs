import { beforeEach, describe, expect, it, vi } from 'vitest';

const configMocks = vi.hoisted(() => ({ readPortConfiguration: vi.fn() }));
const listenerMocks = vi.hoisted(() => ({ auditBlockListeners: vi.fn() }));
const preflightMocks = vi.hoisted(() => ({ verifyToolchain: vi.fn() }));
const readinessMocks = vi.hoisted(() => ({ waitForReadiness: vi.fn() }));

vi.mock('../config.mjs', () => configMocks);
vi.mock('../listeners.mjs', () => listenerMocks);
vi.mock('../preflight.mjs', () => preflightMocks);
vi.mock('../readiness.mjs', () => readinessMocks);

const { SERVICE_DEFINITIONS, STARTUP_TIMEOUT_MS } = await import('../constants.mjs');
const { health } = await import('../health.mjs');

describe('polling development health gate', () => {
  beforeEach(() => {
    configMocks.readPortConfiguration.mockReset().mockResolvedValue(undefined);
    listenerMocks.auditBlockListeners.mockReset().mockResolvedValue(undefined);
    preflightMocks.verifyToolchain.mockReset().mockResolvedValue({ marker: 'verified-tools' });
    readinessMocks.waitForReadiness.mockReset().mockImplementation(async (service) => ({
      detail: 'ready after polling',
      service: service.name,
    }));
  });

  it('polls every allocated service within the bounded topology deadline before auditing listeners', async () => {
    const results = await health({ quiet: true });

    expect(results).toHaveLength(SERVICE_DEFINITIONS.length);
    expect(readinessMocks.waitForReadiness).toHaveBeenCalledTimes(SERVICE_DEFINITIONS.length);
    for (const service of SERVICE_DEFINITIONS) {
      expect(readinessMocks.waitForReadiness).toHaveBeenCalledWith(service, {
        timeoutMs: STARTUP_TIMEOUT_MS,
        tools: { marker: 'verified-tools' },
      });
    }
    expect(listenerMocks.auditBlockListeners).toHaveBeenCalledOnce();
    expect(listenerMocks.auditBlockListeners).toHaveBeenCalledWith({ requireAllAllocated: true });
    expect(readinessMocks.waitForReadiness.mock.invocationCallOrder.at(-1)).toBeLessThan(
      listenerMocks.auditBlockListeners.mock.invocationCallOrder[0],
    );
  });

  it('exits the gate through the readiness timeout and never declares listener success', async () => {
    const timeout = Object.assign(new Error('delayed service timed out'), {
      code: 'DEV_READINESS_TIMEOUT',
    });
    readinessMocks.waitForReadiness.mockImplementation(async (service) => {
      if (service.name === 'gateway') {
        throw timeout;
      }
      return { detail: 'ready', service: service.name };
    });

    await expect(health({ quiet: true })).rejects.toBe(timeout);
    expect(listenerMocks.auditBlockListeners).not.toHaveBeenCalled();
  });
});
