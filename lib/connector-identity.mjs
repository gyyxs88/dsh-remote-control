import { randomUUID } from 'node:crypto';
import { mkdir, open, lstat, readFile, chmod } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const SCHEMA_VERSION = '1.0';
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

function identityError(message, details) {
  const error = new Error(message);
  error.code = 'CONNECTOR_IDENTITY_INVALID';
  if (details !== undefined) error.details = details;
  return error;
}

function validatePath(filePath) {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath) || /[\0\r\n]/u.test(filePath)) {
    throw identityError('connector identity file must be an absolute path');
  }
  return path.normalize(filePath);
}

function validateIdentity(value) {
  if (!value || value.schemaVersion !== SCHEMA_VERSION || !ID.test(value.sourceHostId ?? '') || !ID.test(value.sourceSessionId ?? '')) {
    throw identityError('connector identity schema or source identities are invalid');
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    sourceHostId: value.sourceHostId,
    sourceSessionId: value.sourceSessionId,
    createdAt: typeof value.createdAt === 'string' && Number.isFinite(Date.parse(value.createdAt))
      ? value.createdAt
      : undefined,
  };
}

async function assertSafeFile(filePath) {
  const info = await lstat(filePath);
  if (!info.isFile()) throw identityError('connector identity must be a regular file');
  if (process.platform !== 'win32') {
    if ((info.mode & 0o077) !== 0) throw identityError('connector identity file permissions are too broad');
    if (typeof process.getuid === 'function' && info.uid !== process.getuid()) throw identityError('connector identity file owner is invalid');
  }
  return info;
}

async function readIdentity(filePath) {
  await assertSafeFile(filePath);
  let parsed;
  try { parsed = JSON.parse(await readFile(filePath, 'utf8')); } catch (error) {
    throw identityError('connector identity file is invalid JSON', { message: error.message });
  }
  return validateIdentity(parsed);
}

export async function loadOrCreateConnectorIdentity(filePath = path.join(os.homedir(), '.dsh-remote', 'connector-identity.json')) {
  const target = validatePath(filePath);
  const parent = path.dirname(target);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  let parentInfo = await lstat(parent);
  if (!parentInfo.isDirectory()) throw identityError('connector identity parent must be a directory');
  if (process.platform !== 'win32') {
    await chmod(parent, 0o700);
    parentInfo = await lstat(parent);
    if ((parentInfo.mode & 0o077) !== 0) throw identityError('connector identity parent permissions are too broad');
    if (typeof process.getuid === 'function' && parentInfo.uid !== process.getuid()) throw identityError('connector identity parent owner is invalid');
  }
  try {
    return await readIdentity(target);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const identity = {
    schemaVersion: SCHEMA_VERSION,
    sourceHostId: `local-${randomUUID()}`,
    sourceSessionId: `controller-${randomUUID()}`,
    createdAt: new Date().toISOString(),
  };
  const serialized = `${JSON.stringify(identity, null, 2)}\n`;
  try {
    const handle = await open(target, 'wx', 0o600);
    try {
      await handle.writeFile(serialized, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await chmod(target, 0o600);
    return validateIdentity(identity);
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    return readIdentity(target);
  }
}

export function createRemoteProjectSourceRegistration(identity, { controllerSessionId } = {}) {
  const normalized = validateIdentity(identity);
  if (!ID.test(controllerSessionId ?? '')) throw identityError('controller Session identity is invalid');
  return {
    sourceHostId: normalized.sourceHostId,
    sourceSessionId: normalized.sourceSessionId,
    controllerSessionId,
  };
}
