import { beforeEach, describe, expect, it, vi } from 'vitest';

const commandMocks = vi.hoisted(() => ({
  execute: vi.fn(),
  findExecutable: vi.fn(),
}));

vi.mock('../command.mjs', () => commandMocks);

const { REPOSITORY_ROOT } = await import('../constants.mjs');
const { verifyRepositoryIsolation, verifyToolchain } = await import('../preflight.mjs');

const VALID_VERSION_OUTPUT = Object.freeze({
  createdb: 'createdb (PostgreSQL) 16.14 (Homebrew)',
  initdb: 'initdb (PostgreSQL) 16.14 (Homebrew)',
  npm: '11.16.0',
  pg_isready: 'pg_isready (PostgreSQL) 16.14 (Homebrew)',
  postgres: 'postgres (PostgreSQL) 16.14 (Homebrew)',
  psql: 'psql (PostgreSQL) 16.14 (Homebrew)',
  'redis-cli': 'redis-cli 8.10.0',
  'redis-server': 'Redis server v=8.10.0 sha=00000000:0 malloc=libc bits=64 build=test',
  tsc: 'Version 6.0.3',
});

function executableName(executable) {
  return executable.slice(executable.lastIndexOf('/') + 1);
}

describe('exact development toolchain identity', () => {
  beforeEach(() => {
    commandMocks.execute.mockReset();
    commandMocks.findExecutable.mockReset();
    commandMocks.findExecutable.mockImplementation(async (name) => `/verified-bin/${name}`);
    commandMocks.execute.mockImplementation(async (executable) => ({
      exitCode: 0,
      stderr: '',
      stdout: VALID_VERSION_OUTPUT[executableName(executable)] ?? '',
    }));
  });

  it('admits only the complete exact toolchain declared by the ADR', async () => {
    await expect(verifyToolchain()).resolves.toMatchObject({
      npm: '/verified-bin/npm',
      postgres: '/verified-bin/postgres',
      'redis-server': '/verified-bin/redis-server',
      tsc: '/verified-bin/tsc',
    });
  });

  it('proves the canonical repository root and committed .dev ignore boundary', async () => {
    commandMocks.execute.mockImplementation(async (_executable, args) => {
      if (args[0] === 'rev-parse') {
        return { exitCode: 0, stderr: '', stdout: `${REPOSITORY_ROOT}\n` };
      }
      if (args[0] === 'check-ignore') {
        return { exitCode: 0, stderr: '', stdout: '' };
      }
      throw new Error(`unexpected git arguments: ${args.join(' ')}`);
    });

    await expect(verifyRepositoryIsolation()).resolves.toBeUndefined();
    expect(commandMocks.execute).toHaveBeenCalledWith(
      '/verified-bin/git',
      ['check-ignore', '-q', '--', '.dev/.preflight-probe'],
      expect.objectContaining({ allowExitCodes: [0, 1], cwd: REPOSITORY_ROOT }),
    );
  });

  it('fails closed when .dev is not ignored', async () => {
    commandMocks.execute.mockImplementation(async (_executable, args) => ({
      exitCode: args[0] === 'check-ignore' ? 1 : 0,
      stderr: '',
      stdout: args[0] === 'rev-parse' ? `${REPOSITORY_ROOT}\n` : '',
    }));

    await expect(verifyRepositoryIsolation()).rejects.toMatchObject({
      code: 'DEV_DIRECTORY_NOT_IGNORED',
    });
  });

  it.each([
    { name: 'npm', output: '11.17.0' },
    { name: 'tsc', output: 'Version 5.9.3' },
    { name: 'postgres', output: 'postgres (PostgreSQL) 16.13' },
    { name: 'redis-server', output: 'Redis server v=8.7.0' },
    { name: 'redis-server', output: 'Redis server v=8.10.0-evil' },
    { name: 'redis-cli', output: 'redis-cli 8.10.0-rc1' },
  ])('refuses a mismatched $name version', async ({ name, output }) => {
    commandMocks.execute.mockImplementation(async (executable) => {
      const executableBaseName = executableName(executable);
      return {
        exitCode: 0,
        stderr: '',
        stdout:
          executableBaseName === name ? output : (VALID_VERSION_OUTPUT[executableBaseName] ?? ''),
      };
    });

    await expect(verifyToolchain()).rejects.toMatchObject({
      code: 'DEV_TOOL_VERSION',
      details: expect.objectContaining({ received: output }),
    });
  });
});
