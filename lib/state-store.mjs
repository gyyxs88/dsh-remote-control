import { mkdir, readFile, rename, writeFile, open as openFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DshRemoteError } from './errors.mjs';

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

export function createInitialHostState({ hostId = `host-${randomUUID()}`, incarnationId = randomUUID(), dshVersion = '0.1.0-rc.6' } = {}) {
  return {
    schemaVersion: 1,
    host: { hostId, incarnationId, dshVersion },
    revision: 0,
    projects: {},
    operations: {},
    gateway: null,
  };
}

export class JsonStateStore {
  constructor(filePath, state) {
    this.filePath = filePath;
    this.state = state;
    this.queue = Promise.resolve();
  }

  static async open({ dataDir, fileName = 'host-state.json', initialState } = {}) {
    if (!dataDir) throw new DshRemoteError('state dataDir is required', { code: 'STATE_CONFIG_ERROR' });
    await mkdir(dataDir, { recursive: true });
    const filePath = join(dataDir, fileName);
    let state;
    try {
      state = JSON.parse(await readFile(filePath, 'utf8'));
      validateState(state);
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        if (error instanceof SyntaxError || error?.code === 'STATE_INVALID') {
          throw new DshRemoteError('durable host state is invalid; refusing to start', { code: 'STATE_INVALID', details: { filePath } });
        }
        throw error;
      }
      state = clone(initialState ?? createInitialHostState());
      await atomicWrite(filePath, state);
    }
    return new JsonStateStore(filePath, state);
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
  if (!state || state.schemaVersion !== 1 || !state.host?.hostId || !state.host?.incarnationId || !Number.isInteger(state.revision) || state.revision < 0) {
    const error = new Error('invalid host state');
    error.code = 'STATE_INVALID';
    throw error;
  }
  if (!state.projects || !state.operations || typeof state.projects !== 'object' || typeof state.operations !== 'object') {
    const error = new Error('invalid host state maps');
    error.code = 'STATE_INVALID';
    throw error;
  }
}

async function atomicWrite(filePath, value) {
  await mkdir(dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await openFile(tempPath, 'w', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tempPath, filePath);
}
