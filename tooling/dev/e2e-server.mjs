import { isMain, runCli } from './cli.mjs';
import { down } from './down.mjs';
import { health } from './health.mjs';
import { up } from './up.mjs';

const DEFAULT_TIMER_CONTROL = Object.freeze({
  clearInterval: (handle) => clearInterval(handle),
  setInterval: (callback, milliseconds) => setInterval(callback, milliseconds),
});

export async function e2eServer({
  downAction = down,
  healthAction = health,
  runtimeProcess = process,
  timerControl = DEFAULT_TIMER_CONTROL,
  upAction = up,
} = {}) {
  let runtime;
  let monitor;
  let monitorPromise;
  let onInterrupt;
  let onTerminate;
  try {
    runtime = await upAction();
    await healthAction();
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
          runtimeProcess.stderr.write(
            `[dev:e2e-server] HEALTH_FAILED ${error instanceof Error ? error.message : String(error)}\n`,
          );
          runtimeProcess.exitCode = 1;
          requestStop('HEALTH_FAILED');
        })
        .finally(() => {
          monitorPromise = undefined;
        });
    }, 5_000);

    const reason = await stopRequested;
    runtimeProcess.stdout.write(`[dev:e2e-server] stopping reason=${String(reason)}\n`);
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
      await downAction();
    }
  }
}

if (isMain(import.meta.url)) {
  await runCli(() => e2eServer());
}
