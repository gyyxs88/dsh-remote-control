import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';

import { DshRemoteError } from './errors.mjs';
import { validateSafePosixPath } from './path-safety.mjs';

const HOST_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const SSH_TARGET = /^[A-Za-z0-9_.@:%\[\]-]+$/u;
const FINGERPRINT = /^SHA256:[A-Za-z0-9+/]+$/u;
const PUBLIC_KEY = /^[A-Za-z0-9+/=]+$/u;
const KEY_TYPE = /^(?:ssh-ed25519|ecdsa-sha2-nistp256|ssh-rsa)$/u;
const VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/u;

function invalid(message, details) {
  throw new DshRemoteError(message, { code: 'HOST_REGISTRY_INVALID', details });
}

function clone(value) {
  return structuredClone(value);
}

function validateProfile(input) {
  if (!input || !HOST_ID.test(input.id ?? '') || !SSH_TARGET.test(input.sshTarget ?? '') || !SSH_TARGET.test(input.hostKeyAlias ?? '') || !SSH_TARGET.test(input.hostname ?? '') || typeof input.user !== 'string' || input.user.length === 0 || !Number.isInteger(input.port) || input.port < 1 || input.port > 65535) invalid('remote Host profile identity is invalid');
  if (!FINGERPRINT.test(input.expectedFingerprint ?? '') || !KEY_TYPE.test(input.hostKey?.keyType ?? '') || !PUBLIC_KEY.test(input.hostKey?.publicKey ?? '') || input.hostKey.fingerprint !== input.expectedFingerprint) invalid('remote Host key pin is invalid', { id: input.id });
  if (typeof input.knownHostsFile !== 'string' || !path.isAbsolute(input.knownHostsFile)) invalid('managed known_hosts path must be absolute', { id: input.id });
  if (input.platform !== 'linux' || input.arch !== 'x64' || !Number.isInteger(input.uid) || input.uid <= 0 || !VERSION.test(input.nodeVersion ?? '')) invalid('remote Host platform probe is invalid', { id: input.id });
  for (const [field, value] of [['home', input.home], ['remoteRoot', input.remoteRoot], ['dshHome', input.dshHome], ['allowedRoot', input.allowedRoot], ['controllerWorkspace', input.controllerWorkspace], ['sessionSocket', input.sessionSocket], ['runtimeSocket', input.runtimeSocket], ['runtimeTokenFile', input.runtimeTokenFile]]) {
    validateSafePosixPath(value, { field, allowHome: false });
  }
  if (!input.remoteRoot.startsWith(`${input.home}/`) || !input.dshHome.startsWith(`${input.remoteRoot}/`)) invalid('remote installation paths must stay below the probed home directory', { id: input.id });
  if (!HOST_ID.test(input.hostId ?? '') || !HOST_ID.test(input.profileName ?? '') || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.service$/u.test(input.serviceName ?? '') || !/^session-[A-Za-z0-9-]{8,128}$/u.test(input.controllerSessionId ?? '')) invalid('remote DSH identity is invalid', { id: input.id });
  if (!Number.isInteger(input.dshPort) || input.dshPort < 1024 || input.dshPort > 65535) invalid('remote DSH port is invalid', { id: input.id });
  if (typeof input.createdAt !== 'string' || typeof input.updatedAt !== 'string') invalid('remote Host timestamps are invalid', { id: input.id });
  return clone(input);
}

function validateState(state) {
  if (!state || state.schemaVersion !== '1.0' || !Number.isSafeInteger(state.revision) || state.revision < 0 || !Array.isArray(state.hosts)) invalid('Host registry state is invalid');
  const ids = new Set();
  const aliases = new Set();
  for (const host of state.hosts) {
    validateProfile(host);
    if (ids.has(host.id) || aliases.has(host.sshTarget)) invalid('Host registry contains duplicate identity', { id: host.id, sshTarget: host.sshTarget });
    ids.add(host.id);
    aliases.add(host.sshTarget);
  }
  return state;
}

async function ensurePrivateDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) invalid('Host registry directory must be a real directory', { directory });
  if (process.platform !== 'win32') {
    if ((info.mode & 0o077) !== 0 || (typeof process.getuid === 'function' && info.uid !== process.getuid())) invalid('Host registry directory must be owner-only', { directory });
  }
  await chmod(directory, 0o700).catch((error) => { if (process.platform !== 'win32') throw error; });
}

async function atomicWrite(filePath, value, mode = 0o600) {
  const temp = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  let committed = false;
  try {
    const handle = await open(temp, 'wx', mode);
    try {
      await handle.writeFile(value, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temp, filePath);
    committed = true;
    await chmod(filePath, mode).catch((error) => { if (process.platform !== 'win32') throw error; });
    try {
      const directory = await open(path.dirname(filePath), 'r');
      try { await directory.sync(); } finally { await directory.close(); }
    } catch (error) {
      if (!['EINVAL', 'ENOTSUP', 'EPERM'].includes(error?.code)) throw error;
    }
  } finally {
    if (!committed) await rm(temp, { force: true }).catch(() => {});
  }
}

export class HostRegistry {
  constructor({ stateDir, state, filePath, lockPath, lockHandle } = {}) {
    this.stateDir = stateDir;
    this.filePath = filePath;
    this.knownHostsDir = path.join(stateDir, 'known-hosts');
    this.state = state;
    this.lockPath = lockPath;
    this.lockHandle = lockHandle;
    this.queue = Promise.resolve();
  }

  static async open({ stateDir, fileName = 'remote-hosts.json' } = {}) {
    if (typeof stateDir !== 'string' || !path.isAbsolute(stateDir)) invalid('Host registry stateDir must be absolute');
    await ensurePrivateDirectory(stateDir);
    const knownHostsDir = path.join(stateDir, 'known-hosts');
    await ensurePrivateDirectory(knownHostsDir);
    const filePath = path.join(stateDir, fileName);
    const lockPath = `${filePath}.lock`;
    const lockHandle = await acquireLock(lockPath);
    let state;
    try {
      const info = await lstat(filePath);
      if (!info.isFile() || info.isSymbolicLink()) invalid('Host registry file must be a regular non-symlink file', { filePath });
      if (process.platform !== 'win32' && ((info.mode & 0o077) !== 0 || (typeof process.getuid === 'function' && info.uid !== process.getuid()))) invalid('Host registry file must be owner-only', { filePath });
      state = JSON.parse(await readFile(filePath, 'utf8'));
      validateState(state);
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        if (error instanceof SyntaxError) invalid('Host registry JSON is invalid', { filePath });
        await releaseLock(lockHandle, lockPath);
        throw error;
      }
      state = { schemaVersion: '1.0', revision: 0, hosts: [] };
      try { await atomicWrite(filePath, `${JSON.stringify(state, null, 2)}\n`); } catch (writeError) { await releaseLock(lockHandle, lockPath); throw writeError; }
    }
    return new HostRegistry({ stateDir, state, filePath, lockPath, lockHandle });
  }

  list() {
    return this.state.hosts.map((host) => clone(host)).sort((left, right) => left.id.localeCompare(right.id));
  }

  get(idOrTarget) {
    const value = String(idOrTarget ?? '');
    const matches = this.state.hosts.filter((host) => host.id === value || host.sshTarget === value || host.hostId === value);
    if (matches.length !== 1) throw new DshRemoteError(matches.length === 0 ? 'remote Host is not registered' : 'remote Host identity is ambiguous', { code: matches.length === 0 ? 'HOST_NOT_FOUND' : 'HOST_AMBIGUOUS', details: { value } });
    return clone(matches[0]);
  }

  async add(profile, { replace = false } = {}) {
    const validated = validateProfile(profile);
    return this.#update(async (next) => {
      const conflict = next.hosts.find((host) => host.id === validated.id || host.sshTarget === validated.sshTarget);
      if (conflict && !replace) throw new DshRemoteError('remote Host is already registered', { code: 'HOST_ALREADY_REGISTERED', details: { id: conflict.id, sshTarget: conflict.sshTarget } });
      if (conflict && (conflict.id !== validated.id || conflict.sshTarget !== validated.sshTarget)) throw new DshRemoteError('replace cannot change Host identity', { code: 'HOST_IDENTITY_CONFLICT' });
      await atomicWrite(validated.knownHostsFile, `${validated.hostKeyAlias} ${validated.hostKey.keyType} ${validated.hostKey.publicKey}\n`);
      next.hosts = next.hosts.filter((host) => host.id !== validated.id);
      next.hosts.push(validated);
      next.revision += 1;
      return validated;
    });
  }

  async remove(idOrTarget) {
    const existing = this.get(idOrTarget);
    return this.#update(async (next) => {
      next.hosts = next.hosts.filter((host) => host.id !== existing.id);
      next.revision += 1;
      await rm(existing.knownHostsFile, { force: true });
      return existing;
    });
  }

  knownHostsPath(hostId) {
    if (!HOST_ID.test(hostId ?? '')) invalid('Host id is invalid', { hostId });
    return path.join(this.knownHostsDir, `${hostId}.known_hosts`);
  }

  async stageKnownHost({ hostId, hostKeyAlias, keyType, publicKey } = {}) {
    const filePath = this.knownHostsPath(hostId);
    if (!SSH_TARGET.test(hostKeyAlias ?? '') || !KEY_TYPE.test(keyType ?? '') || !PUBLIC_KEY.test(publicKey ?? '')) invalid('managed Host key entry is invalid', { hostId });
    await atomicWrite(filePath, `${hostKeyAlias} ${keyType} ${publicKey}\n`);
    return filePath;
  }

  async discardStagedKnownHost(hostId) {
    await rm(this.knownHostsPath(hostId), { force: true });
  }

  async close() {
    await releaseLock(this.lockHandle, this.lockPath);
    this.lockHandle = null;
  }

  async #update(mutator) {
    const run = this.queue.then(async () => {
      const next = clone(this.state);
      const result = await mutator(next);
      validateState(next);
      await atomicWrite(this.filePath, `${JSON.stringify(next, null, 2)}\n`);
      this.state = next;
      return clone(result);
    });
    this.queue = run.catch(() => undefined);
    return run;
  }
}

async function acquireLock(lockPath) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(lockPath, 'wx', 0o600);
      await handle.writeFile(`${process.pid}\n`, 'utf8');
      await handle.sync();
      return handle;
    } catch (error) {
      if (error?.code !== 'EEXIST' || attempt > 0) throw new DshRemoteError('another DSH process owns the Host registry', { code: 'HOST_REGISTRY_LOCKED', details: { lockPath } });
      let pid = null;
      try { pid = Number((await readFile(lockPath, 'utf8')).trim()); } catch { pid = null; }
      if (Number.isInteger(pid) && pid > 0) {
        try { process.kill(pid, 0); throw new DshRemoteError('another DSH process owns the Host registry', { code: 'HOST_REGISTRY_LOCKED', details: { lockPath, pid } }); } catch (probeError) { if (probeError instanceof DshRemoteError) throw probeError; }
      }
      await rm(lockPath, { force: true });
    }
  }
  throw new DshRemoteError('Host registry lock acquisition failed', { code: 'HOST_REGISTRY_LOCKED' });
}

async function releaseLock(handle, lockPath) {
  if (!handle) return;
  await handle.close().catch(() => {});
  await rm(lockPath, { force: true }).catch(() => {});
}

export async function verifyHostRegistryPermissions(registry) {
  const paths = [registry.stateDir, registry.filePath, ...registry.list().map((host) => host.knownHostsFile)];
  const result = [];
  for (const filePath of paths) {
    const info = await stat(filePath);
    result.push({ path: filePath, mode: info.mode & 0o777, isFile: info.isFile(), isDirectory: info.isDirectory() });
  }
  return result;
}
