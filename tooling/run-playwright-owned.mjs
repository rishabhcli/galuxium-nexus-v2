import { auditBlockListeners } from './dev/listeners.mjs';
import { down } from './dev/down.mjs';
import { health } from './dev/health.mjs';
import { preflight } from './dev/preflight.mjs';
import { up } from './dev/up.mjs';
import { runPinnedNpm } from './pinned-runtime.mjs';

async function assertPlaywrightTeardown() {
  const { listeners, records } = await auditBlockListeners();
  if (listeners.length !== 0 || records.size !== 0) {
    throw new Error(
      `Playwright webServer teardown left ${String(listeners.length)} listener(s) and ${String(records.size)} verified ownership record(s).`,
    );
  }
}

export async function runPlaywrightWithOwnedTopology() {
  // Begin from an exact down state so Playwright cannot silently reuse a server
  // built or started by a previous gate.
  await down({ quiet: true });
  await preflight({ quiet: true });

  let testFailure;
  try {
    await runPinnedNpm(['run', 'test:e2e:playwright']);
  } catch (error) {
    testFailure = error;
  }

  let teardownFailure;
  try {
    await assertPlaywrightTeardown();
    process.stdout.write(
      '[playwright-owned] PASS Playwright started and stopped its exact repository-owned webServer topology.\n',
    );
  } catch (error) {
    teardownFailure = error;
    try {
      await down({ quiet: true });
    } catch (cleanupError) {
      teardownFailure = new AggregateError(
        [error, cleanupError],
        'Playwright teardown proof failed and exact-owned cleanup was incomplete.',
        { cause: error },
      );
    }
  }

  let recoveryFailure;
  try {
    const runtime = await up({ quiet: true });
    await health({ quiet: true });
    process.stdout.write(
      `[playwright-owned] PASS standing topology restored after webServer teardown run=${runtime.runId}.\n`,
    );
  } catch (error) {
    recoveryFailure = error;
  }

  const failures = [testFailure, teardownFailure, recoveryFailure].filter(
    (failure) => failure !== undefined,
  );
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      'Playwright-owned E2E verification, teardown proof, or standing-health recovery failed.',
      { cause: failures[0] },
    );
  }
}

await runPlaywrightWithOwnedTopology();
