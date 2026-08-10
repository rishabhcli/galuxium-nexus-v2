import {
  POSTGRES_SHUTDOWN_TIMEOUT_MS,
  SERVICE_BY_NAME,
  SHUTDOWN_TIMEOUT_MS,
  STOP_ORDER,
} from './constants.mjs';
import { isMain, runCli } from './cli.mjs';
import { DevContractError, errorMessage } from './errors.mjs';
import { ensureDevTree } from './filesystem.mjs';
import { listBlockListeners } from './listeners.mjs';
import {
  acquireOrchestratorLock,
  readOwnershipRecord,
  removeOwnershipRecord,
  verifyOwnership,
} from './ownership.mjs';

const DEFAULT_PROCESS_CONTROL = Object.freeze({
  kill: (pid, signal) => process.kill(pid, signal),
  now: () => Date.now(),
  sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
});

/**
 * Waits until the recorded process is provably no longer running.
 *
 * Every non-owned verification reason establishes that the recorded process has
 * exited, because each one describes a *different* process now occupying the
 * PID: the start time moved beyond tolerance, the process group differs, the
 * Linux kernel birth identity differs, or the command line no longer carries the
 * birth-identity token injected at spawn. A live process cannot shed its own
 * argv or change its start time, so "something else is at this PID" and "our
 * process is gone" are the same observation.
 *
 * Treating those reasons as errors was a real defect: the tooling itself spawns
 * short-lived `ps` and `lsof` children while polling, which churns through PIDs
 * and makes reuse of a just-exited service PID likely. That turned a successful
 * shutdown into DEV_DOWN_OWNERSHIP_CHANGED_WHILE_WAITING, left the ownership
 * record behind, and failed the gate for a condition that was actually success.
 *
 * The strictness that matters is retained where it matters: `sendVerifiedSignal`
 * still refuses to signal a PID that is not verifiably ours, so a reused PID can
 * never receive a signal intended for a service.
 */
async function waitForVerifiedExit(record, timeoutMs, processControl) {
  const deadline = processControl.now() + timeoutMs;
  for (;;) {
    const verification = await verifyOwnership(record);
    if (!verification.owned) {
      return true;
    }
    if (processControl.now() >= deadline) {
      return false;
    }
    await processControl.sleep(100);
  }
}

async function sendVerifiedSignal(record, signal, processControl) {
  const verification = await verifyOwnership(record);
  if (!verification.owned) {
    if (verification.reason === 'not-running') {
      return false;
    }
    throw new DevContractError(
      'DEV_DOWN_OWNERSHIP_MISMATCH',
      `Refusing to send ${signal} to PID ${record.pid} for ${record.service}; ownership verification failed.`,
      { reason: verification.reason },
    );
  }
  try {
    processControl.kill(record.pid, signal);
  } catch (error) {
    if (error?.code === 'ESRCH') {
      const afterSignal = await verifyOwnership(record);
      if (!afterSignal.owned && afterSignal.reason === 'not-running') {
        return false;
      }
    }
    throw error;
  }
  return true;
}

export async function stopOwnershipRecord(
  record,
  { processControl = DEFAULT_PROCESS_CONTROL, removeRecord = true } = {},
) {
  const service = SERVICE_BY_NAME.get(record.service);
  if (!service) {
    throw new DevContractError(
      'DEV_DOWN_UNKNOWN_SERVICE',
      `Refusing to stop an ownership record for unknown service ${String(record.service)}.`,
    );
  }
  const firstTimeout =
    service.kind === 'postgres'
      ? Math.floor(POSTGRES_SHUTDOWN_TIMEOUT_MS / 2)
      : SHUTDOWN_TIMEOUT_MS;

  const signalled = await sendVerifiedSignal(record, 'SIGTERM', processControl);
  if (!signalled || (await waitForVerifiedExit(record, firstTimeout, processControl))) {
    if (removeRecord) {
      await removeOwnershipRecord(record.service, {
        supervisorConfigPath: record.supervisorConfigPath,
      });
    }
    return { forced: false, service: record.service };
  }

  // Every service is supervised. SIGINT is forwarded to the exact child and
  // gives PostgreSQL its fast-shutdown path while retaining the supervisor as
  // an attributable group leader. Never SIGKILL the supervisor: doing so could
  // orphan a still-running target before it forwards the signal.
  await sendVerifiedSignal(record, 'SIGINT', processControl);
  const secondTimeout =
    service.kind === 'postgres' ? POSTGRES_SHUTDOWN_TIMEOUT_MS - firstTimeout : SHUTDOWN_TIMEOUT_MS;
  if (await waitForVerifiedExit(record, secondTimeout, processControl)) {
    if (removeRecord) {
      await removeOwnershipRecord(record.service, {
        supervisorConfigPath: record.supervisorConfigPath,
      });
    }
    return { forced: true, service: record.service };
  }

  throw new DevContractError(
    'DEV_DOWN_PROCESS_STUCK',
    `${record.service} PID ${String(record.pid)} remained exact-owned after bounded SIGTERM/SIGINT shutdown; ownership attribution was retained and no unsafe SIGKILL was sent.`,
  );
}

export async function stopOwnedServices({ onlyRunId = undefined, quiet = false } = {}) {
  const results = [];
  const errors = [];
  for (const serviceName of STOP_ORDER) {
    try {
      const record = await readOwnershipRecord(serviceName);
      if (!record || (onlyRunId && record.runId !== onlyRunId)) {
        continue;
      }
      const verification = await verifyOwnership(record);
      if (!verification.owned && verification.reason === 'not-running') {
        await removeOwnershipRecord(serviceName, {
          supervisorConfigPath: record.supervisorConfigPath,
        });
        results.push({ forced: false, service: serviceName, stale: true });
        continue;
      }
      if (!verification.owned) {
        throw new DevContractError(
          'DEV_DOWN_OWNERSHIP_MISMATCH',
          `Refusing to stop PID ${record.pid} for ${serviceName}; it is no longer the recorded process.`,
          { reason: verification.reason },
        );
      }
      results.push(await stopOwnershipRecord(record));
    } catch (error) {
      errors.push({ error, service: serviceName });
    }
  }

  if (!quiet) {
    for (const result of results) {
      const outcome = result.stale
        ? 'removed-stale-record'
        : result.forced
          ? 'stopped-after-verified-fast-shutdown'
          : 'stopped';
      process.stdout.write(`[dev:down] PASS ${result.service} ${outcome}\n`);
    }
  }
  if (errors.length > 0) {
    throw new DevContractError(
      'DEV_DOWN_PARTIAL_FAILURE',
      'One or more owned services could not be stopped safely; no unverified PID was signalled.',
      errors.map(({ error, service }) => ({
        message: errorMessage(error),
        service,
      })),
      { cause: errors[0].error },
    );
  }
  return results;
}

export async function down({ quiet = false } = {}) {
  await ensureDevTree();
  const releaseLock = await acquireOrchestratorLock('dev:down');
  try {
    const results = await stopOwnedServices({ quiet });
    const remainingListeners = await listBlockListeners();
    if (remainingListeners.length > 0) {
      throw new DevContractError(
        'DEV_DOWN_FOREIGN_LISTENERS_REMAIN',
        'The repository-owned services are down, but a foreign listener now occupies the exclusive block. It was not killed.',
        remainingListeners,
      );
    }
    if (!quiet && results.length === 0) {
      process.stdout.write('[dev:down] PASS no repository-owned services were running.\n');
    }
    return results;
  } finally {
    await releaseLock();
  }
}

export async function stopOwnedRun(runId, { quiet = true } = {}) {
  if (typeof runId !== 'string' || !/^[0-9a-f-]{36}$/u.test(runId)) {
    throw new DevContractError(
      'DEV_DOWN_RUN_ID_INVALID',
      'Exact-run shutdown requires a valid recorded run UUID.',
    );
  }
  await ensureDevTree();
  const releaseLock = await acquireOrchestratorLock('dev:down-run');
  try {
    return await stopOwnedServices({ onlyRunId: runId, quiet });
  } finally {
    await releaseLock();
  }
}

if (isMain(import.meta.url)) {
  await runCli(() => down());
}
