import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';

import {
  assertDependencyRegisterSchemaRefusals,
  JsonSchemaValidationError,
  validateJsonSchema,
} from './schema-validator.mjs';

const DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const [register, schema] = await Promise.all([
  fs.readFile(path.join(DIRECTORY, 'register.json'), 'utf8').then(JSON.parse),
  fs.readFile(path.join(DIRECTORY, 'register.schema.json'), 'utf8').then(JSON.parse),
]);

function expectRefusal(mutate) {
  const candidate = structuredClone(register);
  mutate(candidate);
  assert.throws(() => validateJsonSchema(schema, candidate), JsonSchemaValidationError);
}

test('the committed dependency register satisfies its committed JSON Schema', () => {
  assert.doesNotThrow(() => validateJsonSchema(schema, register));
});

test('unknown register, dependency, and nested review properties are refused', () => {
  expectRefusal((candidate) => {
    candidate.unknownRootProperty = true;
  });
  expectRefusal((candidate) => {
    candidate.dependencies[0].unknownDependencyProperty = true;
  });
  expectRefusal((candidate) => {
    candidate.dependencies[0].review.license.unknownReviewProperty = true;
  });
  for (const inheritedName of ['constructor', 'toString', '__proto__']) {
    expectRefusal((candidate) => {
      Object.defineProperty(candidate, inheritedName, {
        configurable: true,
        enumerable: true,
        value: true,
        writable: true,
      });
    });
  }
});

test('malformed nested review fields are refused', () => {
  expectRefusal((candidate) => {
    candidate.dependencies[0].review.maintenance.evidence = 42;
  });
  expectRefusal((candidate) => {
    candidate.dependencies[0].review.securityHistory.timeSensitive = 'yes';
  });
  expectRefusal((candidate) => {
    delete candidate.dependencies[0].review.cost.status;
  });
});

test('malformed and extended managed component rows are refused', () => {
  expectRefusal((candidate) => {
    candidate.managedArtifacts[0].components[0].revision = 'not-a-revision';
  });
  expectRefusal((candidate) => {
    candidate.managedArtifacts[0].components[0].unknownComponentProperty = true;
  });
});

test('native provenance variants refuse unknown fields, bad discriminators, and bad digests', () => {
  expectRefusal((candidate) => {
    candidate.nativeTools[0].provenance.unknownProvenanceProperty = true;
  });
  expectRefusal((candidate) => {
    candidate.nativeTools[0].provenance.kind = 'bundled-cli';
  });
  expectRefusal((candidate) => {
    const sourceBuiltTool = candidate.nativeTools.find(
      (tool) => tool.provenance.kind === 'source-built-native',
    );
    sourceBuiltTool.provenance.sourceSha256 = 'not-a-sha256';
  });
});

test('the verifier negative-probe suite remains active', () => {
  assert.deepEqual(assertDependencyRegisterSchemaRefusals(schema, register), {
    refusedProbeCount: 11,
  });
});
