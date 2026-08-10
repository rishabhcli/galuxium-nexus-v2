const GATE_MESSAGES = Object.freeze({
  eval: Object.freeze({
    code: 'DOMAIN_EVALUATION_UNAVAILABLE',
    message:
      'No production domain evaluation manifest or publishable domain metric exists yet; refusing to imply an evaluation passed.',
  }),
  'release-check': Object.freeze({
    code: 'RELEASE_CHECK_UNAVAILABLE',
    message:
      'The artifact, SBOM, and Tier 13 release gates do not exist yet; refusing to imply this local foundation is releasable.',
  }),
});

const [gateName, ...unexpectedArguments] = process.argv.slice(2);
const gate = GATE_MESSAGES[gateName];
if (gate === undefined || unexpectedArguments.length > 0) {
  process.stderr.write('Usage: node tooling/unavailable-gate.mjs <eval|release-check>\n');
  process.exitCode = 64;
} else {
  process.stderr.write(`[${gateName}] UNAVAILABLE code=${gate.code} ${gate.message}\n`);
  process.exitCode = 69;
}
