import { beforeEach, describe, expect, it, vi } from 'vitest';

const commandMocks = vi.hoisted(() => ({
  execute: vi.fn(),
  findExecutable: vi.fn(),
  safeEnvironment: vi.fn((value) => value),
}));
const filesystemMocks = vi.hoisted(() => ({
  readCanonicalDevSecretFile: vi.fn(),
}));

vi.mock('../command.mjs', () => commandMocks);
vi.mock('../filesystem.mjs', () => filesystemMocks);

const { POSTGRES, SERVICE_BY_NAME } = await import('../constants.mjs');
const { checkPostgresReadiness } = await import('../readiness.mjs');

const LEAST_PRIVILEGE_IDENTITY = [
  POSTGRES.database,
  POSTGRES.role,
  '160014',
  '127.0.0.1',
  '4165',
  POSTGRES.ownerRole,
  't',
  'f',
  'f',
  'f',
  'f',
  'f',
  'f',
  '20',
  'f',
  't',
  'f',
  'f',
  'f',
  'f',
  'f',
].join('|');

describe('PostgreSQL least-privilege readiness identity', () => {
  beforeEach(() => {
    commandMocks.execute.mockReset();
    commandMocks.findExecutable.mockReset();
    commandMocks.safeEnvironment.mockClear();
    filesystemMocks.readCanonicalDevSecretFile.mockReset();
    filesystemMocks.readCanonicalDevSecretFile.mockResolvedValue('test-password');
  });

  it('accepts the distinct database owner and constrained runtime role', async () => {
    commandMocks.execute.mockResolvedValue({
      exitCode: 0,
      stderr: '',
      stdout: `${LEAST_PRIVILEGE_IDENTITY}\n`,
    });

    await expect(
      checkPostgresReadiness(SERVICE_BY_NAME.get('postgres'), { psql: '/verified/psql' }),
    ).resolves.toMatchObject({
      detail: expect.stringContaining('least_privilege=ok'),
      service: 'postgres',
    });

    expect(commandMocks.execute).toHaveBeenCalledWith(
      '/verified/psql',
      expect.arrayContaining(['-U', POSTGRES.role, '-d', POSTGRES.database]),
      expect.objectContaining({ sensitiveValues: ['test-password'] }),
    );
    const argumentsList = commandMocks.execute.mock.calls[0]?.[1];
    expect(argumentsList).toEqual(
      expect.arrayContaining([
        expect.stringContaining("has_database_privilege(current_user, 'template1', 'TEMPORARY')"),
      ]),
    );
  });

  it.each([
    { index: 7, label: 'superuser', value: 't' },
    { index: 8, label: 'database creator', value: 't' },
    { index: 9, label: 'role creator', value: 't' },
    { index: 11, label: 'replication role', value: 't' },
    { index: 12, label: 'row-security bypass role', value: 't' },
    { index: 14, label: 'member of the owner role', value: 't' },
  ])('refuses a runtime $label', async ({ index, value }) => {
    const fields = LEAST_PRIVILEGE_IDENTITY.split('|');
    fields[index] = value;
    commandMocks.execute.mockResolvedValue({
      exitCode: 0,
      stderr: '',
      stdout: `${fields.join('|')}\n`,
    });

    await expect(
      checkPostgresReadiness(SERVICE_BY_NAME.get('postgres'), { psql: '/verified/psql' }),
    ).rejects.toMatchObject({ code: 'DEV_POSTGRES_IDENTITY' });
  });

  it.each([
    { index: 15, label: 'app database CONNECT', value: 'f' },
    { index: 16, label: 'app database TEMPORARY', value: 't' },
    { index: 17, label: 'postgres database CONNECT', value: 't' },
    { index: 18, label: 'postgres database TEMPORARY', value: 't' },
    { index: 19, label: 'template1 database CONNECT', value: 't' },
    { index: 20, label: 'template1 database TEMPORARY', value: 't' },
  ])('refuses an unsafe $label privilege', async ({ index, value }) => {
    const fields = LEAST_PRIVILEGE_IDENTITY.split('|');
    fields[index] = value;
    commandMocks.execute.mockResolvedValue({
      exitCode: 0,
      stderr: '',
      stdout: `${fields.join('|')}\n`,
    });

    await expect(
      checkPostgresReadiness(SERVICE_BY_NAME.get('postgres'), { psql: '/verified/psql' }),
    ).rejects.toMatchObject({ code: 'DEV_POSTGRES_IDENTITY' });
  });
});
