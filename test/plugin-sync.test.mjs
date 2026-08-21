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

const execFile = promisify(execFileCallback);
const DSH = '0.1.0-rc.6';
const API = '1.0';

async function makePlugin(root, bundledSkills = []) {
  const packageRoot = join(root, 'package');
  await mkdir(packageRoot, { recursive: true });
  await writeFile(join(packageRoot, 'package.json'), `${JSON.stringify({ name: 'dsh-sync-plugin', version: '1.0.0', dsh: { remote: { pluginId: 'sync-plugin', version: '1.0.0', placements: ['remote'], protocolVersion: '1.0', bundledSkills } } }, null, 2)}\n`);
  await writeFile(join(packageRoot, 'index.mjs'), 'export const synced = true\n');
  const artifactPath = join(root, 'dsh-sync-plugin-1.0.0.tgz');
  await execFile('tar', ['-czf', artifactPath, '-C', root, 'package']);
  const bytes = await readFile(artifactPath);
  return { artifactPath, sha256: createHash('sha256').update(bytes).digest('hex'), size: (await stat(artifactPath)).size, artifactName: basename(artifactPath) };
}

function desired(artifact) {
  return {
    dshVersion: DSH,
    apiVersion: API,
    plugins: [{ id: 'sync-plugin', version: '1.0.0', placement: 'remote', source: { registry: 'test-registry', artifact: artifact.artifactName }, sha256: artifact.sha256, compatibility: { dsh: { min: DSH, max: DSH }, api: { min: API, max: API } }, requiredBy: ['project:sync'] }],
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
    if (argv.includes('--status') || argv.includes('--probe')) {
      const value = this.installed.get(key);
      return { stdout: JSON.stringify(value ?? { status: 'missing', kind, id }), stderr: '', code: 0 };
    }
    const version = argv[argv.indexOf('--version') + 1];
    const sha256 = argv[argv.indexOf('--sha256') + 1];
    const packageName = argv[argv.indexOf('--package-name') + 1];
    const value = { status: 'installed', kind, id, version, sha256, packageName, size: 1 };
    this.installed.set(key, value);
    return { stdout: JSON.stringify(value), stderr: '', code: 0 };
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
    assert.equal(unknown.status, 'persistence-unknown');
    const reconciled = await synchronizer.reconcile('sync-op-003');
    assert.equal(reconciled.status, 'completed');
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
