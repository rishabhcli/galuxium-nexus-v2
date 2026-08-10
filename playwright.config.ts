import path from 'node:path';

import { defineConfig } from '@playwright/test';

const repositoryRoot = import.meta.dirname;
const devRoot = path.join(repositoryRoot, '.dev');

// Playwright normally allocates browser profiles below the operating-system
// temp directory. Pinning TMPDIR keeps every worker profile inside this
// repository's private namespace instead of a shared/default browser profile.
process.env['TMPDIR'] = path.join(devRoot, 'pw-profile');
process.env['PLAYWRIGHT_BROWSERS_PATH'] = path.join(devRoot, 'cache', 'playwright');
// Playwright forces colour for its worker reporter. Inheriting NO_COLOR at the
// same time makes Node emit a warning in every worker, which would turn a clean
// gate into a warning-tolerant one. Remove the contradictory worker input at
// this tool boundary; test semantics and artifacts do not depend on colour.
delete process.env['NO_COLOR'];

export default defineConfig({
  forbidOnly: true,
  fullyParallel: true,
  globalSetup: './tooling/dev/playwright-global-setup.mjs',
  outputDir: '.dev/tmp/playwright-results',
  reporter: [['list']],
  testDir: './tests/e2e',
  use: {
    baseURL: 'http://127.0.0.1:4162',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
  },
  webServer: {
    // Run the pinned Node binary directly rather than through `npm run`.
    // Playwright's graceful shutdown signals the process it spawned; with an
    // npm shim in between, npm's exit is not the topology's exit, so the runner
    // could audit the port block while the server was still tearing down. This
    // also guarantees the exact pinned runtime rather than whatever `node`
    // resolves to on PATH inside the spawned shell.
    command: `${JSON.stringify(process.execPath)} tooling/dev/e2e-server.mjs`,
    gracefulShutdown: { signal: 'SIGTERM', timeout: 30_000 },
    reuseExistingServer: false,
    stderr: 'pipe',
    stdout: 'pipe',
    timeout: 60_000,
    url: 'http://127.0.0.1:4162/readyz',
  },
});
