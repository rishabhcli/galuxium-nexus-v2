import { beforeEach, describe, expect, it, vi } from 'vitest';

const fsMocks = vi.hoisted(() => ({
  readFile: vi.fn(),
}));

vi.mock('node:fs/promises', () => ({ default: fsMocks }));

const { readPortConfiguration } = await import('../config.mjs');

const VALID_CONFIGURATION = `# galuxium-nexus-v2 — exclusive block 4160-4169
PORT_0=4160   # Gateway service
PORT_1=4161   # Reconciler service
PORT_2=4162   # Admin UI
PORT_3=4163   # Fake provider
PORT_5=4165   # PostgreSQL
PORT_6=4166   # Redis
PORT_7=4167   # Metrics
`;

describe('ports.env refusal contract', () => {
  beforeEach(() => {
    fsMocks.readFile.mockReset();
  });

  it('accepts only the exact allocated port map', async () => {
    fsMocks.readFile.mockResolvedValue(VALID_CONFIGURATION);

    await expect(readPortConfiguration()).resolves.toEqual({
      PORT_0: 4160,
      PORT_1: 4161,
      PORT_2: 4162,
      PORT_3: 4163,
      PORT_5: 4165,
      PORT_6: 4166,
      PORT_7: 4167,
    });
  });

  it.each([
    {
      code: 'DEV_PORT_CONFIG_INVALID',
      label: 'shell syntax rather than inert data',
      source: VALID_CONFIGURATION.replace('PORT_0=4160', 'PORT_0=$(printf 4160)'),
    },
    {
      code: 'DEV_PORT_CONFIG_DUPLICATE',
      label: 'a duplicate key',
      source: `${VALID_CONFIGURATION}PORT_0=4160\n`,
    },
    {
      code: 'DEV_PORT_CONFIG_KEYS',
      label: 'an undeclared key',
      source: `${VALID_CONFIGURATION}PORT_4=4164\n`,
    },
    {
      code: 'DEV_PORT_CONFIG_DRIFT',
      label: 'an allocated service moved even within the reserved block',
      source: VALID_CONFIGURATION.replace('PORT_0=4160', 'PORT_0=4164'),
    },
    {
      code: 'DEV_PORT_CONFIG_DRIFT',
      label: 'a service moved outside the exclusive block',
      source: VALID_CONFIGURATION.replace('PORT_0=4160', 'PORT_0=5173'),
    },
  ])('refuses $label', async ({ code, source }) => {
    fsMocks.readFile.mockResolvedValue(source);

    await expect(readPortConfiguration()).rejects.toMatchObject({ code });
  });
});
