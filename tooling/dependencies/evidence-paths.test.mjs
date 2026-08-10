import assert from 'node:assert/strict';
import { test } from 'vitest';

import {
  assertEvidencePathSafetyRefusals,
  assertNoAbsoluteLocalPaths,
  normalizeEvidencePath,
  normalizeLocalRootsInText,
} from './evidence-paths.mjs';

const OPTIONS = {
  homeDirectory: '/Users/dependency-reviewer',
  repositoryRoot: '/Users/dependency-reviewer/work/galuxium-nexus-v2',
};

test('repository paths become portable repository-relative paths', () => {
  assert.equal(
    normalizeEvidencePath(
      '/Users/dependency-reviewer/work/galuxium-nexus-v2/.dev/cache/node/bin/node',
      OPTIONS,
    ),
    '.dev/cache/node/bin/node',
  );
});

test('external home paths are redacted and external platform paths remain explicit', () => {
  assert.equal(
    normalizeEvidencePath('/Users/dependency-reviewer/.local/bin/tool', OPTIONS),
    '<home>/.local/bin/tool',
  );
  assert.equal(
    normalizeEvidencePath('/opt/toolchain/bin/tool', OPTIONS),
    '/opt/toolchain/bin/tool',
  );
});

test('local roots embedded in native-linkage text are normalized', () => {
  assert.equal(
    normalizeLocalRootsInText(
      '/Users/dependency-reviewer/work/galuxium-nexus-v2/.dev/lib/tool.dylib (compatibility)',
      OPTIONS,
    ),
    './.dev/lib/tool.dylib (compatibility)',
  );
  assert.equal(
    normalizeLocalRootsInText('/Users/dependency-reviewer/.local/lib/tool.dylib', OPTIONS),
    '<home>/.local/lib/tool.dylib',
  );
});

test('raw repository and home paths are refused anywhere in evidence', () => {
  assert.throws(
    () =>
      assertNoAbsoluteLocalPaths(
        { nested: ['/Users/dependency-reviewer/work/galuxium-nexus-v2/private'] },
        OPTIONS,
      ),
    /absolute repository or home path/u,
  );
  assert.throws(
    () => assertNoAbsoluteLocalPaths({ path: '/home/runner/private' }, OPTIONS),
    /absolute repository or home path/u,
  );
  assert.throws(
    () => assertNoAbsoluteLocalPaths({ path: 'prefix:/Users/alice/private' }, OPTIONS),
    /absolute repository or home path/u,
  );
  assert.throws(
    () => assertNoAbsoluteLocalPaths({ '/home/alice/private-key': 'safe' }, OPTIONS),
    /absolute repository or home path/u,
  );
  assert.doesNotThrow(() =>
    assertNoAbsoluteLocalPaths(
      { externalPlatformPath: '/opt/toolchain/bin/tool', repositoryPath: '.dev/cache/tool' },
      OPTIONS,
    ),
  );
});

test('the verifier local-path negative-probe suite remains active', () => {
  assert.deepEqual(assertEvidencePathSafetyRefusals(OPTIONS), { refusedProbeCount: 6 });
});
