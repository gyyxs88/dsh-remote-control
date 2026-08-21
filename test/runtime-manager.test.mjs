import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { TrustedArtifactRegistry } from '../lib/desired-state-registry.mjs';
import { installRemoteArtifact, inspectRemoteArtifact, rollbackRemoteArtifact } from '../lib/remote-artifact-installer.mjs';
import { InstalledRuntimeManager, RuntimeSynchronizer, buildRuntimeSyncCommands, parseGrokDeviceAuthOutput } from '../lib/runtime-manager.mjs';
import { RemoteControlConnector } from '../lib/connector.mjs';
import { RemoteHostDaemon } from '../lib/remote-host.mjs';
import { FakeSessionControlPort } from '../lib/session-control-port.mjs';
import { TransportError, DshRemoteError } from '../lib/errors.mjs';

const execFile = promisify(execFileCallback);
const DSH = '0.1.0-rc.6';
const API = '1.0';
const COMPATIBILITY = { dsh: { min: DSH, max: DSH }, api: { min: API, max: API } };

async function makeRuntimeArtifact(root, { id, version, driver = id, executablePath = `bin/${id.replaceAll('/', '-')}` }) {
  const sourceRoot = join(root, `${id.replaceAll('/', '-')}-${version}-source`);
  const packageRoot = join(sourceRoot, 'package');
  await mkdir(join(packageRoot, 'bin'), { recursive: true });
  const packageName = `dsh-runtime-${id.replaceAll('/', '-')}`;
  await writeFile(join(packageRoot, 'package.json'), `${JSON.stringify({ name: packageName, version, dsh: { runtime: { runtimeId: id, version, target: 'linux-x86_64', protocolVersion: '1.0', driver, executablePath } } }, null, 2)}\n`);
  const executable = join(packageRoot, ...executablePath.split('/'));
  await writeFile(executable, '#!/bin/sh\nprintf fake-runtime\n');
  await chmod(executable, 0o755);
  const artifactPath = join(root, `${packageName}-${version}.tgz`);
  await execFile('tar', ['-czf', artifactPath, '-C', sourceRoot, 'package']);
  const bytes = await readFile(artifactPath);
  return { id, version, driver, packageName, executablePath, artifactPath, size: (await stat(artifactPath)).size, sha256: createHash('sha256').update(bytes).digest('hex') };
}

function requirement(artifact, { requiredBy = ['project:runtime'] } = {}) {
  return { id: artifact.id, version: artifact.version, placement: 'remote', source: { registry: 'runtime-test', artifact: artifact.artifactPath.split(/[\\/]/u).pop() }, sha256: artifact.sha256, size: artifact.size, target: 'linux-x86_64', packageName: artifact.packageName, executablePath: artifact.executablePath, protocolVersion: '1.0', driver: artifact.driver, authPolicy: artifact.driver === 'grok-build' ? 'driver-defined' : 'remote-user', capabilities: ['headless'], compatibility: COMPATIBILITY, requiredBy };
}

function desired(runtimes) {
  return { dshVersion: DSH, apiVersion: API, plugins: [], skills: [], runtimes, defaultPermission: 'workspace-write', modelRoute: 'local-gateway-required' };
}

class LocalRuntimeTransport {
  constructor({ installRoot, daemon = null, linkType = process.platform === 'win32' ? 'junction' : 'dir' } = {}) {
    this.installRoot = installRoot;
    this.daemon = daemon;
    this.linkType = linkType;
    this.uploads = new Map();
    this.failInstallIds = new Set();
    this.dropRollbackResponse = false;
    this.dropCleanupResponse = false;
  }

  async request(message) { return this.daemon.handle(message); }

  async upload(localPath, remotePath, options) { this.uploads.set(remotePath, { localPath, options }); }

  async execArgv(argv) {
    if (argv[0] === 'mkdir' || argv[0] === 'rmdir') return { stdout: '', stderr: '', code: 0 };
    if (argv[0] === 'rm') {
      if (this.dropCleanupResponse) { this.dropCleanupResponse = false; throw new TransportError('fake cleanup response was lost after remote completion'); }
      return { stdout: '', stderr: '', code: 0 };
    }
    const id = argv[argv.indexOf('--id') + 1];
    if (argv.includes('--status') || argv.includes('--probe')) return { stdout: JSON.stringify(await inspectRemoteArtifact({ kind: 'runtime', id, installRoot: this.installRoot })), stderr: '', code: 0 };
    if (argv.includes('--rollback')) {
      const target = argv.includes('--target-missing')
        ? { status: 'missing' }
        : { status: 'installed', version: argv[argv.indexOf('--target-version') + 1], sha256: argv[argv.indexOf('--target-sha256') + 1], size: Number(argv[argv.indexOf('--target-size') + 1]), packageName: argv[argv.indexOf('--target-package-name') + 1], executablePath: argv[argv.indexOf('--target-executable-path') + 1], target: argv[argv.indexOf('--target') + 1], protocolVersion: argv[argv.indexOf('--protocol-version') + 1] };
      const result = await rollbackRemoteArtifact({ kind: 'runtime', id, installRoot: this.installRoot, target, linkType: this.linkType });
      if (this.dropRollbackResponse) { this.dropRollbackResponse = false; throw new TransportError('fake rollback response was lost after remote completion'); }
      return { stdout: JSON.stringify(result), stderr: '', code: 0 };
    }
    if (this.failInstallIds.has(id)) throw new DshRemoteError(`fake install failed for ${id}`, { code: 'RUNTIME_INSTALL_FAILED' });
    const remotePath = argv[argv.indexOf('--artifact') + 1];
    const uploaded = this.uploads.get(remotePath);
    const result = await installRemoteArtifact({ artifactPath: uploaded.localPath, kind: 'runtime', id, version: argv[argv.indexOf('--version') + 1], expectedSha256: argv[argv.indexOf('--sha256') + 1], installRoot: this.installRoot, packageName: argv[argv.indexOf('--package-name') + 1], executablePath: argv[argv.indexOf('--executable-path') + 1], protocolVersion: argv[argv.indexOf('--protocol-version') + 1], target: argv[argv.indexOf('--target') + 1], linkType: this.linkType });
    return { stdout: JSON.stringify(result), stderr: '', code: 0 };
  }
}

function makeRegistry(artifacts) {
  return new TrustedArtifactRegistry(artifacts.map((artifact) => ({ kind: 'runtime', ...requirement(artifact), artifactPath: artifact.artifactPath, manifest: { target: 'linux-x86_64', protocolVersion: '1.0', executablePath: artifact.executablePath } })));
}

test('runtime artifacts are installed on demand with absolute executable resolution and honest auth state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-runtime-manager-'));
  try {
    const codex = await makeRuntimeArtifact(root, { id: 'codex', version: '1.0.0' });
    const installRoot = join(root, 'remote');
    const linkType = process.platform === 'win32' ? 'junction' : 'dir';
    await installRemoteArtifact({ ...codex, kind: 'runtime', expectedSha256: codex.sha256, installRoot, linkType });
    const req = requirement(codex);
    const unverified = new InstalledRuntimeManager({ installRoot });
    const first = await unverified.inspect([req]);
    assert.equal(first[0].state, 'installed-auth-unverified');
    assert.match(first[0].executable, /bin[\\/]codex$/u);
    const challenge = await unverified.authChallenge(req);
    assert.equal(challenge.challenge.methods[0].id, 'codex-login');
    const authRequired = new InstalledRuntimeManager({ installRoot, authProbe: async () => ({ state: 'auth-required', auth: { status: 'expired', expiresAt: '2026-08-20T00:00:00.000Z' } }) });
    assert.equal((await authRequired.inspect([req]))[0].state, 'auth-required');
    const expiredReady = new InstalledRuntimeManager({ installRoot, authProbe: async () => ({ state: 'ready', auth: { status: 'ready', expiresAt: '2026-08-20T00:00:00.000Z' } }) });
    assert.equal((await expiredReady.inspect([req]))[0].state, 'auth-required');
    const ready = new InstalledRuntimeManager({ installRoot, authProbe: async () => ({ state: 'ready', auth: { status: 'ready' } }) });
    const executable = await ready.resolveExecutable(req);
    assert.equal(executable.state, 'ready');
    assert.equal(executable.runtime.id, 'codex');
    assert.equal((await stat(executable.executable)).isFile(), true);
    const claudeReq = requirement({ ...codex, id: 'claude-code', driver: 'claude-code', packageName: 'dsh-runtime-claude-code', executablePath: 'bin/claude-code' });
    assert.equal((await ready.inspect([claudeReq]))[0].state, 'missing');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('runtime synchronizer installs only requested channels and preserves prior version on multi-runtime failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-runtime-sync-'));
  try {
    const codexOld = await makeRuntimeArtifact(root, { id: 'codex', version: '1.0.0' });
    const codexNew = await makeRuntimeArtifact(root, { id: 'codex', version: '1.1.0' });
    const claude = await makeRuntimeArtifact(root, { id: 'claude-code', version: '1.0.0' });
    const registry = makeRegistry([codexNew, claude]);
    const installRoot = join(root, 'remote');
    const linkType = process.platform === 'win32' ? 'junction' : 'dir';
    await installRemoteArtifact({ ...codexOld, kind: 'runtime', expectedSha256: codexOld.sha256, installRoot, linkType });
    const daemon = await RemoteHostDaemon.create({ sessionControl: new FakeSessionControlPort() });
    const transport = new LocalRuntimeTransport({ installRoot, daemon, linkType });
    transport.failInstallIds.add('claude-code');
    const synchronizer = new RuntimeSynchronizer({ registry, transport, remoteRoot: '/home/test/.dsh-remote' });
    const connector = new RemoteControlConnector({ transport, runtimeSynchronizer: synchronizer, sourceHostId: 'local', sourceSessionId: 'controller' });
    await connector.connect();
    const result = await connector.openProject({ absolutePath: '/srv/runtime-failure', desiredState: desired([requirement(codexNew), requirement(claude)]) });
    assert.equal(result.state, 'needs-attention');
    assert.equal(result.error.code, 'RUNTIME_SYNC_NEEDS_ATTENTION');
    assert.equal(result.result.runtimeSync.rollback.status, 'completed');
    assert.equal((await inspectRemoteArtifact({ kind: 'runtime', id: 'codex', installRoot })).version, '1.0.0');
    assert.equal((await stat(join(installRoot, 'runtimes', 'codex', 'versions', '1.0.0'))).isDirectory(), true);
    assert.equal((await stat(join(installRoot, 'runtimes', 'codex', 'versions', '1.1.0'))).isDirectory(), true);
    assert.equal((await inspectRemoteArtifact({ kind: 'runtime', id: 'claude-code', installRoot })).status, 'missing');
    assert.equal(daemon.sessionControl.calls.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('runtime rollback response loss becomes persistence-unknown and stable status reconciles completed rollback', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-runtime-unknown-'));
  try {
    const oldRuntime = await makeRuntimeArtifact(root, { id: 'grok-build', version: '1.0.0' });
    const newRuntime = await makeRuntimeArtifact(root, { id: 'grok-build', version: '1.1.0' });
    const registry = makeRegistry([newRuntime]);
    const installRoot = join(root, 'remote');
    const linkType = process.platform === 'win32' ? 'junction' : 'dir';
    await installRemoteArtifact({ ...oldRuntime, kind: 'runtime', expectedSha256: oldRuntime.sha256, installRoot, linkType });
    const transport = new LocalRuntimeTransport({ installRoot, linkType });
    transport.dropCleanupResponse = true;
    transport.dropRollbackResponse = true;
    const synchronizer = new RuntimeSynchronizer({ registry, transport, remoteRoot: '/home/test/.dsh-remote' });
    const result = await synchronizer.sync({ desiredState: desired([requirement(newRuntime)]), operationId: 'runtime-unknown-001' });
    assert.equal(result.status, 'persistence-unknown');
    assert.equal(result.rollback.status, 'unknown');
    const reconciled = await synchronizer.reconcile('runtime-unknown-001');
    assert.equal(reconciled.status, 'needs-attention');
    assert.equal(reconciled.rollback.status, 'completed');
    assert.equal((await inspectRemoteArtifact({ kind: 'runtime', id: 'grok-build', installRoot })).version, '1.0.0');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('runtime command builder exposes no shell and keeps target executable path explicit', () => {
  const commands = buildRuntimeSyncCommands({ id: 'acp/example', version: '1.0.0', sha256: 'a'.repeat(64), size: 10, packageName: 'dsh-runtime-acp-example', executablePath: 'bin/agent', protocolVersion: '1.0', remoteRoot: '/home/test/.dsh-remote', remoteStagingRoot: '/home/test/.dsh-remote/staging', remoteArtifactPath: '/home/test/.dsh-remote/staging/a.tgz', installerPath: '/home/test/.dsh-remote/current/bin/dsh-remote-artifact-installer.mjs' });
  assert.equal(commands.install.includes('sh'), false);
  assert.equal(commands.install[commands.install.indexOf('--executable-path') + 1], 'bin/agent');
  assert.equal(commands.rollback({ status: 'missing' }).includes('--target-missing'), true);
});

test('Grok device auth output exposes only public URL and device code', () => {
  const parsed = parseGrokDeviceAuthOutput('Open https://auth.x.ai/device to continue\nDevice code: AB12-CD34\naccess_token=must-not-escape');
  assert.deepEqual(parsed, { url: 'https://auth.x.ai/device', userCode: 'AB12-CD34' });
});
