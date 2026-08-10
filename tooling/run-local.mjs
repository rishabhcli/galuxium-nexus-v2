import { runPinnedNpm } from './pinned-runtime.mjs';
import { refreshBuiltTopology } from './runtime-refresh.mjs';

process.stdout.write(
  '[run-local] Building the current checked-out sources before runtime refresh.\n',
);
await runPinnedNpm(['run', 'toolchain:check']);
await runPinnedNpm(['run', 'build']);
await refreshBuiltTopology();
process.stdout.write(
  '[run-local] PASS the local foundation topology is healthy; the product is not yet in production.\n',
);
