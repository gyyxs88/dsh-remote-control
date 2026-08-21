import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile, mkdir, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { promisify } from 'node:util';
import { validateDesiredState, validatePluginRequirement } from '../lib/desired-state.mjs';
import { TrustedArtifactRegistry } from '../lib/desired-state-registry.mjs';
import { DshRemoteError, ProtocolError } from '../lib/errors.mjs';

const execFile = promisify(execFileCallback);
const DSH = '0.1.0-rc.6';
const API = '1.0';

async function makeTgz(root, { name = 'dsh-test-plugin', version = '1.0.0', id = 'test-plugin', skill = false, lifecycle = false } = {}) {
  const packageRoot = join(root, 'package');
  await mkdir(packageRoot, { recursive: true });
  const manifest = skill
    ? { skillId: id, version }
    : { pluginId: id, version, placements: ['remote'], protocolVersion: '1.0', bundledSkills: [] };
  await writeFile(join(packageRoot, 'package.json'), `${JSON.stringify({ name, version, scripts: lifecycle ? { install: 'echo forbidden' } : { test: 'echo ok' }, dsh: skill ? { skill: manifest } : { remote: manifest } }, null, 2)}\n`);
  if (skill) await writeFile(join(packageRoot, 'SKILL.md'), '# test skill\n');
  else await writeFile(join(packageRoot, 'index.mjs'), 'export const ok = true\n');
  const artifactPath = join(root, `${name}-${version}.tgz`);
  await execFile('tar', ['-czf', artifactPath, '-C', root, 'package']);
  return artifactPath;
}

async function sha256File(filePath) {
  return createHash('sha256').update(await readFile(filePath)).digest('hex');
}

function compatibility() {
  return { dsh: { min: DSH, max: DSH }, api: { min: API, max: API } };
}

function requirement({ id = 'test-plugin', version = '1.0.0', placement = 'remote', sourceArtifact, sha256, compatibility: range = compatibility() } = {}) {
  return { id, version, placement, source: { registry: 'test-registry', artifact: sourceArtifact }, sha256, compatibility: range, requiredBy: ['project:test'] };
}

test('Desired State is versioned and only remote/both requirements are eligible for sync', () => {
  const state = validateDesiredState({ dshVersion: DSH, apiVersion: API, plugins: [requirement({ sourceArtifact: 'control.tgz', sha256: 'a'.repeat(64), placement: 'control' }), requirement({ id: 'remote-plugin', sourceArtifact: 'remote.tgz', sha256: 'b'.repeat(64), placement: 'both' })], skills: [], runtimes: [], defaultPermission: 'workspace-write', modelRoute: 'local-gateway-required' });
  assert.equal(state.plugins[0].placement, 'control');
  assert.equal(state.plugins[1].placement, 'both');
  assert.deepEqual(state.plugins[1].requiredBy, ['project:test']);
});

test('plugin and bundled Skill may share the same id and version while same-kind duplicates remain forbidden', () => {
  const shared = requirement({ id: 'dsh-session-control', sourceArtifact: 'dsh-session-control-0.6.0.tgz', sha256: 'a'.repeat(64) });
  const state = validateDesiredState({
    dshVersion: DSH,
    apiVersion: API,
    plugins: [shared],
    skills: [{ ...shared, bundledWith: { pluginId: shared.id, pluginVersion: shared.version } }],
    runtimes: [],
    defaultPermission: 'workspace-write',
    modelRoute: 'local-gateway-required',
  });
  assert.equal(state.plugins[0].id, state.skills[0].id);
  assert.throws(() => validateDesiredState({
    dshVersion: DSH,
    apiVersion: API,
    plugins: [shared, shared],
    skills: [],
    runtimes: [],
    defaultPermission: 'workspace-write',
    modelRoute: 'local-gateway-required',
  }), ProtocolError);
});

test('missing digest, unsafe requirement and incompatible ranges fail closed', () => {
  assert.throws(() => validatePluginRequirement({ ...requirement({ sourceArtifact: 'x.tgz', sha256: undefined }), sha256: undefined }), ProtocolError);
  assert.throws(() => validatePluginRequirement({ ...requirement({ sourceArtifact: 'x.tgz', sha256: 'a'.repeat(64) }), placement: 'anywhere' }), ProtocolError);
  assert.throws(() => validatePluginRequirement({ ...requirement({ sourceArtifact: 'x.tgz', sha256: 'a'.repeat(64) }), compatibility: { dsh: { min: DSH, max: DSH }, api: { min: '1.1', max: '1.0' } } }), ProtocolError);
});

test('trusted registry verifies real tgz identity, digest, manifest, and rejects unknown/incompatible/lifecycle artifacts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-desired-state-'));
  try {
    const artifactPath = await makeTgz(root);
    const artifactName = basename(artifactPath);
    const sha256 = await sha256File(artifactPath);
    const entry = { kind: 'plugin', id: 'test-plugin', version: '1.0.0', placement: 'remote', source: { registry: 'test-registry', artifact: artifactName }, sha256, size: (await stat(artifactPath)).size, packageName: 'dsh-test-plugin', compatibility: compatibility(), artifactPath, manifest: { protocolVersion: '1.0' } };
    const registry = new TrustedArtifactRegistry([entry]);
    const resolved = await registry.resolve({ kind: 'plugin', ...requirement({ sourceArtifact: artifactName, sha256 }) }, { dshVersion: DSH, apiVersion: API });
    assert.equal(resolved.verified, true);
    const skillPath = await makeTgz(root, { name: 'dsh-project-skill', id: 'project-skill', skill: true });
    const skillName = basename(skillPath);
    const skillSha = await sha256File(skillPath);
    const skillStat = await stat(skillPath);
    const skillRegistry = new TrustedArtifactRegistry([{ kind: 'skill', id: 'project-skill', version: '1.0.0', placement: 'remote', source: { registry: 'test-registry', artifact: skillName }, sha256: skillSha, size: skillStat.size, packageName: 'dsh-project-skill', compatibility: compatibility(), artifactPath: skillPath }]);
    const resolvedSkill = await skillRegistry.resolve({ kind: 'skill', ...requirement({ id: 'project-skill', sourceArtifact: skillName, sha256: skillSha }) }, { dshVersion: DSH, apiVersion: API });
    assert.equal(resolvedSkill.packageJson.dsh.skill.skillId, 'project-skill');
    await assert.rejects(() => registry.resolve({ kind: 'plugin', ...requirement({ id: 'unknown-plugin', sourceArtifact: artifactName, sha256 }) }, { dshVersion: DSH, apiVersion: API }), (error) => error.code === 'PLUGIN_NOT_ALLOWLISTED');
    await assert.rejects(() => registry.resolve({ kind: 'plugin', ...requirement({ sourceArtifact: artifactName, sha256, compatibility: { dsh: { min: '0.2.0', max: '0.2.0' }, api: { min: API, max: API } } }) }, { dshVersion: DSH, apiVersion: API }), (error) => error.code === 'PLUGIN_INCOMPATIBLE');
    const lifecyclePath = await makeTgz(root, { name: 'dsh-lifecycle-plugin', id: 'lifecycle-plugin', lifecycle: true });
    const lifecycleName = basename(lifecyclePath);
    const lifecycleSha = await sha256File(lifecyclePath);
    const lifecycleStat = await stat(lifecyclePath);
    const lifecycleRegistry = new TrustedArtifactRegistry([{ ...entry, id: 'lifecycle-plugin', packageName: 'dsh-lifecycle-plugin', artifactPath: lifecyclePath, source: { registry: 'test-registry', artifact: lifecycleName }, sha256: lifecycleSha, size: lifecycleStat.size }]);
    await assert.rejects(() => lifecycleRegistry.resolve({ kind: 'plugin', ...requirement({ id: 'lifecycle-plugin', sourceArtifact: lifecycleName, sha256: lifecycleSha }) }, { dshVersion: DSH, apiVersion: API }), (error) => error.code === 'PLUGIN_INSTALL_SCRIPT_FORBIDDEN');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
