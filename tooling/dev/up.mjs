import { POSTGRES, SERVICE_BY_NAME, SERVICE_DEFINITIONS, START_ORDER } from './constants.mjs';
import { isMain, runCli } from './cli.mjs';
import { stopOwnedServices } from './down.mjs';
import { DevContractError, errorMessage } from './errors.mjs';
import { ensureDevTree, ensureSecretFile } from './filesystem.mjs';
import { health } from './health.mjs';
import { acquireOrchestratorLock, loadVerifiedOwnershipRecords } from './ownership.mjs';
import { preflight } from './preflight.mjs';
import {
  createRunId,
  startNodeService,
  startPostgres,
  startRedis,
  validateCompiledEntries,
} from './runtime.mjs';

async function startService(service, context) {
  if (service.kind === 'postgres') {
    return startPostgres(service, context);
  }
  if (service.kind === 'redis') {
    return startRedis(service, context);
  }
  return startNodeService(service, context);
}

export async function up({ quiet = false } = {}) {
  await ensureDevTree();
  const releaseLock = await acquireOrchestratorLock('dev:up');
  let runId;
  try {
    const existing = await loadVerifiedOwnershipRecords({ removeStale: true });
    // Listener/toolchain preflight is intentionally inside the orchestrator
    // lock and after the only stale-record cleanup path. Health and listener
    // audits remain non-mutating.
    let preflightResult = await preflight({ quiet: true });
    if (existing.size === SERVICE_DEFINITIONS.length) {
      try {
        await health({ quiet: true });
        const existingRunIds = new Set([...existing.values()].map((record) => record.runId));
        if (existingRunIds.size !== 1) {
          throw new DevContractError(
            'DEV_MIXED_RUN_OWNERSHIP',
            'Healthy services have mixed run IDs; refusing to call the runtime coherent.',
          );
        }
        const [existingRunId] = existingRunIds;
        if (!quiet) {
          process.stdout.write(
            `[dev:up] PASS existing repository-owned runtime is healthy run=${existingRunId}.\n`,
          );
        }
        return { alreadyRunning: true, runId: existingRunId };
      } catch {
        // An owned but unhealthy topology is repaired below after validating artifacts.
      }
    }

    await validateCompiledEntries(SERVICE_DEFINITIONS);
    if (existing.size > 0) {
      await stopOwnedServices({ quiet: true });
    }

    // Recheck the full block after stopping stale/partial owned services. A foreign
    // process that won the race is reported by preflight and is never killed.
    preflightResult = await preflight({ quiet: true });
    const [password, ownerPassword] = await Promise.all([
      ensureSecretFile(POSTGRES.passwordFile),
      ensureSecretFile(POSTGRES.ownerPasswordFile),
    ]);
    runId = createRunId();
    const context = {
      password,
      ownerPassword,
      runId,
      tools: preflightResult.tools,
    };

    for (const serviceName of START_ORDER) {
      const service = SERVICE_BY_NAME.get(serviceName);
      await startService(service, context);
      if (!quiet) {
        process.stdout.write(`[dev:up] PASS ${service.name} pid-recorded port=${service.port}\n`);
      }
    }

    await health({ quiet: true });
    if (!quiet) {
      process.stdout.write(
        `[dev:up] PASS local topology started and health-checked run=${runId}.\n`,
      );
      process.stdout.write(
        '[dev:up] Scope: no product completion, deployment, or production claim is asserted.\n',
      );
    }
    return { alreadyRunning: false, runId };
  } catch (error) {
    if (runId) {
      try {
        await stopOwnedServices({ onlyRunId: runId, quiet: true });
      } catch (rollbackError) {
        throw new DevContractError(
          'DEV_UP_FAILED_ROLLBACK_INCOMPLETE',
          'dev:up failed and one or more exact owned PIDs could not be rolled back safely.',
          {
            rollbackError: errorMessage(rollbackError),
            startupError: errorMessage(error),
          },
          { cause: error },
        );
      }
    }
    throw error;
  } finally {
    await releaseLock();
  }
}

if (isMain(import.meta.url)) {
  await runCli(() => up());
}
