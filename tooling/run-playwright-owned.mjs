import { auditBlockListeners } from './dev/listeners.mjs';
import { clearE2eLifecycle, readE2eLifecycle } from './dev/e2e-server.mjs';
import { isMain } from './dev/cli.mjs';
import { down } from './dev/down.mjs';
import { health } from './dev/health.mjs';
import { preflight } from './dev/preflight.mjs';
import { up } from './dev/up.mjs';
import { runPinnedNpm } from './pinned-runtime.mjs';

// Playwright's gracefulShutdown returns when the process it spawned exits.
// That is not the same instant as the topology being down, so the proof waits
// for the webServer's own recorded teardown rather than sampling immediately.
export const TEARDOWN_PROOF_TIMEOUT_MS = 60_000;
const TEARDOWN_POLL_INTERVAL_MS = 200;

const DEFAULT_TEARDOWN_DEPENDENCIES = Object.freeze({
  auditListeners: auditBlockListeners,
  now: () => Date.now(),
  readLifecycle: readE2eLifecycle,
  sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
});

function describeObservation({ lifecycle, listenerCount, recordCount }) {
  const phase = lifecycle?.phase ?? 'absent';
  const startedHere = lifecycle === undefined ? 'unknown' : String(lifecycle.startedHere === true);
  return (
    `lifecycle=${phase} startedHere=${startedHere} ` +
    `listeners=${String(listenerCount)} ownershipRecords=${String(recordCount)}` +
    (lifecycle?.teardownError === undefined ? '' : ` teardownError=${lifecycle.teardownError}`)
  );
}

/**
 * Proves that Playwright's own `webServer` command started this repository's
 * topology and then stopped exactly what it started.
 *
 * A listener count alone cannot establish this: zero listeners is also what a
 * webServer that never started would leave behind, and a non-zero count may
 * only mean the exit has not been observed yet. So this requires the webServer
 * to have recorded that it started the topology itself and completed its own
 * teardown, and then requires the block to be empty.
 */
export async function assertPlaywrightTeardown(dependencies = {}) {
  const { auditListeners, now, readLifecycle, sleep } = {
    ...DEFAULT_TEARDOWN_DEPENDENCIES,
    ...dependencies,
  };
  const deadline = now() + TEARDOWN_PROOF_TIMEOUT_MS;
  let observation;

  for (;;) {
    const lifecycle = await readLifecycle();
    const { listeners, records } = await auditListeners();
    observation = { lifecycle, listenerCount: listeners.length, recordCount: records.size };

    if (lifecycle?.phase === 'torn-down' && listeners.length === 0 && records.size === 0) {
      if (lifecycle.startedHere !== true) {
        throw new Error(
          `Playwright reused a topology it did not start, so its webServer teardown proves nothing: ${describeObservation(observation)}`,
        );
      }
      return lifecycle;
    }
    // A recorded teardown failure is terminal; waiting cannot improve it.
    if (lifecycle?.phase === 'teardown-failed' || lifecycle?.phase === 'left-running') {
      break;
    }
    if (now() >= deadline) {
      break;
    }
    await sleep(TEARDOWN_POLL_INTERVAL_MS);
  }

  throw new Error(
    `Playwright webServer did not prove it stopped the topology it started within ` +
      `${String(TEARDOWN_PROOF_TIMEOUT_MS)}ms: ${describeObservation(observation)}`,
  );
}

export async function runPlaywrightWithOwnedTopology() {
  // Begin from an exact down state so Playwright cannot silently reuse a server
  // built or started by a previous gate, and discard any earlier lifecycle
  // record so a stale one can never be mistaken for this run's proof.
  await down({ quiet: true });
  await clearE2eLifecycle();
  await preflight({ quiet: true });

  let testFailure;
  try {
    await runPinnedNpm(['run', 'test:e2e:playwright']);
  } catch (error) {
    testFailure = error;
  }

  let teardownFailure;
  try {
    const lifecycle = await assertPlaywrightTeardown();
    process.stdout.write(
      `[playwright-owned] PASS Playwright started and stopped its exact repository-owned webServer topology run=${String(lifecycle.runId)}.\n`,
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

if (isMain(import.meta.url)) {
  await runPlaywrightWithOwnedTopology();
}
