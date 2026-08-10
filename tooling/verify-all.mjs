import { runPinnedNpm } from './pinned-runtime.mjs';
import { refreshBuiltTopology } from './runtime-refresh.mjs';

async function runGate(scriptName) {
  process.stdout.write(`[verify-all] RUN npm run ${scriptName}\n`);
  await runPinnedNpm(['run', scriptName]);
}

process.stdout.write(
  '[verify-all] Scope: Tier 0 local-foundation verification only; this is not a release, deployment, product-completion, or production-readiness claim.\n',
);

await runGate('toolchain:check');
await runGate('check');
await runGate('test');
await runGate('build');

let startupFailure;
try {
  await refreshBuiltTopology();
} catch (error) {
  startupFailure = error;
}

if (startupFailure !== undefined) {
  let diagnosticHealthFailure;
  process.stderr.write(
    '[verify-all] DIAGNOSTIC runtime refresh failed; probing dev:health without stopping or starting any additional process.\n',
  );
  try {
    await runGate('dev:health');
  } catch (error) {
    diagnosticHealthFailure = error;
  }

  if (diagnosticHealthFailure !== undefined) {
    throw new AggregateError(
      [startupFailure, diagnosticHealthFailure],
      'Runtime refresh failed and the non-mutating diagnostic health probe also failed.',
      { cause: startupFailure },
    );
  }
  throw new Error(
    'Runtime refresh failed even though the non-mutating diagnostic health probe passed; refusing to test a runtime whose build identity was not re-established.',
    { cause: startupFailure },
  );
}

let testFailure;
try {
  await runGate('test:integration');
  await runGate('test:e2e');
} catch (error) {
  testFailure = error;
}

try {
  await runGate('dev:health');
} catch (healthError) {
  if (testFailure !== undefined) {
    throw new AggregateError(
      [testFailure, healthError],
      'A runtime test failed and the final local-topology health check also failed.',
      { cause: healthError },
    );
  }
  throw healthError;
}

if (testFailure !== undefined) {
  throw testFailure;
}

process.stdout.write(
  '[verify-all] PASS Tier 0 static, unit/property, build, runtime health, integration, and browser accessibility gates.\n',
);
process.stdout.write(
  '[verify-all] Scope: the verified local foundation is not a released product and is not yet in production.\n',
);
