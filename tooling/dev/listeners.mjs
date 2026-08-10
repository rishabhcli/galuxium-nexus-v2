import { HOST, PORT_BLOCK, SERVICE_BY_PORT, SERVICE_DEFINITIONS } from './constants.mjs';
import { execute, findExecutable } from './command.mjs';
import { DevContractError } from './errors.mjs';
import { listenerBelongsToRecord, loadVerifiedOwnershipRecords } from './ownership.mjs';

function parseListenerPort(name) {
  const match = /:(\d+)(?:\s+\(LISTEN\))?$/u.exec(name);
  return match ? Number.parseInt(match[1], 10) : undefined;
}

function parseLsofFields(output) {
  const listeners = [];
  let currentPid;
  let currentCommand = '';
  for (const line of output.split(/\r?\n/u)) {
    if (!line) {
      continue;
    }
    const field = line[0];
    const value = line.slice(1);
    if (field === 'p') {
      currentPid = Number.parseInt(value, 10);
      currentCommand = '';
    } else if (field === 'c') {
      currentCommand = value;
    } else if (field === 'n' && Number.isSafeInteger(currentPid)) {
      const port = parseListenerPort(value);
      if (port !== undefined && PORT_BLOCK.includes(port)) {
        listeners.push({
          command: currentCommand,
          name: value,
          pid: currentPid,
          port,
        });
      }
    }
  }
  return listeners;
}

export async function listBlockListeners() {
  const lsof = await findExecutable('lsof');
  const result = await execute(
    lsof,
    ['-nP', '-a', `-iTCP:${PORT_BLOCK[0]}-${PORT_BLOCK.at(-1)}`, '-sTCP:LISTEN', '-Fpcn'],
    { allowExitCodes: [0, 1], timeout: 10_000 },
  );
  return result.exitCode === 1 ? [] : parseLsofFields(result.stdout);
}

export async function auditBlockListeners({ requireAllAllocated = false } = {}) {
  const [listeners, records] = await Promise.all([
    listBlockListeners(),
    loadVerifiedOwnershipRecords(),
  ]);
  const observedAllocatedPorts = new Set();

  for (const listener of listeners) {
    const service = SERVICE_BY_PORT.get(listener.port);
    if (!service) {
      throw new DevContractError(
        'DEV_RESERVED_PORT_OCCUPIED',
        `Reserved port ${listener.port} is held by PID ${listener.pid} (${listener.command}). No process was killed.`,
        listener,
      );
    }
    const record = records.get(service.name);
    const owned = record ? await listenerBelongsToRecord(listener.pid, record) : false;
    if (!owned) {
      throw new DevContractError(
        'DEV_FOREIGN_PORT_OCCUPIED',
        `Allocated port ${listener.port} is held by foreign PID ${listener.pid} (${listener.command}). No process was killed.`,
        listener,
      );
    }
    if (!listener.name.startsWith(`${HOST}:`)) {
      throw new DevContractError(
        'DEV_NON_LOOPBACK_BIND',
        `${service.name} is not bound exclusively to ${HOST}:${listener.port}.`,
        listener,
      );
    }
    observedAllocatedPorts.add(listener.port);
  }

  if (requireAllAllocated) {
    const missing = SERVICE_DEFINITIONS.filter(
      (service) => !observedAllocatedPorts.has(service.port),
    ).map((service) => ({ port: service.port, service: service.name }));
    if (missing.length > 0) {
      throw new DevContractError(
        'DEV_LISTENER_MISSING',
        'One or more allocated services do not have a verified loopback listener.',
        missing,
      );
    }
  }

  return { listeners, records };
}
