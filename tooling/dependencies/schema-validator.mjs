import { isDeepStrictEqual } from 'node:util';

const MAXIMUM_VALIDATION_DEPTH = 128;
const MAXIMUM_VALIDATION_STEPS = 1_000_000;
const SUPPORTED_SCHEMA_KEYWORDS = new Set([
  '$defs',
  '$ref',
  '$schema',
  'additionalProperties',
  'const',
  'enum',
  'items',
  'minItems',
  'minLength',
  'minProperties',
  'oneOf',
  'pattern',
  'properties',
  'required',
  'title',
  'type',
  'uniqueItems',
]);
const SUPPORTED_TYPES = new Set([
  'array',
  'boolean',
  'integer',
  'null',
  'number',
  'object',
  'string',
]);

export class JsonSchemaValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'JsonSchemaValidationError';
  }
}

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertSchema(condition, message) {
  if (!condition) {
    throw new Error(`Unsupported or malformed committed JSON Schema: ${message}`);
  }
}

function assertSupportedSchema(schemaNode, location = '#', depth = 0) {
  assertSchema(depth <= MAXIMUM_VALIDATION_DEPTH, 'schema nesting exceeds the safety limit');
  assertSchema(isObject(schemaNode), `${location} must be an object`);
  for (const keyword of Object.keys(schemaNode)) {
    assertSchema(
      SUPPORTED_SCHEMA_KEYWORDS.has(keyword),
      `${location} uses unsupported keyword ${keyword}`,
    );
  }

  if (schemaNode.$ref !== undefined) {
    assertSchema(
      typeof schemaNode.$ref === 'string' && schemaNode.$ref.startsWith('#/'),
      `${location} has a non-local $ref`,
    );
  }
  if (schemaNode.type !== undefined) {
    const types = Array.isArray(schemaNode.type) ? schemaNode.type : [schemaNode.type];
    assertSchema(
      types.length > 0 && types.every((type) => SUPPORTED_TYPES.has(type)),
      `${location} has an unsupported type`,
    );
  }
  if (schemaNode.required !== undefined) {
    assertSchema(
      Array.isArray(schemaNode.required) &&
        schemaNode.required.every((property) => typeof property === 'string'),
      `${location}.required must be an array of strings`,
    );
  }
  for (const keyword of ['minItems', 'minLength', 'minProperties']) {
    if (schemaNode[keyword] !== undefined) {
      assertSchema(
        Number.isInteger(schemaNode[keyword]) && schemaNode[keyword] >= 0,
        `${location}.${keyword} must be a non-negative integer`,
      );
    }
  }
  if (schemaNode.uniqueItems !== undefined) {
    assertSchema(typeof schemaNode.uniqueItems === 'boolean', `${location}.uniqueItems is invalid`);
  }
  if (schemaNode.pattern !== undefined) {
    assertSchema(typeof schemaNode.pattern === 'string', `${location}.pattern must be a string`);
    try {
      new RegExp(schemaNode.pattern, 'u');
    } catch {
      throw new Error(
        `Unsupported or malformed committed JSON Schema: ${location}.pattern is invalid`,
      );
    }
  }
  if (schemaNode.enum !== undefined) {
    assertSchema(
      Array.isArray(schemaNode.enum) && schemaNode.enum.length > 0,
      `${location}.enum must be a non-empty array`,
    );
  }
  if (schemaNode.oneOf !== undefined) {
    assertSchema(
      Array.isArray(schemaNode.oneOf) && schemaNode.oneOf.length > 0,
      `${location}.oneOf must be a non-empty array`,
    );
    schemaNode.oneOf.forEach((variant, index) =>
      assertSupportedSchema(variant, `${location}/oneOf/${String(index)}`, depth + 1),
    );
  }
  if (schemaNode.items !== undefined) {
    assertSupportedSchema(schemaNode.items, `${location}/items`, depth + 1);
  }
  if (schemaNode.additionalProperties !== undefined) {
    assertSchema(
      typeof schemaNode.additionalProperties === 'boolean' ||
        isObject(schemaNode.additionalProperties),
      `${location}.additionalProperties is invalid`,
    );
    if (isObject(schemaNode.additionalProperties)) {
      assertSupportedSchema(
        schemaNode.additionalProperties,
        `${location}/additionalProperties`,
        depth + 1,
      );
    }
  }
  for (const containerName of ['$defs', 'properties']) {
    const container = schemaNode[containerName];
    if (container === undefined) {
      continue;
    }
    assertSchema(isObject(container), `${location}/${containerName} must be an object`);
    for (const [name, childSchema] of Object.entries(container)) {
      assertSupportedSchema(
        childSchema,
        `${location}/${containerName}/${name.replaceAll('~', '~0').replaceAll('/', '~1')}`,
        depth + 1,
      );
    }
  }
}

function resolveLocalReference(rootSchema, reference) {
  const segments = reference
    .slice(2)
    .split('/')
    .map((segment) => segment.replaceAll('~1', '/').replaceAll('~0', '~'));
  let current = rootSchema;
  for (const segment of segments) {
    if (!isObject(current) || !Object.hasOwn(current, segment)) {
      throw new Error(`Committed JSON Schema contains an unresolved reference: ${reference}`);
    }
    current = current[segment];
  }
  assertSchema(isObject(current), `reference ${reference} does not resolve to a schema object`);
  return current;
}

function instanceChildPath(parent, property) {
  return /^[A-Za-z_$][\w$]*$/u.test(property)
    ? `${parent}.${property}`
    : `${parent}[${JSON.stringify(property)}]`;
}

function valueMatchesType(value, expectedType) {
  if (expectedType === 'null') {
    return value === null;
  }
  if (expectedType === 'array') {
    return Array.isArray(value);
  }
  if (expectedType === 'object') {
    return isObject(value);
  }
  if (expectedType === 'integer') {
    return Number.isInteger(value);
  }
  if (expectedType === 'number') {
    return typeof value === 'number' && Number.isFinite(value);
  }
  return typeof value === expectedType;
}

function validateNode(rootSchema, schemaNode, value, instancePath, state, depth) {
  state.steps += 1;
  if (state.steps > MAXIMUM_VALIDATION_STEPS || depth > MAXIMUM_VALIDATION_DEPTH) {
    throw new Error('Committed JSON Schema validation exceeded its safety limit.');
  }
  const fail = (message) => {
    throw new JsonSchemaValidationError(`${instancePath}: ${message}`);
  };

  if (schemaNode.$ref !== undefined) {
    validateNode(
      rootSchema,
      resolveLocalReference(rootSchema, schemaNode.$ref),
      value,
      instancePath,
      state,
      depth + 1,
    );
  }
  if (schemaNode.oneOf !== undefined) {
    let matches = 0;
    for (const variant of schemaNode.oneOf) {
      try {
        validateNode(rootSchema, variant, value, instancePath, state, depth + 1);
        matches += 1;
      } catch (error) {
        if (!(error instanceof JsonSchemaValidationError)) {
          throw error;
        }
      }
    }
    if (matches !== 1) {
      fail(`must match exactly one oneOf branch; matched ${String(matches)}`);
    }
  }
  if (schemaNode.const !== undefined && !isDeepStrictEqual(value, schemaNode.const)) {
    fail(`must equal ${JSON.stringify(schemaNode.const)}`);
  }
  if (
    schemaNode.enum !== undefined &&
    !schemaNode.enum.some((candidate) => isDeepStrictEqual(value, candidate))
  ) {
    fail('does not match an allowed enum value');
  }
  if (schemaNode.type !== undefined) {
    const expectedTypes = Array.isArray(schemaNode.type) ? schemaNode.type : [schemaNode.type];
    if (!expectedTypes.some((expectedType) => valueMatchesType(value, expectedType))) {
      fail(`must have type ${expectedTypes.join(' or ')}`);
    }
  }

  if (typeof value === 'string') {
    if (schemaNode.minLength !== undefined && [...value].length < schemaNode.minLength) {
      fail(`must contain at least ${String(schemaNode.minLength)} characters`);
    }
    if (schemaNode.pattern !== undefined && !new RegExp(schemaNode.pattern, 'u').test(value)) {
      fail(`must match pattern ${schemaNode.pattern}`);
    }
  }
  if (Array.isArray(value)) {
    if (schemaNode.minItems !== undefined && value.length < schemaNode.minItems) {
      fail(`must contain at least ${String(schemaNode.minItems)} items`);
    }
    if (schemaNode.uniqueItems === true) {
      for (let left = 0; left < value.length; left += 1) {
        for (let right = left + 1; right < value.length; right += 1) {
          if (isDeepStrictEqual(value[left], value[right])) {
            fail(`contains duplicate items at indexes ${String(left)} and ${String(right)}`);
          }
        }
      }
    }
    if (schemaNode.items !== undefined) {
      value.forEach((item, index) =>
        validateNode(
          rootSchema,
          schemaNode.items,
          item,
          `${instancePath}[${String(index)}]`,
          state,
          depth + 1,
        ),
      );
    }
  }
  if (isObject(value)) {
    const keys = Object.keys(value);
    if (schemaNode.minProperties !== undefined && keys.length < schemaNode.minProperties) {
      fail(`must contain at least ${String(schemaNode.minProperties)} properties`);
    }
    for (const property of schemaNode.required ?? []) {
      if (!Object.hasOwn(value, property)) {
        fail(`is missing required property ${property}`);
      }
    }
    for (const property of keys) {
      const properties = schemaNode.properties;
      const childSchema =
        isObject(properties) && Object.hasOwn(properties, property)
          ? properties[property]
          : undefined;
      if (childSchema !== undefined) {
        validateNode(
          rootSchema,
          childSchema,
          value[property],
          instanceChildPath(instancePath, property),
          state,
          depth + 1,
        );
        continue;
      }
      if (schemaNode.additionalProperties === false) {
        fail(`contains disallowed additional property ${property}`);
      }
      if (isObject(schemaNode.additionalProperties)) {
        validateNode(
          rootSchema,
          schemaNode.additionalProperties,
          value[property],
          instanceChildPath(instancePath, property),
          state,
          depth + 1,
        );
      }
    }
  }
}

export function validateJsonSchema(schema, value, options = {}) {
  assertSupportedSchema(schema);
  validateNode(schema, schema, value, options.instancePath ?? '$', { steps: 0 }, 0);
}

function expectSchemaRefusal(schema, mutatedRegister, probeName) {
  try {
    validateJsonSchema(schema, mutatedRegister);
  } catch (error) {
    if (error instanceof JsonSchemaValidationError) {
      return;
    }
    throw error;
  }
  throw new Error(`Dependency register schema negative probe was accepted: ${probeName}`);
}

export function assertDependencyRegisterSchemaRefusals(schema, register) {
  const probes = [
    {
      mutate(candidate) {
        candidate.unregisteredTopLevelProperty = true;
      },
      name: 'unknown top-level property',
    },
    {
      mutate(candidate) {
        candidate.constructor = true;
      },
      name: 'inherited constructor property',
    },
    {
      mutate(candidate) {
        candidate.toString = true;
      },
      name: 'inherited toString property',
    },
    {
      mutate(candidate) {
        Object.defineProperty(candidate, '__proto__', {
          configurable: true,
          enumerable: true,
          value: true,
          writable: true,
        });
      },
      name: 'inherited __proto__ property',
    },
    {
      mutate(candidate) {
        candidate.dependencies[0].unregisteredDependencyProperty = true;
      },
      name: 'unknown dependency property',
    },
    {
      mutate(candidate) {
        candidate.dependencies[0].review.license.unregisteredReviewProperty = true;
      },
      name: 'unknown nested review property',
    },
    {
      mutate(candidate) {
        candidate.dependencies[0].review.maintenance.evidence = 42;
      },
      name: 'malformed nested review evidence',
    },
    {
      mutate(candidate) {
        candidate.managedArtifacts[0].components[0].revision = 'not-a-revision';
      },
      name: 'malformed managed component revision',
    },
    {
      mutate(candidate) {
        candidate.managedArtifacts[0].components[0].unregisteredComponentProperty = true;
      },
      name: 'unknown managed component property',
    },
    {
      mutate(candidate) {
        candidate.nativeTools[0].provenance.unregisteredProvenanceProperty = true;
      },
      name: 'unknown native provenance property',
    },
    {
      mutate(candidate) {
        const sourceBuiltTool = candidate.nativeTools.find(
          (tool) => tool.provenance.kind === 'source-built-native',
        );
        sourceBuiltTool.provenance.sourceSha256 = 'not-a-sha256';
      },
      name: 'malformed source-built native provenance digest',
    },
  ];
  for (const probe of probes) {
    const candidate = structuredClone(register);
    probe.mutate(candidate);
    expectSchemaRefusal(schema, candidate, probe.name);
  }
  return { refusedProbeCount: probes.length };
}
