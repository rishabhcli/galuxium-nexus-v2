import fs from 'node:fs/promises';

import { EXPECTED_PORTS, PORT_BLOCK, PORTS_ENV_PATH, SERVICE_DEFINITIONS } from './constants.mjs';
import { DevContractError } from './errors.mjs';

const PORT_LINE = /^([A-Z][A-Z0-9_]*)=(\d+)(?:\s+#.*)?$/;

export async function readPortConfiguration() {
  const source = await fs.readFile(PORTS_ENV_PATH, 'utf8');
  const parsed = {};

  for (const [index, rawLine] of source.split(/\r?\n/u).entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }
    const match = PORT_LINE.exec(line);
    if (!match) {
      throw new DevContractError(
        'DEV_PORT_CONFIG_INVALID',
        `Invalid ports.env syntax on line ${index + 1}; the file is parsed as data and is never sourced as shell code.`,
      );
    }
    const [, key, rawPort] = match;
    if (Object.hasOwn(parsed, key)) {
      throw new DevContractError(
        'DEV_PORT_CONFIG_DUPLICATE',
        `Duplicate port key in ports.env: ${key}`,
      );
    }
    parsed[key] = Number.parseInt(rawPort, 10);
  }

  const expectedKeys = Object.keys(EXPECTED_PORTS).sort();
  const actualKeys = Object.keys(parsed).sort();
  if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) {
    throw new DevContractError(
      'DEV_PORT_CONFIG_KEYS',
      'ports.env must contain exactly the allocated §0A keys.',
      { actualKeys, expectedKeys },
    );
  }

  const seenPorts = new Set();
  for (const key of expectedKeys) {
    const value = parsed[key];
    if (value !== EXPECTED_PORTS[key]) {
      throw new DevContractError(
        'DEV_PORT_CONFIG_DRIFT',
        `${key} must be ${EXPECTED_PORTS[key]}, received ${value}.`,
      );
    }
    if (!PORT_BLOCK.includes(value) || seenPorts.has(value)) {
      throw new DevContractError(
        'DEV_PORT_CONFIG_RANGE',
        `Port ${value} is outside the exclusive block or duplicated.`,
      );
    }
    seenPorts.add(value);
  }

  for (const service of SERVICE_DEFINITIONS) {
    if (!seenPorts.has(service.port)) {
      throw new DevContractError(
        'DEV_SERVICE_PORT_UNDECLARED',
        `Service ${service.name} uses undeclared port ${service.port}.`,
      );
    }
  }

  return Object.freeze(parsed);
}
