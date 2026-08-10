import crypto from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

import {
  DEV_PATHS,
  metadataPath,
  pidPath,
  REPOSITORY_NAME,
  REPOSITORY_ROOT,
  SERVICE_BY_NAME,
} from './constants.mjs';
import { execute, findExecutable } from './command.mjs';
import { DevContractError } from './errors.mjs';
import { atomicWrite } from './filesystem.mjs';

const RECORD_SCHEMA_VERSION = 2;
const START_TIME_TOLERANCE_MS = 0;
const BIRTH_IDENTITY_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const KERNEL_IDENTITY_PATTERN = /^(?:linux:[0-9a-f-]{36}:[0-9]+)$/u;
const BIRTH_IDENTITY_ARGUMENT_PREFIX = '--dev-birth-identity=';
const LOCK_PATH = path.join(DEV_PATHS.pids, 'orchestrator.lock');
const LOCK_RETRY_LIMIT = 12;

function parsePositiveInteger(value) {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function escapeRegularExpression(value) {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

export function createProcessBirthIdentity() {
  return crypto.randomUUID();
}

export function processBirthIdentityArgument(birthIdentity) {
  if (!BIRTH_IDENTITY_PATTERN.test(birthIdentity)) {
    throw new DevContractError(
      'DEV_PROCESS_BIRTH_IDENTITY_INVALID',
      'Process birth identity must be a random UUID.',
    );
  }
  return `${BIRTH_IDENTITY_ARGUMENT_PREFIX}${birthIdentity}`;
}

function commandHasBirthIdentity(command, birthIdentity) {
  const argument = processBirthIdentityArgument(birthIdentity);
  return new RegExp(`(?:^|\\s)${escapeRegularExpression(argument)}(?:\\s|$)`, 'u').test(command);
}

async function psField(pid, field) {
  const ps = await findExecutable('ps');
  const result = await execute(ps, ['-p', String(pid), '-o', `${field}=`], {
    allowExitCodes: [0, 1],
  });
  if (result.exitCode === 1 || !result.stdout.trim()) {
    return undefined;
  }
  return result.stdout.trim();
}

async function linuxKernelBirthIdentity(pid) {
  if (process.platform !== 'linux') {
    return undefined;
  }
  try {
    const [bootId, stat] = await Promise.all([
      fs.readFile('/proc/sys/kernel/random/boot_id', 'utf8'),
      fs.readFile(`/proc/${String(pid)}/stat`, 'utf8'),
    ]);
    const closeParenthesis = stat.lastIndexOf(')');
    if (closeParenthesis < 1) {
      throw new Error('missing process-name terminator');
    }
    // `/proc/<pid>/stat` field 22 is the process start tick. The slice starts
    // at field 3, so field 22 is index 19. Pairing it with the kernel boot UUID
    // makes the value exact across PID reuse and host reboots.
    const fields = stat
      .slice(closeParenthesis + 2)
      .trim()
      .split(/\s+/u);
    const startTicks = fields[19];
    const normalizedBootId = bootId.trim().toLowerCase();
    if (!/^[0-9a-f-]{36}$/u.test(normalizedBootId) || !/^[0-9]+$/u.test(startTicks ?? '')) {
      throw new Error('invalid boot UUID or start tick');
    }
    return `linux:${normalizedBootId}:${startTicks}`;
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ESRCH') {
      return undefined;
    }
    throw new DevContractError(
      'DEV_PROCESS_KERNEL_IDENTITY_FAILED',
      `Could not read the kernel process birth identity for PID ${String(pid)}.`,
      undefined,
      { cause: error },
    );
  }
}

export async function inspectProcess(pid) {
  if (!parsePositiveInteger(pid)) {
    return undefined;
  }
  const kernelIdentityBefore = await linuxKernelBirthIdentity(pid);
  const ps = await findExecutable('ps');
  const identityResult = await execute(
    ps,
    ['-p', String(pid), '-o', 'pid=', '-o', 'ppid=', '-o', 'pgid='],
    { allowExitCodes: [0, 1] },
  );
  const identity = identityResult.stdout.trim();
  if (identityResult.exitCode === 1 || !identity) {
    return undefined;
  }
  const [actualPid, parentPid, processGroupId] = identity.split(/\s+/u).map(parsePositiveInteger);
  if (!actualPid || !parentPid || !processGroupId) {
    throw new DevContractError(
      'DEV_PROCESS_INSPECTION_FAILED',
      `Could not parse process identity for PID ${String(pid)}.`,
      { identity },
    );
  }
  const [command, rawStartTime, kernelIdentityAfter] = await Promise.all([
    psField(pid, 'command'),
    psField(pid, 'lstart'),
    linuxKernelBirthIdentity(pid),
  ]);
  if (!command || !rawStartTime) {
    return undefined;
  }
  if (kernelIdentityBefore !== kernelIdentityAfter) {
    return undefined;
  }
  const startedAtEpochMs = Date.parse(rawStartTime);
  if (!Number.isFinite(startedAtEpochMs)) {
    throw new DevContractError(
      'DEV_PROCESS_START_TIME_INVALID',
      `Could not parse process start time for PID ${String(pid)}.`,
      { rawStartTime },
    );
  }
  return {
    command,
    kernelBirthIdentity: kernelIdentityAfter,
    parentPid,
    pid: actualPid,
    processGroupId,
    rawStartTime,
    startedAtEpochMs,
  };
}

function validateRecord(value, expectedService) {
  const service = SERVICE_BY_NAME.get(expectedService);
  if (
    !service ||
    value?.schemaVersion !== RECORD_SCHEMA_VERSION ||
    value?.repository !== REPOSITORY_NAME ||
    value?.repositoryRoot !== REPOSITORY_ROOT ||
    value?.service !== expectedService ||
    value?.kind !== service.kind ||
    !parsePositiveInteger(value?.pid) ||
    !parsePositiveInteger(value?.processGroupId) ||
    !Number.isFinite(value?.startedAtEpochMs) ||
    !BIRTH_IDENTITY_PATTERN.test(value?.birthIdentity ?? '') ||
    !(
      value?.kernelBirthIdentity === null ||
      KERNEL_IDENTITY_PATTERN.test(value?.kernelBirthIdentity ?? '')
    ) ||
    value?.supervised !== true ||
    typeof value?.supervisorConfigPath !== 'string' ||
    path.dirname(value.supervisorConfigPath) !== DEV_PATHS.tmp ||
    !path.basename(value.supervisorConfigPath).startsWith(`supervisor.${expectedService}.`) ||
    typeof value?.targetExecutable !== 'string' ||
    !path.isAbsolute(value.targetExecutable) ||
    !Array.isArray(value?.targetArgvNeedles) ||
    value.targetArgvNeedles.length === 0 ||
    value.targetArgvNeedles.some((needle) => typeof needle !== 'string' || needle.length === 0) ||
    typeof value?.runId !== 'string' ||
    !/^[0-9a-f-]{36}$/u.test(value.runId) ||
    !Array.isArray(value?.argvNeedles) ||
    value.argvNeedles.length === 0 ||
    value.argvNeedles.some((needle) => typeof needle !== 'string' || needle.length === 0) ||
    !Array.isArray(value?.expectedPorts) ||
    value.expectedPorts.length !== 1 ||
    value.expectedPorts.some((port) => port !== service.port)
  ) {
    throw new DevContractError(
      'DEV_OWNERSHIP_RECORD_INVALID',
      `Invalid ownership metadata for ${expectedService}. Refusing to trust or signal the recorded PID.`,
    );
  }
  return value;
}

export async function readOwnershipRecord(serviceName) {
  let rawPid;
  let rawMetadata;
  try {
    [rawPid, rawMetadata] = await Promise.all([
      fs.readFile(pidPath(serviceName), 'utf8'),
      fs.readFile(metadataPath(serviceName), 'utf8'),
    ]);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      const existing = await Promise.allSettled([
        fs.lstat(pidPath(serviceName)),
        fs.lstat(metadataPath(serviceName)),
      ]);
      if (existing.some((result) => result.status === 'fulfilled')) {
        throw new DevContractError(
          'DEV_OWNERSHIP_RECORD_PARTIAL',
          `Only part of the ownership record exists for ${serviceName}; refusing unsafe recovery.`,
        );
      }
      return undefined;
    }
    throw error;
  }

  const pid = parsePositiveInteger(rawPid.trim());
  let metadata;
  try {
    metadata = JSON.parse(rawMetadata);
  } catch (error) {
    throw new DevContractError(
      'DEV_OWNERSHIP_RECORD_JSON',
      `Ownership metadata is not valid JSON for ${serviceName}.`,
      undefined,
      { cause: error },
    );
  }
  const record = validateRecord(metadata, serviceName);
  if (record.pid !== pid) {
    throw new DevContractError(
      'DEV_OWNERSHIP_PID_MISMATCH',
      `PID and metadata disagree for ${serviceName}; refusing to trust either file.`,
    );
  }
  return record;
}

export async function verifyOwnership(record) {
  const inspected = await inspectProcess(record.pid);
  if (!inspected) {
    return { owned: false, reason: 'not-running' };
  }
  if (inspected.processGroupId !== record.processGroupId) {
    return { inspected, owned: false, reason: 'process-group-changed' };
  }
  if (Math.abs(inspected.startedAtEpochMs - record.startedAtEpochMs) > START_TIME_TOLERANCE_MS) {
    return { inspected, owned: false, reason: 'pid-reused' };
  }
  if (
    record.kernelBirthIdentity !== null &&
    inspected.kernelBirthIdentity !== record.kernelBirthIdentity
  ) {
    return { inspected, owned: false, reason: 'kernel-birth-identity-changed' };
  }
  if (!commandHasBirthIdentity(inspected.command, record.birthIdentity)) {
    return { inspected, owned: false, reason: 'birth-identity-changed' };
  }
  if (!record.argvNeedles.every((needle) => inspected.command.includes(needle))) {
    return { inspected, owned: false, reason: 'command-changed' };
  }
  return { inspected, owned: true };
}

export async function writeOwnershipRecord({
  argvNeedles,
  birthIdentity,
  kernelBirthIdentity,
  pid,
  processGroupId,
  runId,
  service,
  startedAtEpochMs,
  supervisorConfigPath,
  targetArgvNeedles,
  targetExecutable,
}) {
  const definition = SERVICE_BY_NAME.get(service);
  if (!definition) {
    throw new DevContractError(
      'DEV_UNKNOWN_SERVICE',
      `Cannot write ownership metadata for unknown service: ${service}`,
    );
  }
  const record = validateRecord(
    {
      argvNeedles,
      birthIdentity,
      expectedPorts: [definition.port],
      kernelBirthIdentity: kernelBirthIdentity ?? null,
      kind: definition.kind,
      pid,
      processGroupId,
      repository: REPOSITORY_NAME,
      repositoryRoot: REPOSITORY_ROOT,
      runId,
      schemaVersion: RECORD_SCHEMA_VERSION,
      service,
      startedAtEpochMs,
      supervised: true,
      supervisorConfigPath,
      targetArgvNeedles,
      targetExecutable,
    },
    service,
  );
  // Metadata contains the complete failure-attribution record, so publish it
  // before the redundant PID file. A failed second write is intentionally left
  // partial until an exact-owned cleanup proves process exit.
  await atomicWrite(metadataPath(service), `${JSON.stringify(record, null, 2)}\n`);
  await atomicWrite(pidPath(service), `${String(pid)}\n`);
  return record;
}

export async function removeOwnershipRecord(serviceName, { supervisorConfigPath } = {}) {
  const targets = [
    fs.rm(pidPath(serviceName), { force: true }),
    fs.rm(metadataPath(serviceName), { force: true }),
  ];
  if (supervisorConfigPath !== undefined) {
    if (
      typeof supervisorConfigPath !== 'string' ||
      path.dirname(supervisorConfigPath) !== DEV_PATHS.tmp ||
      !path.basename(supervisorConfigPath).startsWith(`supervisor.${serviceName}.`)
    ) {
      throw new DevContractError(
        'DEV_SUPERVISOR_CONFIG_PATH_INVALID',
        `Refusing to remove an invalid supervisor config path for ${serviceName}.`,
      );
    }
    targets.push(fs.rm(supervisorConfigPath, { force: true }));
  }
  await Promise.all(targets);
}

export async function loadVerifiedOwnershipRecords({ removeStale = false } = {}) {
  const records = new Map();
  for (const serviceName of SERVICE_BY_NAME.keys()) {
    const record = await readOwnershipRecord(serviceName);
    if (!record) {
      continue;
    }
    const verification = await verifyOwnership(record);
    if (!verification.owned) {
      if (removeStale && verification.reason === 'not-running') {
        await removeOwnershipRecord(serviceName, {
          supervisorConfigPath: record.supervisorConfigPath,
        });
        continue;
      }
      throw new DevContractError(
        'DEV_OWNERSHIP_MISMATCH',
        `Recorded PID ${String(record.pid)} for ${serviceName} is not the process that dev:up started. No signal was sent.`,
        { reason: verification.reason },
      );
    }
    records.set(serviceName, record);
  }
  return records;
}

export async function listenerBelongsToRecord(listenerPid, record) {
  const leaderVerification = await verifyOwnership(record);
  if (!leaderVerification.owned) {
    return false;
  }
  if (listenerPid === record.pid) {
    return true;
  }
  const inspected = await inspectProcess(listenerPid);
  return inspected?.processGroupId === record.processGroupId;
}

async function readLockSnapshot(targetPath) {
  let handle;
  try {
    handle = await fs.open(targetPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.nlink < 1 || (metadata.mode & 0o077) !== 0) {
      throw new DevContractError(
        'DEV_ORCHESTRATOR_LOCK_INVALID',
        `The orchestrator lock is not a private regular file: ${targetPath}`,
      );
    }
    let value;
    try {
      value = JSON.parse(await handle.readFile('utf8'));
    } catch (error) {
      throw new DevContractError(
        'DEV_ORCHESTRATOR_LOCK_INVALID',
        `The orchestrator lock is malformed: ${targetPath}`,
        undefined,
        { cause: error },
      );
    }
    if (
      !BIRTH_IDENTITY_PATTERN.test(value?.token ?? '') ||
      !parsePositiveInteger(value?.pid) ||
      value?.repository !== REPOSITORY_NAME ||
      !Number.isFinite(value?.startedAtEpochMs) ||
      !(
        value?.kernelBirthIdentity === null ||
        KERNEL_IDENTITY_PATTERN.test(value?.kernelBirthIdentity ?? '')
      )
    ) {
      throw new DevContractError(
        'DEV_ORCHESTRATOR_LOCK_INVALID',
        `The orchestrator lock has invalid ownership fields: ${targetPath}`,
      );
    }
    return { dev: metadata.dev, ino: metadata.ino, value };
  } finally {
    await handle.close();
  }
}

function sameLockInode(left, right) {
  return left?.dev === right?.dev && left?.ino === right?.ino;
}

async function unlinkExactLock(snapshot, lockPath) {
  const markerPath = `${lockPath}.takeover.${snapshot.value.token}`;
  try {
    await fs.link(lockPath, markerPath);
  } catch (error) {
    if (error?.code === 'EEXIST') {
      // Another contender won the exact-inode election. It alone may unlink;
      // reusing its marker would reintroduce the replacement TOCTOU.
      return false;
    }
    if (error?.code === 'ENOENT') {
      return true;
    }
    if (error?.code !== 'EEXIST') {
      throw error;
    }
  }
  const marker = await readLockSnapshot(markerPath);
  if (!marker || !sameLockInode(marker, snapshot) || marker.value.token !== snapshot.value.token) {
    return false;
  }
  const current = await readLockSnapshot(lockPath);
  if (!current) {
    await fs.rm(markerPath, { force: true });
    return true;
  }
  if (!sameLockInode(current, marker) || current.value.token !== snapshot.value.token) {
    await fs.rm(markerPath, { force: true });
    return false;
  }
  try {
    await fs.unlink(lockPath);
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw error;
    }
  }
  await fs.rm(markerPath, { force: true });
  return true;
}

function lockMatchesProcess(lockValue, inspected) {
  if (
    !inspected ||
    inspected.pid !== lockValue.pid ||
    inspected.startedAtEpochMs !== lockValue.startedAtEpochMs
  ) {
    return false;
  }
  return (
    lockValue.kernelBirthIdentity === null ||
    inspected.kernelBirthIdentity === lockValue.kernelBirthIdentity
  );
}

async function lockIsProvablyStale(lockValue, inspectProcessAction, sleepAction) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const inspected = await inspectProcessAction(lockValue.pid);
    if (lockMatchesProcess(lockValue, inspected)) {
      return false;
    }
    // A running process with a different exact birth identity proves PID reuse.
    if (inspected) {
      return true;
    }
    if (attempt < 2) {
      await sleepAction(5);
    }
  }
  return true;
}

export async function acquireOrchestratorLock(
  operation,
  {
    inspectProcessAction = inspectProcess,
    lockPath = LOCK_PATH,
    sleepAction = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    token = createProcessBirthIdentity(),
  } = {},
) {
  processBirthIdentityArgument(token);
  const candidatePath = `${lockPath}.claim.${token}`;
  const inspected = await inspectProcessAction(process.pid);
  if (!inspected) {
    throw new DevContractError(
      'DEV_ORCHESTRATOR_IDENTITY_UNAVAILABLE',
      'Could not obtain the current process identity before claiming the orchestrator lock.',
    );
  }
  const lockValue = {
    kernelBirthIdentity: inspected.kernelBirthIdentity ?? null,
    operation,
    pid: process.pid,
    repository: REPOSITORY_NAME,
    startedAtEpochMs: inspected.startedAtEpochMs,
    token,
  };
  const candidate = await fs.open(
    candidatePath,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
    0o600,
  );
  try {
    await candidate.writeFile(`${JSON.stringify(lockValue)}\n`, 'utf8');
    await candidate.sync();
  } finally {
    await candidate.close();
  }

  try {
    for (let attempt = 0; attempt < LOCK_RETRY_LIMIT; attempt += 1) {
      try {
        // The immutable, fully-written candidate is installed by hard link.
        // link(2) never replaces a winner, so simultaneous contenders cannot
        // both claim the repository lock.
        await fs.link(candidatePath, lockPath);
        let released = false;
        return async () => {
          if (released) {
            return;
          }
          released = true;
          let removed = false;
          try {
            const current = await readLockSnapshot(lockPath);
            if (current?.value.token === token) {
              removed = await unlinkExactLock(current, lockPath);
            }
          } finally {
            if (removed) {
              await fs.rm(candidatePath, { force: true });
            }
          }
          if (!removed) {
            throw new DevContractError(
              'DEV_ORCHESTRATOR_LOCK_RELEASE_UNPROVEN',
              'Could not prove exact-inode orchestrator lock release; claim attribution was retained.',
            );
          }
        };
      } catch (error) {
        if (error?.code !== 'EEXIST') {
          throw error;
        }
      }

      const current = await readLockSnapshot(lockPath);
      if (!current) {
        continue;
      }
      const stale = await lockIsProvablyStale(current.value, inspectProcessAction, sleepAction);
      if (!stale) {
        throw new DevContractError(
          'DEV_ORCHESTRATOR_BUSY',
          `Another ${current.value.operation ?? 'dev'} operation owns the repository lock (PID ${String(current.value.pid)}).`,
        );
      }
      const removed = await unlinkExactLock(current, lockPath);
      if (!removed) {
        await sleepAction(5);
      }
    }
  } catch (error) {
    await fs.rm(candidatePath, { force: true });
    throw error;
  }
  await fs.rm(candidatePath, { force: true });
  throw new DevContractError(
    'DEV_ORCHESTRATOR_LOCK_FAILED',
    'Could not acquire the repository-local dev orchestrator lock after bounded atomic attempts.',
  );
}
