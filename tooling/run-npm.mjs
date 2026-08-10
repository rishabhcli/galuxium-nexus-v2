import { runPinnedNpm } from './pinned-runtime.mjs';

const args = process.argv.slice(2);
if (args.length === 0) {
  process.stderr.write('Usage: node tooling/run-npm.mjs <npm arguments...>\n');
  process.exitCode = 64;
} else {
  await runPinnedNpm(args).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
