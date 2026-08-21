import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile, mkdir, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { promisify } from 'node:util';
import { DshRemoteError, TransportError } from '../lib/errors.mjs';
import { TrustedArtifactRegistry } from '../lib/desired-state-registry.mjs';
import { DesiredStateSynchronizer, buildPluginSyncCommands } from '../lib/plugin-sync.mjs';
import { installRemoteArtifact, inspectRemoteArtifact, rollbackRemoteArtifact } from '../lib/remote-artifact-installer.mjs';
import { RemoteHostDaemon } from '../lib/remote-host.mjs';
import { FakeSessionControlPort } from '../lib/session-control-port.mjs';
import { FakeTransport, RemoteControlConnector } from '../lib/connector.mjs';

const execFile = promisify(execFileCallback);
const DSH = '0.1.0-rc.6';
const API = '1.0';

async function makePlugin(root, options = []) {
  const config = Array.isArray(options) ? { bundledSkills: options } : options;
  const id = config.id ?? 'sync-plugin';
  const name = config.name ?? 'dsh-sync-plugin';
  const version = config.version ?? '1.0.0';
  const bundledSkills = config.bundledSkills ?? [];
  const packageRoot = join(root, 'package');
  await mkdir(packageRoot, { recursive: true });
  await writeFile(join(packageRoot, 'package.json'), `${JSON.stringify({ name, version, dsh: { remote: { pluginId: id, version, placements: ['remote'], protocolVersion: '1.0', bundledSkills } } }, null, 2)}\n`);
  await writeFile(join(packageRoot, 'index.mjs'), 'export const synced = true\n');
  const artifactPath = join(root, `${name}-${version}.tgz`);
  await execFile('tar', ['-czf', artifactPath, '-C', root, 'package']);
  const bytes = await readFile(artifactPath);
  return { id, name, packageName: name, version, artifactPath, sha256: createHash('sha256').update(bytes).digest('hex'), size: (await stat(artifactPath)).size, artifactName: basename(artifactPath) };
}

function desired(artifact) {
  return {
    dshVersion: DSH,
    apiVersion: API,
    plugins: [{ id: artifact.id ?? 'sync-plugin', version: artifact.version ?? '1.0.0', placement: 'remote', source: { registry: 'test-registry', artifact: artifact.artifactName }, sha256: artifact.sha256, compatibility: { dsh: { min: DSH, max: DSH }, api: { min: API, max: API } }, requiredBy: ['project:sync'] }],
    skills: [],
    runtimes: [],
    defaultPermission: 'workspace-write',
    modelRoute: 'local-gateway-required',
  };
}

class FakePluginTransport {
  constructor() {
    this.installed = new Map();
    this.uploads = [];
    this.commands = [];
    this.dropCleanupResponse = false;
  }

  async upload(localPath, remotePath, options) {
    this.uploads.push({ localPath, remotePath, options });
  }

  async execArgv(argv) {
    this.commands.push([...argv]);
    if (argv[0] === 'mkdir' || argv[0] === 'rmdir') return { stdout: '', stderr: '', code: 0 };
    if (argv[0] === 'rm') {
      if (this.dropCleanupResponse) {
        this.dropCleanupResponse = false;
        throw new TransportError('fake cleanup response was lost after remote completion');
      }
      return { stdout: '', stderr: '', code: 0 };
    }
    const kind = argv[argv.indexOf('--kind') + 1];
    const id = argv[argv.indexOf('--id') + 1];
    const key = `${kind}:${id}`;
    if (argv.includes('--rollback')) {
      if (argv.includes('--target-missing')) this.installed.delete(key);
      return { stdout: JSON.stringify({ status: argv.includes('--target-missing') ? 'already-missing' : 'rolled-back', kind, id, version: argv[argv.indexOf('--target-version') + 1], sha256: argv[argv.indexOf('--target-sha256') + 1], size: Number(argv[argv.indexOf('--target-size') + 1]), packageName: argv[argv.indexOf('--target-package-name') + 1], target: argv[argv.indexOf('--target') + 1], protocolVersion: argv[argv.indexOf('--protocol-version') + 1] }), stderr: '', code: 0 };
    }
    if (argv.includes('--status') || argv.includes('--probe')) {
      const value = this.installed.get(key);
      return { stdout: JSON.stringify(value ?? { status: 'missing', kind, id }), stderr: '', code: 0 };
    }
    const version = argv[argv.indexOf('--version') + 1];
    const sha256 = argv[argv.indexOf('--sha256') + 1];
    const packageName = argv[argv.indexOf('--package-name') + 1];
    const value = { status: 'installed', kind, id, version, sha256, packageName, size: 1 };
    const remoteArtifactPath = argv[argv.indexOf('--artifact') + 1];
    const upload = this.uploads.find((item) => item.remotePath === remoteArtifactPath);
    value.size = upload?.options?.size ?? 1;
    value.target = argv[argv.indexOf('--target') + 1] ?? 'linux-x86_64';
    value.protocolVersion = argv[argv.indexOf('--protocol-version') + 1] ?? '1.0';
    this.installed.set(key, value);
    return { stdout: JSON.stringify(value), stderr: '', code: 0 };
  }
}

class LocalInstallerTransport {
  constructor({ installRoot, daemon = null, linkType = process.platform === 'win32' ? 'junction' : 'dir' } = {}) {
    this.installRoot = installRoot;
    this.daemon = daemon;
    this.linkType = linkType;
    this.uploads = new Map();
    this.failInstallIds = new Set();
    this.dropRollbackResponse = false;
    this.dropCleanupResponse = false;
  }

  async request(message) {
    return this.daemon.handle(message);
  }

  async upload(localPath, remotePath, options) {
    this.uploads.set(remotePath, { localPath, options });
  }

  async execArgv(argv) {
    if (argv[0] === 'mkdir' || argv[0] === 'rmdir') return { stdout: '', stderr: '', code: 0 };
    if (argv[0] === 'rm') {
      if (this.dropCleanupResponse) {
        this.dropCleanupResponse = false;
        throw new TransportError('fake cleanup response was lost after remote completion');
      }
      return { stdout: '', stderr: '', code: 0 };
    }
    const kind = argv[argv.indexOf('--kind') + 1];
    const id = argv[argv.indexOf('--id') + 1];
    if (argv.includes('--status') || argv.includes('--probe')) return { stdout: JSON.stringify(await inspectRemoteArtifact({ kind, id, installRoot: this.installRoot })), stderr: '', code: 0 };
    if (argv.includes('--rollback')) {
      const target = argv.includes('--target-missing')
        ? { status: 'missing' }
        : { status: 'installed', version: argv[argv.indexOf('--target-version') + 1], sha256: argv[argv.indexOf('--target-sha256') + 1], size: Number(argv[argv.indexOf('--target-size') + 1]), packageName: argv[argv.indexOf('--target-package-name') + 1], target: argv[argv.indexOf('--target') + 1], protocolVersion: argv[argv.indexOf('--protocol-version') + 1] };
      const result = await rollbackRemoteArtifact({ kind, id, installRoot: this.installRoot, target, linkType: this.linkType });
      if (this.dropRollbackResponse) {
        this.dropRollbackResponse = false;
        throw new TransportError('fake rollback response was lost after remote completion');
      }
      return { stdout: JSON.stringify(result), stderr: '', code: 0 };
    }
    if (this.failInstallIds.has(id)) throw new DshRemoteError(`fake install failed for ${id}`, { code: 'PLUGIN_INSTALL_FAILED' });
    const remoteArtifactPath = argv[argv.indexOf('--artifact') + 1];
    const uploaded = this.uploads.get(remoteArtifactPath);
    const result = await installRemoteArtifact({ artifactPath: uploaded.localPath, kind, id, version: argv[argv.indexOf('--version') + 1], expectedSha256: argv[argv.indexOf('--sha256') + 1], installRoot: this.installRoot, packageName: argv[argv.indexOf('--package-name') + 1], protocolVersion: argv[argv.indexOf('--protocol-version') + 1], target: argv[argv.indexOf('--target') + 1], linkType: this.linkType });
    return { stdout: JSON.stringify(result), stderr: '', code: 0 };
  }
}

test('Desired State sync uploads only remote requirements, is idempotent, and reconciles lost cleanup response', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-plugin-sync-'));
  try {
    const artifact = await makePlugin(root);
    const registry = new TrustedArtifactRegistry([{ kind: 'plugin', id: 'sync-plugin', version: '1.0.0', placement: 'remote', source: { registry: 'test-registry', artifact: artifact.artifactName }, sha256: artifact.sha256, size: artifact.size, packageName: 'dsh-sync-plugin', compatibility: { dsh: { min: DSH, max: DSH }, api: { min: API, max: API } }, artifactPath: artifact.artifactPath, manifest: { protocolVersion: '1.0' } }]);
    const transport = new FakePluginTransport();
    const synchronizer = new DesiredStateSynchronizer({ registry, transport, remoteRoot: '/home/test/.dsh-remote' });
    const result = await synchronizer.sync({ desiredState: desired(artifact), operationId: 'sync-op-001' });
    assert.equal(result.status, 'completed');
    assert.equal(result.items[0].status, 'installed');
    assert.equal(transport.uploads.length, 1);
    const install = transport.commands.find((argv) => argv.includes('--artifact'));
    assert.equal(install.some((value) => value.includes('plugins')), true);
    assert.equal(install.includes('--no-scripts'), true);

    const second = await synchronizer.sync({ desiredState: desired(artifact), operationId: 'sync-op-002' });
    assert.equal(second.status, 'completed');
    assert.equal(second.items[0].status, 'reused');
    assert.equal(transport.uploads.length, 1);

    transport.installed.clear();
    transport.dropCleanupResponse = true;
    const unknown = await synchronizer.sync({ desiredState: desired(artifact), operationId: 'sync-op-003' });
    assert.equal(unknown.status, 'needs-attention');
    assert.equal(unknown.rollback.status, 'completed');
    const reconciled = await synchronizer.reconcile('sync-op-003');
    assert.equal(reconciled.status, 'needs-attention');
    assert.equal(reconciled.rollback.status, 'completed');
    assert.equal(reconciled.targetStatus, 'not-current-or-unknown');
    assert.equal((await synchronizer.sync({ desiredState: desired(artifact), operationId: 'sync-op-003' })).status, 'completed');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('sync plan excludes control placement and arbitrary remote shell scripts', async () => {
  const transport = new FakePluginTransport();
  const registry = new TrustedArtifactRegistry([]);
  const synchronizer = new DesiredStateSynchronizer({ registry, transport, remoteRoot: '/home/test/.dsh-remote' });
  const state = { dshVersion: DSH, apiVersion: API, plugins: [{ id: 'control-only', version: '1.0.0', placement: 'control', source: { registry: 'trusted', artifact: 'control.tgz' }, sha256: 'a'.repeat(64), compatibility: { dsh: { min: DSH, max: DSH }, api: { min: API, max: API } }, requiredBy: ['project:control'] }], skills: [], runtimes: [], defaultPermission: 'workspace-write', modelRoute: 'local-gateway-required' };
  const result = await synchronizer.sync({ desiredState: state, operationId: 'control-op-001' });
  assert.equal(result.status, 'completed');
  assert.equal(result.items.length, 0);
  assert.equal(result.skipped[0].placement, 'control');
  assert.equal(transport.commands.length, 0);
});

test('plugin-owned Skill is bound to the plugin version and is not uploaded as a second artifact', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-plugin-bundle-'));
  try {
    const skillSha = 'c'.repeat(64);
    const artifact = await makePlugin(root, [{ id: 'bundled-skill', version: '1.0.0', sha256: skillSha }]);
    const registry = new TrustedArtifactRegistry([{ kind: 'plugin', id: 'sync-plugin', version: '1.0.0', placement: 'remote', source: { registry: 'test-registry', artifact: artifact.artifactName }, sha256: artifact.sha256, size: artifact.size, packageName: 'dsh-sync-plugin', compatibility: { dsh: { min: DSH, max: DSH }, api: { min: API, max: API } }, artifactPath: artifact.artifactPath, manifest: { protocolVersion: '1.0' } }]);
    const transport = new FakePluginTransport();
    const synchronizer = new DesiredStateSynchronizer({ registry, transport, remoteRoot: '/home/test/.dsh-remote' });
    const state = { ...desired(artifact), skills: [{ id: 'bundled-skill', version: '1.0.0', placement: 'remote', source: { registry: 'test-registry', artifact: 'bundled-skill.tgz' }, sha256: skillSha, compatibility: { dsh: { min: DSH, max: DSH }, api: { min: API, max: API } }, requiredBy: ['project:sync'], bundledWith: { pluginId: 'sync-plugin', pluginVersion: '1.0.0' } }] };
    const result = await synchronizer.sync({ desiredState: state, operationId: 'bundle-op-001' });
    assert.equal(result.status, 'completed');
    assert.equal(result.items.length, 1);
    assert.equal(result.skipped.some((item) => item.kind === 'skill' && item.bundledWith?.pluginId === 'sync-plugin'), true);
    assert.equal(transport.uploads.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('two-plugin project failure rolls back A in reverse order, preserves both A versions, and never calls Session Control', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-plugin-multi-rollback-'));
  try {
    const aOld = await makePlugin(root, { id: 'plugin-a', name: 'dsh-plugin-a', version: '1.0.0' });
    const aNew = await makePlugin(root, { id: 'plugin-a', name: 'dsh-plugin-a', version: '1.1.0' });
    const b = await makePlugin(root, { id: 'plugin-b', name: 'dsh-plugin-b', version: '1.0.0' });
    const compatibility = { dsh: { min: DSH, max: DSH }, api: { min: API, max: API } };
    const registry = new TrustedArtifactRegistry([aNew, b].map((artifact) => ({ kind: 'plugin', id: artifact.id, version: artifact.version, placement: 'remote', source: { registry: 'test-registry', artifact: artifact.artifactName }, sha256: artifact.sha256, size: artifact.size, packageName: artifact.name, compatibility, artifactPath: artifact.artifactPath, manifest: { protocolVersion: '1.0' } })));
    const installRoot = join(root, 'remote');
    const linkType = process.platform === 'win32' ? 'junction' : 'dir';
    await installRemoteArtifact({ ...aOld, expectedSha256: aOld.sha256, kind: 'plugin', id: 'plugin-a', installRoot, linkType });
    const daemon = await RemoteHostDaemon.create({ sessionControl: new FakeSessionControlPort() });
    const transport = new LocalInstallerTransport({ installRoot, daemon, linkType });
    transport.failInstallIds.add('plugin-b');
    const synchronizer = new DesiredStateSynchronizer({ registry, transport, remoteRoot: '/home/test/.dsh-remote' });
    const connector = new RemoteControlConnector({ transport, desiredStateSynchronizer: synchronizer, sourceHostId: 'local', sourceSessionId: 'controller' });
    await connector.connect();
    const state = {
      dshVersion: DSH,
      apiVersion: API,
      plugins: [
        { id: 'plugin-a', version: '1.1.0', placement: 'remote', source: { registry: 'test-registry', artifact: aNew.artifactName }, sha256: aNew.sha256, compatibility, requiredBy: ['project:multi'] },
        { id: 'plugin-b', version: '1.0.0', placement: 'remote', source: { registry: 'test-registry', artifact: b.artifactName }, sha256: b.sha256, compatibility, requiredBy: ['project:multi'] },
      ],
      skills: [], runtimes: [], defaultPermission: 'workspace-write', modelRoute: 'local-gateway-required',
    };
    const opened = await connector.openProject({ absolutePath: '/srv/multi-plugin', desiredState: state });
    assert.equal(opened.state, 'needs-attention');
    assert.equal(opened.error.code, 'PLUGIN_SYNC_NEEDS_ATTENTION');
    assert.equal(opened.result.pluginSync.rollback.status, 'completed');
    assert.equal((await inspectRemoteArtifact({ kind: 'plugin', id: 'plugin-a', installRoot })).version, '1.0.0');
    assert.equal((await stat(join(installRoot, 'plugins', 'plugin-a', 'versions', '1.0.0'))).isDirectory(), true);
    assert.equal((await stat(join(installRoot, 'plugins', 'plugin-a', 'versions', '1.1.0'))).isDirectory(), true);
    assert.equal((await inspectRemoteArtifact({ kind: 'plugin', id: 'plugin-b', installRoot })).status, 'missing');
    assert.equal(daemon.sessionControl.calls.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rollback response loss is reconciled through stable status to a completed rollback receipt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-plugin-rollback-unknown-'));
  try {
    const oldArtifact = await makePlugin(root, { id: 'plugin-a', name: 'dsh-plugin-a', version: '1.0.0' });
    const newArtifact = await makePlugin(root, { id: 'plugin-a', name: 'dsh-plugin-a', version: '1.1.0' });
    const compatibility = { dsh: { min: DSH, max: DSH }, api: { min: API, max: API } };
    const registry = new TrustedArtifactRegistry([{ kind: 'plugin', id: 'plugin-a', version: newArtifact.version, placement: 'remote', source: { registry: 'test-registry', artifact: newArtifact.artifactName }, sha256: newArtifact.sha256, size: newArtifact.size, packageName: newArtifact.name, compatibility, artifactPath: newArtifact.artifactPath, manifest: { protocolVersion: '1.0' } }]);
    const installRoot = join(root, 'remote');
    const linkType = process.platform === 'win32' ? 'junction' : 'dir';
    await installRemoteArtifact({ ...oldArtifact, expectedSha256: oldArtifact.sha256, kind: 'plugin', id: 'plugin-a', installRoot, linkType });
    const transport = new LocalInstallerTransport({ installRoot, linkType });
    transport.dropCleanupResponse = true;
    transport.dropRollbackResponse = true;
    const synchronizer = new DesiredStateSynchronizer({ registry, transport, remoteRoot: '/home/test/.dsh-remote' });
    const state = { dshVersion: DSH, apiVersion: API, plugins: [{ id: 'plugin-a', version: '1.1.0', placement: 'remote', source: { registry: 'test-registry', artifact: newArtifact.artifactName }, sha256: newArtifact.sha256, compatibility, requiredBy: ['project:rollback'] }], skills: [], runtimes: [], defaultPermission: 'workspace-write', modelRoute: 'local-gateway-required' };
    const result = await synchronizer.sync({ desiredState: state, operationId: 'rollback-unknown-001' });
    assert.equal(result.status, 'persistence-unknown');
    assert.equal(result.rollback.status, 'unknown');
    const reconciled = await synchronizer.reconcile('rollback-unknown-001');
    assert.equal(reconciled.status, 'needs-attention');
    assert.equal(reconciled.rollback.status, 'completed');
    assert.equal((await inspectRemoteArtifact({ kind: 'plugin', id: 'plugin-a', installRoot })).version, '1.0.0');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
