import { mkdir, readFile, rename, unlink, open as openFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DshRemoteError } from './errors.mjs';

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

export function createInitialHostState({ hostId = `host-${randomUUID()}`, incarnationId = randomUUID(), dshVersion = '0.1.1-rc.2' } = {}) {
  return {
    schemaVersion: 1,
    host: { hostId, incarnationId, dshVersion },
    revision: 0,
    projects: {},
    operations: {},
    authReservations: {},
    gateway: null,
  };
}

export class JsonStateStore {
  constructor(filePath, state, lockHandle, lockPath) {
    this.filePath = filePath;
    this.state = state;
    this.lockHandle = lockHandle;
    this.lockPath = lockPath;
    this.queue = Promise.resolve();
  }

  static async open({ dataDir, fileName = 'host-state.json', initialState } = {}) {
    if (!dataDir) throw new DshRemoteError('state dataDir is required', { code: 'STATE_CONFIG_ERROR' });
    await mkdir(dataDir, { recursive: true });
    const filePath = join(dataDir, fileName);
    const lockPath = `${filePath}.lock`;
    const lockHandle = await acquireLock(lockPath);
    let state;
    try {
      state = JSON.parse(await readFile(filePath, 'utf8'));
      validateState(state);
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        if (error instanceof SyntaxError || error?.code === 'STATE_INVALID') {
          await releaseLock(lockHandle, lockPath);
          throw new DshRemoteError('durable host state is invalid; refusing to start', { code: 'STATE_INVALID', details: { filePath } });
        }
        await releaseLock(lockHandle, lockPath);
        throw error;
      }
      state = clone(initialState ?? createInitialHostState());
      try {
        await atomicWrite(filePath, state);
      } catch (writeError) {
        await releaseLock(lockHandle, lockPath);
        throw writeError;
      }
    }
    return new JsonStateStore(filePath, state, lockHandle, lockPath);
  }

  snapshot() {
    return clone(this.state);
  }

  async update(mutator) {
    const run = this.queue.then(async () => {
      const next = clone(this.state);
      const result = await mutator(next);
      validateState(next);
      await atomicWrite(this.filePath, next);
      this.state = next;
      return clone(result);
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  async close() {
    await releaseLock(this.lockHandle, this.lockPath);
    this.lockHandle = null;
  }
}

export class MemoryStateStore {
  constructor(state = createInitialHostState()) {
    validateState(state);
    this.state = clone(state);
    this.queue = Promise.resolve();
  }

  snapshot() {
    return clone(this.state);
  }

  async update(mutator) {
    const run = this.queue.then(async () => {
      const next = clone(this.state);
      const result = await mutator(next);
      validateState(next);
      this.state = next;
      return clone(result);
    });
    this.queue = run.catch(() => undefined);
    return run;
  }
}

export function validateState(state) {
  if (!state || state.schemaVersion !== 1 || typeof state.host?.hostId !== 'string' || state.host.hostId.length === 0 || typeof state.host?.incarnationId !== 'string' || state.host.incarnationId.length === 0 || !Number.isSafeInteger(state.revision) || state.revision < 0) {
    const error = new Error('invalid host state');
    error.code = 'STATE_INVALID';
    throw error;
  }
  if (!state.projects || !state.operations || typeof state.projects !== 'object' || typeof state.operations !== 'object' || Array.isArray(state.projects) || Array.isArray(state.operations) || (state.authReservations !== undefined && (typeof state.authReservations !== 'object' || Array.isArray(state.authReservations)))) {
    const error = new Error('invalid host state maps');
    error.code = 'STATE_INVALID';
    throw error;
  }
  for (const [reservationId, reservation] of Object.entries(state.authReservations ?? {})) {
    if (!reservation || typeof reservation !== 'object' || reservation.reservationId !== reservationId || !/^[A-Za-z0-9_-]{16,128}$/u.test(reservationId) || !['reserved', 'committed', 'consumed'].includes(reservation.status) || typeof reservation.runtimeId !== 'string' || typeof reservation.version !== 'string' || !/^[a-f0-9]{64}$/u.test(reservation.sha256 ?? '') || typeof reservation.sourceHostId !== 'string' || typeof reservation.sourceSessionId !== 'string' || typeof reservation.operationId !== 'string' || typeof reservation.idempotencyKey !== 'string' || typeof reservation.bodySha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(reservation.bodySha256) || typeof reservation.nonce !== 'string' || typeof reservation.issuedAt !== 'string' || typeof reservation.expiresAt !== 'string' || typeof reservation.sessionControlAttempted !== 'boolean') {
      const error = new Error('invalid host auth reservation state');
      error.code = 'STATE_INVALID';
      throw error;
    }
    if (reservation.targetSessionId !== null && reservation.targetSessionId !== undefined && typeof reservation.targetSessionId !== 'string') {
      const error = new Error('invalid host auth reservation target');
      error.code = 'STATE_INVALID';
      throw error;
    }
  }
  const operationStates = new Set(['pending', 'running', 'completed', 'partial', 'failed', 'needs-attention']);
  for (const [operationId, operation] of Object.entries(state.operations)) {
    if (!operation || typeof operation !== 'object' || operation.operationId !== operationId || !operation.idempotencyKey || !operation.sourceHostId || !operation.sourceSessionId || !operation.targetHostId || !operation.type || !operationStates.has(operation.state) || !Number.isSafeInteger(operation.revision) || operation.revision < 0) {
      const error = new Error('invalid host operation state');
      error.code = 'STATE_INVALID';
      throw error;
    }
  }
  if (state.gateway !== null && state.gateway !== undefined && (typeof state.gateway !== 'object' || !/^http:\/\/127\.0\.0\.1:\d+$/.test(state.gateway.endpoint ?? '') || !/^[a-f0-9]{64}$/.test(state.gateway.tokenSha256 ?? '') || !state.gateway.hostId)) {
    const error = new Error('invalid host gateway state');
    error.code = 'STATE_INVALID';
    throw error;
  }
}

async function atomicWrite(filePath, value) {
  await mkdir(dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  let renamed = false;
  try {
    const handle = await openFile(tempPath, 'w', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tempPath, filePath);
    renamed = true;
    try {
      const directory = await openFile(dirname(filePath), 'r');
      try { await directory.sync(); } finally { await directory.close(); }
    } catch (error) {
      if (!['EINVAL', 'ENOTSUP', 'EPERM'].includes(error?.code)) throw error;
    }
  } finally {
    if (!renamed) await unlink(tempPath).catch(() => {});
  }
}

async function acquireLock(lockPath) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await openFile(lockPath, 'wx', 0o600);
      await handle.writeFile(`${process.pid}\n`, 'utf8');
      await handle.sync();
      return handle;
    } catch (error) {
      if (error?.code !== 'EEXIST' || attempt > 0) throw new DshRemoteError('another Remote Host process owns the state store', { code: 'STATE_LOCKED', details: { lockPath } });
      let pid = null;
      try { pid = Number((await readFile(lockPath, 'utf8')).trim()); } catch { pid = null; }
      if (Number.isInteger(pid) && pid > 0) {
        try { process.kill(pid, 0); throw new DshRemoteError('another Remote Host process owns the state store', { code: 'STATE_LOCKED', details: { lockPath, pid } }); } catch (probeError) {
          if (probeError instanceof DshRemoteError) throw probeError;
        }
      }
      await unlink(lockPath).catch(() => { throw new DshRemoteError('stale state lock could not be removed', { code: 'STATE_LOCKED', details: { lockPath } }); });
    }
  }
  throw new DshRemoteError('state lock acquisition failed', { code: 'STATE_LOCKED' });
}

async function releaseLock(handle, lockPath) {
  if (!handle) return;
  await handle.close().catch(() => {});
  await unlink(lockPath).catch(() => {});
}
