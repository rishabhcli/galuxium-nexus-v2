import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

import { DEV_PATHS } from './constants.mjs';
import { isMain, runCli } from './cli.mjs';
import { down } from './down.mjs';
import { errorMessage } from './errors.mjs';
import { health } from './health.mjs';
import { up } from './up.mjs';

export const E2E_LIFECYCLE_PATH = path.join(DEV_PATHS.tmp, 'e2e-server-lifecycle.json');

const DEFAULT_TIMER_CONTROL = Object.freeze({
  clearInterval: (handle) => clearInterval(handle),
  setInterval: (callback, milliseconds) => setInterval(callback, milliseconds),
});

/**
 * Records the webServer's own view of the topology lifecycle.
 *
 * Playwright's shutdown returns when the process it spawned exits, which is not
 * the same instant as the topology being down. Counting listeners immediately
 * after Playwright returns therefore samples a race. This record lets the owned
 * runner assert positively that this process started the topology and completed
 * its own teardown, rather than inferring it from a listener count.
 */
async function writeLifecycle(value) {
  await fs.mkdir(DEV_PATHS.tmp, { mode: 0o700, recursive: true });
  const temporaryPath = `${E2E_LIFECYCLE_PATH}.${String(process.pid)}.partial`;
  const handle = await fs.open(
    temporaryPath,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  // Rename so a reader never observes a partially written record.
  await fs.rename(temporaryPath, E2E_LIFECYCLE_PATH);
}

export async function readE2eLifecycle({ lifecyclePath = E2E_LIFECYCLE_PATH } = {}) {
  try {
    const contents = await fs.readFile(lifecyclePath, 'utf8');
    const parsed = JSON.parse(contents);
    return parsed !== null && typeof parsed === 'object' ? parsed : undefined;
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

export async function clearE2eLifecycle({ lifecyclePath = E2E_LIFECYCLE_PATH } = {}) {
  await fs.rm(lifecyclePath, { force: true });
}

export async function e2eServer({
  downAction = down,
  healthAction = health,
  runtimeProcess = process,
  timerControl = DEFAULT_TIMER_CONTROL,
  upAction = up,
  writeLifecycleAction = writeLifecycle,
} = {}) {
  let runtime;
  let monitor;
  let monitorPromise;
  let onInterrupt;
  let onTerminate;
  let primaryError;
  let teardownError;
  const startedAt = new Date().toISOString();
  try {
    runtime = await upAction();
    await healthAction();
    await writeLifecycleAction({
      phase: 'ready',
      pid: runtimeProcess.pid,
      runId: runtime.runId,
      startedAt,
      startedHere: !runtime.alreadyRunning,
      schemaVersion: 1,
    });
    runtimeProcess.stdout.write(
      `[dev:e2e-server] READY run=${runtime.runId} ownership=${runtime.alreadyRunning ? 'pre-existing' : 'started-here'}\n`,
    );

    let resolveStop;
    const stopRequested = new Promise((resolve) => {
      resolveStop = resolve;
    });
    let stopped = false;
    const requestStop = (reason) => {
      if (!stopped) {
        stopped = true;
        resolveStop(reason);
      }
    };
    onInterrupt = () => requestStop('SIGINT');
    onTerminate = () => requestStop('SIGTERM');
    runtimeProcess.once('SIGINT', onInterrupt);
    runtimeProcess.once('SIGTERM', onTerminate);

    monitor = timerControl.setInterval(() => {
      if (monitorPromise) {
        return;
      }
      monitorPromise = healthAction({ quiet: true })
        .catch((error) => {
          runtimeProcess.stderr.write(`[dev:e2e-server] HEALTH_FAILED ${errorMessage(error)}\n`);
          runtimeProcess.exitCode = 1;
          requestStop('HEALTH_FAILED');
        })
        .finally(() => {
          monitorPromise = undefined;
        });
    }, 5_000);

    const reason = await stopRequested;
    runtimeProcess.stdout.write(`[dev:e2e-server] stopping reason=${String(reason)}\n`);
  } catch (error) {
    primaryError = error;
  } finally {
    if (monitor !== undefined) {
      timerControl.clearInterval(monitor);
    }
    if (onInterrupt && onTerminate) {
      runtimeProcess.removeListener('SIGINT', onInterrupt);
      runtimeProcess.removeListener('SIGTERM', onTerminate);
    }
    await monitorPromise;
    if (runtime && !runtime.alreadyRunning) {
      try {
        await downAction();
      } catch (error) {
        teardownError = error;
      }
      // Record the outcome either way. A teardown that failed must be
      // observable to the runner, not silently indistinguishable from one that
      // never started.
      await writeLifecycleAction({
        phase: teardownError === undefined ? 'torn-down' : 'teardown-failed',
        pid: runtimeProcess.pid,
        runId: runtime.runId,
        startedAt,
        startedHere: true,
        schemaVersion: 1,
        teardownCompletedAt: new Date().toISOString(),
        ...(teardownError === undefined ? {} : { teardownError: errorMessage(teardownError) }),
      });
      if (teardownError === undefined) {
        runtimeProcess.stdout.write('[dev:e2e-server] PASS stopped the topology it started.\n');
      }
    } else if (runtime) {
      await writeLifecycleAction({
        phase: 'left-running',
        pid: runtimeProcess.pid,
        runId: runtime.runId,
        startedAt,
        startedHere: false,
        schemaVersion: 1,
        teardownCompletedAt: new Date().toISOString(),
      });
    }
  }

  // Surfacing both keeps a teardown failure from hiding the failure that caused
  // the shutdown, and keeps a startup failure from hiding a leaked topology.
  if (primaryError !== undefined && teardownError !== undefined) {
    throw new AggregateError(
      [primaryError, teardownError],
      'The Playwright web server failed and its exact-owned teardown also failed.',
      { cause: primaryError },
    );
  }
  if (primaryError !== undefined) {
    throw primaryError;
  }
  if (teardownError !== undefined) {
    throw teardownError;
  }
}

if (isMain(import.meta.url)) {
  await runCli(() => e2eServer());
}
