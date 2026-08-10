import { down, stopOwnedRun } from './dev/down.mjs';
import { health } from './dev/health.mjs';
import { preflight } from './dev/preflight.mjs';
import { up } from './dev/up.mjs';

export async function refreshBuiltTopology({
  downAction = down,
  healthAction = health,
  output = process.stdout,
  preflightAction = preflight,
  stopRunAction = stopOwnedRun,
  upAction = up,
} = {}) {
  await preflightAction();
  await downAction();
  await preflightAction();
  let runtime;
  try {
    runtime = await upAction();
    if (runtime.alreadyRunning) {
      throw new Error(
        'Runtime refresh expected an exact stop before startup but dev:up reported a pre-existing topology.',
      );
    }
    await healthAction();
  } catch (error) {
    if (runtime && !runtime.alreadyRunning) {
      try {
        await stopRunAction(runtime.runId);
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          'Runtime refresh failed and exact-owned teardown could not be proven complete.',
          { cause: cleanupError },
        );
      }
    }
    throw error;
  }
  output.write(
    `[runtime-refresh] PASS freshly built repository-owned topology is running and healthy run=${runtime.runId}.\n`,
  );
  output.write(
    '[runtime-refresh] Scope: local deterministic infrastructure only; not a release, deployment, or production claim.\n',
  );
  return runtime;
}
