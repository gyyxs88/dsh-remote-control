import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { posix } from 'node:path';

import { ArtifactBootstrapper } from './bootstrap.mjs';
import { RemoteControlConnector } from './connector.mjs';
import { DesiredStateSynchronizer } from './plugin-sync.mjs';
import { DshHostBootstrapper, writeDshProfileConfig } from './dsh-host-bootstrap.mjs';
import { DshHttpClient } from './dsh-http-client.mjs';
import { DshRemoteError, NeedsAttentionError } from './errors.mjs';
import { SshCommandTransport, SshLocalTunnel, SshStdioBridge } from './ssh.mjs';
import { validateSafePosixPath } from './path-safety.mjs';

const HOST_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const NODE_VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;

function stableSuffix(value, length = 20) {
  return createHash('sha256').update(value).digest('hex').slice(0, length);
}

function validateNode24(version) {
  if (!NODE_VERSION.test(version ?? '') || Number(version.split('.')[0]) < 24) throw new DshRemoteError('remote Host requires Node.js 24 or newer', { code: 'REMOTE_NODE_VERSION_UNSUPPORTED', details: { version } });
}

export async function probeRemoteSystem(transport) {
  const script = "const os=require('node:os');process.stdout.write(JSON.stringify({platform:process.platform,arch:process.arch,uid:process.getuid?.()??null,home:os.homedir(),nodeVersion:process.versions.node}))";
  let result;
  try { result = JSON.parse((await transport.execArgv(['node', '-e', script])).stdout ?? '{}'); } catch (error) {
    throw new DshRemoteError('remote Node.js system probe failed', { code: 'REMOTE_SYSTEM_PROBE_FAILED', details: { message: error.message } });
  }
  if (result.platform !== 'linux' || result.arch !== 'x64' || !Number.isInteger(result.uid) || result.uid <= 0) throw new DshRemoteError('remote Host must be non-root Linux x86_64', { code: 'REMOTE_PLATFORM_UNSUPPORTED', details: result });
  validateSafePosixPath(result.home, { field: 'remote home', allowHome: false });
  validateNode24(result.nodeVersion);
  return result;
}

export function buildManagedHostProfile({ id, sshTarget, hostname, user, port, hostKeyAlias, expectedFingerprint, hostKey, knownHostsFile, system, allowedRoot, remoteRoot, dshPort = 3181, now = new Date().toISOString() } = {}) {
  if (!HOST_ID.test(id ?? '')) throw new DshRemoteError('remote Host id is invalid', { code: 'HOST_ID_INVALID' });
  const home = posix.normalize(system.home);
  const root = posix.normalize(remoteRoot ?? posix.join(home, '.dsh-remote', id));
  const allowed = posix.normalize(allowedRoot ?? posix.join(home, 'Projects'));
  validateSafePosixPath(root, { field: 'remoteRoot', allowHome: false });
  validateSafePosixPath(allowed, { field: 'allowedRoot', allowHome: false });
  if (!root.startsWith(`${home}/`)) throw new DshRemoteError('remoteRoot must be below the probed remote home', { code: 'REMOTE_ROOT_OUTSIDE_HOME' });
  if (!Number.isInteger(dshPort) || dshPort < 1024 || dshPort > 65535) throw new DshRemoteError('remote DSH port is invalid', { code: 'REMOTE_DSH_PORT_INVALID' });
  const identitySuffix = stableSuffix(`${id}\0${sshTarget}`);
  const hostId = `remote-${id}`;
  const controllerSessionId = `session-remote-controller-${identitySuffix}`;
  return {
    id,
    sshTarget,
    hostname,
    user,
    port,
    hostKeyAlias,
    expectedFingerprint,
    hostKey,
    knownHostsFile,
    platform: system.platform,
    arch: system.arch,
    uid: system.uid,
    home,
    nodeVersion: system.nodeVersion,
    remoteRoot: root,
    dshHome: posix.join(root, 'dsh-home'),
    allowedRoot: allowed,
    controllerWorkspace: posix.join(home, '.dsh-remote', 'controllers', id),
    controllerSessionId,
    sessionSocket: `/run/user/${system.uid}/dsh-session-control-${identitySuffix}.sock`,
    runtimeSocket: `/run/user/${system.uid}/dsh-runtime-manager-${identitySuffix}.sock`,
    runtimeTokenFile: posix.join(root, 'runtime-manager.token'),
    hostId,
    profileName: 'web',
    serviceName: `dsh-remote-${id}.service`,
    dshPort,
    createdAt: now,
    updatedAt: now,
  };
}

async function freeLoopbackPort() {
  const { createServer } = await import('node:net');
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

function desiredStateFromArtifacts(artifacts, permission = 'workspace-write') {
  return {
    dshVersion: artifacts.dshVersion,
    apiVersion: artifacts.apiVersion,
    plugins: [artifacts.sessionControl.pluginRequirement],
    skills: [artifacts.sessionControl.skillRequirement],
    runtimes: [],
    defaultPermission: permission,
    modelRoute: 'local-gateway-required',
  };
}

export class ManagedHostConnection {
  constructor({ profile, identity, artifacts, stateDir, sshPath = 'ssh', scpPath = 'scp', commandTimeoutMs = 180_000, requestTimeoutMs = 60_000, transport, bridgeFactory, tunnelFactory, dshClientFactory, spawnImpl } = {}) {
    this.profile = profile;
    this.identity = identity;
    this.artifacts = artifacts;
    this.stateDir = stateDir;
    this.sshPath = sshPath;
    this.spawnImpl = spawnImpl;
    this.commandTransport = transport ?? new SshCommandTransport({ sshPath, scpPath, policy: this.policy, host: profile.sshTarget, commandTimeoutMs, maxOutputBytes: 2 * 1024 * 1024, ...(spawnImpl ? { spawnImpl } : {}) });
    this.bridgeFactory = bridgeFactory;
    this.tunnelFactory = tunnelFactory;
    this.dshClientFactory = dshClientFactory;
    this.requestTimeoutMs = requestTimeoutMs;
    this.tunnel = null;
    this.bridge = null;
    this.connector = null;
    this.desiredStateSynchronizer = null;
    this.readyPromise = null;
  }

  get policy() {
    return { knownHostsFile: this.profile.knownHostsFile, hostKeyAlias: this.profile.hostKeyAlias, expectedFingerprint: this.profile.expectedFingerprint };
  }

  ensureReady() {
    this.readyPromise ??= this.#ensureReady().catch((error) => { this.close(); throw error; });
    return this.readyPromise;
  }

  async #ensureReady() {
    const p = this.profile;
    await this.commandTransport.execArgv(['mkdir', '-p', p.allowedRoot, p.controllerWorkspace]);
    const dshBootstrapper = new DshHostBootstrapper({ transport: this.commandTransport, trustedCatalog: this.artifacts.dsh.catalog });
    const dshOperationId = `dsh-bootstrap-${stableSuffix(`${p.id}:${this.artifacts.dshVersion}`, 32)}`;
    try {
      await dshBootstrapper.install({ recipePath: this.artifacts.dsh.recipePath, version: this.artifacts.dshVersion, pnpmVersion: this.artifacts.pnpmVersion, remoteRoot: p.remoteRoot, dshHome: p.dshHome, profileName: p.profileName, hostId: p.hostId, serviceName: p.serviceName, port: p.dshPort, operationId: dshOperationId });
    } catch (error) {
      if (!(error instanceof NeedsAttentionError) || (await dshBootstrapper.reconcile(error.details?.plan ?? dshBootstrapper.status(dshOperationId).plan)).status !== 'completed') throw error;
    }
    const hostBootstrapper = new ArtifactBootstrapper({ transport: this.commandTransport, trustedCatalog: this.artifacts.remoteHost.catalog });
    try {
      await hostBootstrapper.bootstrap({ filePath: this.artifacts.remoteHost.artifactPath, version: this.artifacts.remoteHost.version, remoteRoot: p.remoteRoot });
    } catch (error) {
      const status = hostBootstrapper.status(error.details?.operationId);
      if (!(error instanceof NeedsAttentionError) || !status.plan || (await hostBootstrapper.reconcile(status.plan)).status !== 'completed') throw error;
    }
    const localPort = await freeLoopbackPort();
    this.tunnel = this.tunnelFactory
      ? await this.tunnelFactory({ profile: p, policy: this.policy, localPort })
      : new SshLocalTunnel({ sshPath: this.sshPath, policy: this.policy, host: p.sshTarget, localPort, remotePort: p.dshPort, ...(this.spawnImpl ? { spawnImpl: this.spawnImpl } : {}) });
    this.tunnel.start?.();
    const dsh = this.dshClientFactory
      ? await this.dshClientFactory({ profile: p, endpoint: `http://127.0.0.1:${localPort}` })
      : new DshHttpClient({ endpoint: `http://127.0.0.1:${localPort}`, timeoutMs: 60_000 });
    await dsh.waitUntilReady();
    await dsh.ensureController({ workspacePath: p.controllerWorkspace, sessionId: p.controllerSessionId });
    this.desiredStateSynchronizer = new DesiredStateSynchronizer({ registry: this.artifacts.sessionControl.registry, transport: this.commandTransport, remoteRoot: p.remoteRoot });
    const desiredState = desiredStateFromArtifacts(this.artifacts);
    const pluginSync = await this.desiredStateSynchronizer.sync({ desiredState, operationId: `plugin-sync-${stableSuffix(`${p.id}:${this.artifacts.sessionControl.sha256}`, 32)}` });
    if (pluginSync.status !== 'completed') throw new DshRemoteError('session-control plugin synchronization did not complete', { code: 'MANAGED_HOST_PLUGIN_SYNC_FAILED', details: pluginSync });
    const profileDir = path.join(this.stateDir, 'profiles');
    await mkdir(profileDir, { recursive: true, mode: 0o700 });
    const profilePath = path.join(profileDir, `${p.id}.json`);
    await writeDshProfileConfig(profilePath, {
      profileName: p.profileName,
      dshVersion: this.artifacts.dshVersion,
      plugins: [{ id: 'dsh-session-control', packageName: this.artifacts.sessionControl.packageName, version: this.artifacts.sessionControl.version, sha256: this.artifacts.sessionControl.sha256, packagePath: posix.join(p.remoteRoot, 'plugins', 'dsh-session-control', 'versions', this.artifacts.sessionControl.version, 'package') }],
      sessionControl: {
        controllerSessionId: p.controllerSessionId,
        stateDir: posix.join(p.remoteRoot, 'session-control-state'),
        sameWorkspaceOnly: false,
        socketPath: p.sessionSocket,
        hostId: p.hostId,
        source: { sourceHostId: this.identity.sourceHostId, sourceSessionId: this.identity.sourceSessionId, controllerSessionId: p.controllerSessionId },
      },
    });
    const profileOperationId = `profile-activate-${stableSuffix(`${p.id}:${this.artifacts.sessionControl.sha256}`, 32)}`;
    try {
      await dshBootstrapper.configure({ profileConfigPath: profilePath, remoteRoot: p.remoteRoot, dshHome: p.dshHome, profileName: p.profileName, serviceName: p.serviceName, port: p.dshPort, operationId: profileOperationId });
    } catch (error) {
      const plan = error.details?.plan ?? dshBootstrapper.status(profileOperationId).plan;
      if (!(error instanceof NeedsAttentionError) || !plan || (await dshBootstrapper.reconcile(plan)).status !== 'completed') throw error;
    }
    await dsh.waitUntilReady();
    await dsh.warmController(p.controllerSessionId);
    let socketReady = false;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      socketReady = await this.commandTransport.execArgv(['test', '-S', p.sessionSocket]).then(() => true, () => false);
      if (socketReady) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (!socketReady) throw new DshRemoteError('remote session-control socket did not become ready', { code: 'SESSION_CONTROL_SOCKET_NOT_READY' });
    const remoteHostOptions = { sessionControlSocket: p.sessionSocket, runtimeManagerSocket: p.runtimeSocket, runtimeManagerTokenFile: p.runtimeTokenFile, runtimeRoot: posix.join(p.remoteRoot, 'runtimes'), allowedRoot: p.allowedRoot, hostId: p.hostId };
    this.bridge = this.bridgeFactory
      ? await this.bridgeFactory({ profile: p, policy: this.policy, remoteHostOptions })
      : new SshStdioBridge({ sshPath: this.sshPath, policy: this.policy, host: p.sshTarget, command: posix.join(p.remoteRoot, 'host', 'current', 'bin', 'dsh-remote-host.mjs'), dataDir: posix.join(p.remoteRoot, 'state'), remoteHostOptions, requestTimeoutMs: this.requestTimeoutMs, ...(this.spawnImpl ? { spawnImpl: this.spawnImpl } : {}) });
    this.connector = new RemoteControlConnector({ transport: this.bridge, identity: this.identity, desiredStateSynchronizer: this.desiredStateSynchronizer });
    const connection = await this.connector.connect();
    return { connection, desiredState, pluginSync };
  }

  async openProject(options) {
    const ready = await this.ensureReady();
    return this.connector.openProject({ ...options, desiredState: { ...ready.desiredState, defaultPermission: options.permission ?? ready.desiredState.defaultPermission } });
  }

  async reconcile() {
    await this.ensureReady();
    return this.connector.reconcile();
  }

  async deleteSchedule(options) {
    await this.ensureReady();
    return this.connector.deleteSchedule(options);
  }

  async createSchedule(options) {
    await this.ensureReady();
    return this.connector.createSchedule(options);
  }

  async runtimeStatus(requirements = []) {
    await this.ensureReady();
    return this.connector.runtimeStatus(requirements);
  }

  async inspect() {
    const p = this.profile;
    const remoteHost = await this.commandTransport.execArgv(['node', posix.join(p.remoteRoot, 'host', 'current', 'bin', 'dsh-remote-host-installer.mjs'), '--status', '--install-root', posix.join(p.remoteRoot, 'host')]).then((result) => JSON.parse(result.stdout), (error) => ({ status: 'missing-or-unreachable', error: error.code ?? 'SSH_COMMAND_FAILED' }));
    const dsh = await this.commandTransport.execArgv(['node', posix.join(p.remoteRoot, 'dsh', 'bin', 'dsh-remote-dsh-installer.mjs'), '--status', '--remote-root', p.remoteRoot, '--dsh-home', p.dshHome, '--profile', p.profileName, '--service-name', p.serviceName, '--port', String(p.dshPort)]).then((result) => JSON.parse(result.stdout), (error) => ({ status: 'missing-or-unreachable', error: error.code ?? 'SSH_COMMAND_FAILED' }));
    return { host: p.id, sshTarget: p.sshTarget, fingerprint: p.expectedFingerprint, platform: p.platform, arch: p.arch, nodeVersion: p.nodeVersion, allowedRoot: p.allowedRoot, remoteRoot: p.remoteRoot, remoteHost, dsh };
  }

  close() {
    this.connector = null;
    this.bridge?.close?.();
    this.bridge = null;
    this.tunnel?.close?.();
    this.tunnel = null;
    this.readyPromise = null;
  }
}
