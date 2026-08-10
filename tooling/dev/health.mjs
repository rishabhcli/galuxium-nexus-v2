import { SERVICE_DEFINITIONS, STARTUP_TIMEOUT_MS } from './constants.mjs';
import { isMain, runCli } from './cli.mjs';
import { readPortConfiguration } from './config.mjs';
import { auditBlockListeners } from './listeners.mjs';
import { verifyToolchain } from './preflight.mjs';
import { waitForReadiness } from './readiness.mjs';

export async function health({ quiet = false } = {}) {
  await readPortConfiguration();
  const tools = await verifyToolchain();
  const results = await Promise.all(
    SERVICE_DEFINITIONS.map((service) =>
      waitForReadiness(service, { timeoutMs: STARTUP_TIMEOUT_MS, tools }),
    ),
  );
  // Readiness polling tolerates the designed startup interval. Once every
  // protocol probe succeeds, require the complete listener topology as an
  // independent loopback/port-ownership assertion.
  await auditBlockListeners({ requireAllAllocated: true });

  if (!quiet) {
    for (const result of results) {
      process.stdout.write(`[dev:health] PASS ${result.service} ${result.detail}\n`);
    }
    process.stdout.write(
      '[dev:health] PASS local development topology is ready on 127.0.0.1:4160-4169.\n',
    );
    process.stdout.write(
      '[dev:health] Scope: this does not assert a completed product, release gate, deployment, or production state.\n',
    );
  }
  return results;
}

if (isMain(import.meta.url)) {
  await runCli(() => health());
}
