import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import { ControlArtifactProvider } from './control-artifacts.mjs';
import { loadOrCreateConnectorIdentity } from './connector-identity.mjs';
import { DshRemoteError } from './errors.mjs';
import { HostRegistry } from './host-registry.mjs';
import { buildManagedHostProfile, ManagedHostConnection, probeRemoteSystem } from './managed-host.mjs';
import { SshCommandTransport } from './ssh.mjs';
import { probeSshHostKeys, selectHostKey } from './ssh-discovery.mjs';

const HOST_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,50}$/u;
const PERMISSIONS = new Set(['read-only', 'workspace-write', 'danger-full-access']);

function publicHost(profile) {
  return {
    id: profile.id,
    ssh_target: profile.sshTarget,
    hostname: profile.hostname,
    user: profile.user,
    port: profile.port,
    fingerprint: profile.expectedFingerprint,
    platform: profile.platform,
    arch: profile.arch,
    node_version: profile.nodeVersion,
    allowed_root: profile.allowedRoot,
    remote_root: profile.remoteRoot,
    dsh_port: profile.dshPort,
    created_at: profile.createdAt,
    updated_at: profile.updatedAt,
  };
}

function requireIdempotencyKey(value) {
  if (typeof value !== 'string' || value.length < 8 || value.length > 128 || /[\0\r\n]/u.test(value)) throw new DshRemoteError('operation requires an 8-128 character idempotency key', { code: 'IDEMPOTENCY_KEY_INVALID' });
  return value;
}

export class RemoteProjectController {
  constructor({ registry, artifactProvider, identity, stateDir, sshPath = 'ssh', scpPath = 'scp', sshKeyscanPath = 'ssh-keyscan', spawnImpl, connectionFactory, hostKeyProber = probeSshHostKeys, systemProber = probeRemoteSystem } = {}) {
    if (!(registry instanceof HostRegistry) && (!registry || typeof registry.list !== 'function' || typeof registry.get !== 'function')) throw new DshRemoteError('Remote Project controller requires a Host registry', { code: 'REMOTE_CONTROLLER_CONFIG_INVALID' });
    if (!artifactProvider || typeof artifactProvider.prepare !== 'function' || !identity?.sourceHostId || !identity?.sourceSessionId || typeof stateDir !== 'string' || !path.isAbsolute(stateDir)) throw new DshRemoteError('Remote Project controller configuration is invalid', { code: 'REMOTE_CONTROLLER_CONFIG_INVALID' });
    this.registry = registry;
    this.artifactProvider = artifactProvider;
    this.identity = identity;
    this.stateDir = stateDir;
    this.sshPath = sshPath;
    this.scpPath = scpPath;
    this.sshKeyscanPath = sshKeyscanPath;
    this.spawnImpl = spawnImpl;
    this.connectionFactory = connectionFactory;
    this.hostKeyProber = hostKeyProber;
    this.systemProber = systemProber;
    this.connections = new Map();
    this.hostLocks = new Map();
  }

  static async open({ stateDir, dshRecipeRoot = process.cwd(), sessionControlPackageRoot, sshPath = 'ssh', scpPath = 'scp', sshKeyscanPath = 'ssh-keyscan', npmPath, tarPath = 'tar', spawnImpl, connectionFactory, artifactProvider } = {}) {
    if (typeof stateDir !== 'string' || !path.isAbsolute(stateDir)) throw new DshRemoteError('Remote Project controller stateDir must be absolute', { code: 'REMOTE_CONTROLLER_CONFIG_INVALID' });
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    const registry = await HostRegistry.open({ stateDir });
    const identity = await loadOrCreateConnectorIdentity(path.join(stateDir, 'connector-identity.json'));
    const provider = artifactProvider ?? new ControlArtifactProvider({ cacheDir: path.join(stateDir, 'artifacts'), dshRecipeRoot, sessionControlPackageRoot, ...(npmPath ? { npmPath } : {}), tarPath, spawnImpl });
    return new RemoteProjectController({ registry, artifactProvider: provider, identity, stateDir, sshPath, scpPath, sshKeyscanPath, spawnImpl, connectionFactory });
  }

  listHosts() {
    return { ok: true, hosts: this.registry.list().map(publicHost) };
  }

  getHost(hostId) {
    return publicHost(this.registry.get(hostId));
  }

  async probeHost({ sshTarget } = {}) {
    const probe = await this.hostKeyProber(sshTarget, { sshPath: this.sshPath, sshKeyscanPath: this.sshKeyscanPath, spawnImpl: this.spawnImpl });
    return {
      status: 'needs-confirmation',
      ssh_target: sshTarget,
      resolved: { hostname: probe.resolved.hostname, user: probe.resolved.user, port: probe.resolved.port },
      host_keys: probe.candidates.map((candidate) => ({ key_type: candidate.keyType, fingerprint: candidate.fingerprint })),
      instruction: 'Verify one fingerprint through an independent trusted channel, then call remote_host_add with that exact fingerprint.',
    };
  }

  async addHost({ hostId, sshTarget, expectedFingerprint, allowedRoot, remoteRoot, dshPort = 3181 } = {}) {
    if (!HOST_ID.test(hostId ?? '')) throw new DshRemoteError('host_id must contain 1-51 safe characters', { code: 'HOST_ID_INVALID' });
    const conflict = this.registry.list().find((host) => host.id === hostId || host.sshTarget === sshTarget);
    if (conflict) throw new DshRemoteError('remote Host is already registered', { code: 'HOST_ALREADY_REGISTERED', details: { id: conflict.id, sshTarget: conflict.sshTarget } });
    const probe = await this.hostKeyProber(sshTarget, { sshPath: this.sshPath, sshKeyscanPath: this.sshKeyscanPath, spawnImpl: this.spawnImpl });
    const selected = selectHostKey(probe, expectedFingerprint);
    const hostKeyAlias = `dsh-${hostId}`;
    const knownHostsFile = await this.registry.stageKnownHost({ hostId, hostKeyAlias, keyType: selected.keyType, publicKey: selected.publicKey });
    try {
      const policy = { knownHostsFile, hostKeyAlias, expectedFingerprint };
      const transport = new SshCommandTransport({ sshPath: this.sshPath, scpPath: this.scpPath, policy, host: sshTarget, commandTimeoutMs: 60_000, maxOutputBytes: 512 * 1024, ...(this.spawnImpl ? { spawnImpl: this.spawnImpl } : {}) });
      const system = await this.systemProber(transport);
      const profile = buildManagedHostProfile({ id: hostId, sshTarget, hostname: probe.resolved.hostname, user: probe.resolved.user, port: probe.resolved.port, hostKeyAlias, expectedFingerprint, hostKey: selected, knownHostsFile, system, allowedRoot, remoteRoot, dshPort });
      const added = await this.registry.add(profile);
      return { ok: true, status: 'registered', host: publicHost(added), next: 'Call remote_project_open; provisioning is automatic on first use.' };
    } catch (error) {
      await this.registry.discardStagedKnownHost(hostId);
      throw error;
    }
  }

  async updateHost({ hostId, allowedRoot, dshPort } = {}) {
    const current = this.registry.get(hostId);
    if (allowedRoot === undefined && dshPort === undefined) throw new DshRemoteError('remote Host update requires allowed_root or dsh_port', { code: 'HOST_UPDATE_EMPTY' });
    const next = { ...current, ...(allowedRoot === undefined ? {} : { allowedRoot }), ...(dshPort === undefined ? {} : { dshPort }), updatedAt: new Date().toISOString() };
    const connection = this.connections.get(current.id);
    connection?.close?.();
    this.connections.delete(current.id);
    const updated = await this.registry.add(next, { replace: true });
    return { ok: true, status: 'updated', host: publicHost(updated), remote_installation_preserved: true };
  }

  async removeHost({ hostId } = {}) {
    const profile = this.registry.get(hostId);
    this.connections.get(profile.id)?.close?.();
    this.connections.delete(profile.id);
    const removed = await this.registry.remove(profile.id);
    return { ok: true, status: 'removed-locally', host: publicHost(removed), remote_installation_preserved: true };
  }

  async inspectHost({ hostId } = {}) {
    const profile = this.registry.get(hostId);
    const existing = this.connections.get(profile.id);
    const connection = existing ?? new ManagedHostConnection({ profile, identity: this.identity, artifacts: null, stateDir: this.stateDir, sshPath: this.sshPath, scpPath: this.scpPath, ...(this.spawnImpl ? { spawnImpl: this.spawnImpl } : {}) });
    try { return { ok: true, ...(await connection.inspect()) }; } finally { if (!existing) connection.close(); }
  }

  async openProject({ hostId, absolutePath, displayName, permission = 'workspace-write', targetSessionId, schedule, idempotencyKey } = {}) {
    if (!PERMISSIONS.has(permission)) throw new DshRemoteError('remote project permission is invalid', { code: 'REMOTE_PROJECT_PERMISSION_INVALID' });
    requireIdempotencyKey(idempotencyKey);
    return this.#withHostLock(hostId, async () => {
      const connection = await this.#connection(hostId);
      const operation = await connection.openProject({ absolutePath, displayName, permission, targetSessionId, schedule, idempotencyKey });
      return { ok: true, host_id: this.registry.get(hostId).id, operation };
    });
  }

  async createSchedule({ hostId, absolutePath, targetSessionId, schedule, idempotencyKey } = {}) {
    if (absolutePath !== undefined && (typeof absolutePath !== 'string' || absolutePath.length === 0)) throw new DshRemoteError('remote schedule path is invalid', { code: 'REMOTE_SCHEDULE_INVALID' });
    if (typeof targetSessionId !== 'string' || targetSessionId.length === 0 || !schedule || typeof schedule !== 'object') throw new DshRemoteError('remote schedule creation requires target session and schedule', { code: 'REMOTE_SCHEDULE_INVALID' });
    requireIdempotencyKey(idempotencyKey);
    return this.#withHostLock(hostId, async () => {
      const connection = await this.#connection(hostId);
      const operation = await connection.createSchedule({ targetSessionId, schedule, idempotencyKey });
      return { ok: true, host_id: this.registry.get(hostId).id, operation };
    });
  }

  async deleteSchedule({ hostId, targetSessionId, scheduleId, idempotencyKey } = {}) {
    requireIdempotencyKey(idempotencyKey);
    return this.#withHostLock(hostId, async () => {
      const connection = await this.#connection(hostId);
      const operation = await connection.deleteSchedule({ targetSessionId, scheduleId, idempotencyKey });
      return { ok: true, host_id: this.registry.get(hostId).id, operation };
    });
  }

  async reconcile({ hostId } = {}) {
    return this.#withHostLock(hostId, async () => {
      const connection = await this.#connection(hostId);
      return { ok: true, host_id: this.registry.get(hostId).id, reconciliation: await connection.reconcile() };
    });
  }

  async runtimeStatus({ hostId, requirements = [] } = {}) {
    const connection = await this.#connection(hostId);
    return { ok: true, host_id: this.registry.get(hostId).id, runtime: await connection.runtimeStatus(requirements) };
  }

  async dispose() {
    const connections = [...this.connections.values()];
    this.connections.clear();
    await Promise.allSettled(connections.map((connection) => Promise.resolve(connection.close?.())));
    await this.registry.close?.();
  }

  async #connection(hostId) {
    const profile = this.registry.get(hostId);
    if (this.connections.has(profile.id)) return this.connections.get(profile.id);
    const artifacts = await this.artifactProvider.prepare();
    const connection = this.connectionFactory
      ? await this.connectionFactory({ profile, identity: this.identity, artifacts, stateDir: this.stateDir })
      : new ManagedHostConnection({ profile, identity: this.identity, artifacts, stateDir: this.stateDir, sshPath: this.sshPath, scpPath: this.scpPath, ...(this.spawnImpl ? { spawnImpl: this.spawnImpl } : {}) });
    this.connections.set(profile.id, connection);
    return connection;
  }

  #withHostLock(hostId, action) {
    const profile = this.registry.get(hostId);
    const previous = this.hostLocks.get(profile.id) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(action);
    const tracked = run.finally(() => { if (this.hostLocks.get(profile.id) === tracked) this.hostLocks.delete(profile.id); });
    this.hostLocks.set(profile.id, tracked);
    return run;
  }
}
