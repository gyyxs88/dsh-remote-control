import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import test from 'node:test';
import { buildDesiredState, deriveRuntimeRequirements, validateChannelRuntimeDeclaration } from '../lib/runtime-requirement.mjs';

const DSH = '0.1.0-rc.8';
const API = '1.0';
const COMPATIBILITY = { dsh: { min: DSH, max: DSH }, api: { min: API, max: API } };

async function channelManifest(name) {
  const configuredRoot = process.env.DSH_SUBAGENT_CODE_AGENTS_ROOT;
  if (configuredRoot !== undefined && !isAbsolute(configuredRoot)) throw new Error('DSH_SUBAGENT_CODE_AGENTS_ROOT must be an absolute path');
  const filePath = configuredRoot
    ? join(configuredRoot, 'packages', `channel-${name}`, 'package.json')
    : new URL(`./fixtures/channel-runtime/${name}.json`, import.meta.url);
  return JSON.parse(await readFile(filePath, 'utf8'));
}

function catalogEntry(id, driver, capabilities, packageName, executablePath, version = '2.4.1', sha256 = 'a'.repeat(64)) {
  return {
    kind: 'runtime', id, version, placement: 'remote',
    source: { registry: 'admin-runtime-catalog', artifact: `${id.replaceAll('/', '-')}-${version}.tgz` },
    sha256, size: 1234, target: 'linux-x86_64', packageName, executablePath,
    protocolVersion: '1.0', driver, authPolicy: driver === 'codex' ? 'remote-user' : 'driver-defined', capabilities, compatibility: COMPATIBILITY,
  };
}

test('actual subagent channel manifests are declarations, not vendor artifact identities', async () => {
  const codexPackage = await channelManifest('codex');
  const claudePackage = await channelManifest('claude-code');
  assert.equal(codexPackage.dsh.remote.runtime, undefined);
  assert.equal(codexPackage.dsh.remote.channelRuntime.version, undefined);
  assert.equal(claudePackage.dsh.remote.channelRuntime.version, undefined);
  assert.equal(validateChannelRuntimeDeclaration(codexPackage.dsh.remote.channelRuntime).runtimeId, 'codex');
  assert.equal(validateChannelRuntimeDeclaration(claudePackage.dsh.remote.channelRuntime).driver, 'claude-code');
});

test('selected channels automatically become exact runtime requirements from the trusted catalog', async () => {
  const codexPackage = await channelManifest('codex');
  const claudePackage = await channelManifest('claude-code');
  const channels = [
    { channelId: 'codex', pluginId: 'project-agent', manifest: codexPackage },
    { channelId: 'claude-code', pluginId: 'project-agent', manifest: claudePackage },
  ];
  const trustedCatalog = [
    catalogEntry('codex', 'codex', ['exec', 'app-server', 'approval-requests'], 'dsh-runtime-codex', 'bin/codex'),
    catalogEntry('codex', 'codex', ['exec', 'app-server', 'approval-requests'], 'dsh-runtime-codex', 'bin/codex', '2.3.0', 'b'.repeat(64)),
    catalogEntry('claude-code', 'claude-code', ['headless', 'agent-sdk', 'approval-callback'], 'dsh-runtime-claude-code', 'bin/claude'),
  ];
  assert.throws(() => buildDesiredState({ dshVersion: DSH, apiVersion: API, channels, trustedCatalog, defaultPermission: 'read-only', modelRoute: 'local-gateway-required' }), /administrator pin is required/);
  const desired = buildDesiredState({ dshVersion: DSH, apiVersion: API, channels, trustedCatalog, channelPins: { codex: { version: '2.4.1', sha256: 'a'.repeat(64) } }, defaultPermission: 'read-only', modelRoute: 'local-gateway-required' });
  assert.deepEqual(desired.runtimes.map((item) => `${item.id}@${item.version}`), ['codex@2.4.1', 'claude-code@2.4.1']);
  assert.ok(desired.runtimes.every((item) => item.sha256 === 'a'.repeat(64) && item.requiredBy.includes('plugin:project-agent')));
  assert.throws(() => buildDesiredState({ dshVersion: DSH, apiVersion: API, channels, trustedCatalog, runtimes: desired.runtimes, defaultPermission: 'read-only', modelRoute: 'local-gateway-required' }), /derived from selected channels/);
  assert.throws(() => deriveRuntimeRequirements({ dshVersion: DSH, apiVersion: API, channels, trustedCatalog: trustedCatalog.slice(0, 1) }), /absent or incompatible/);
  const rollback = deriveRuntimeRequirements({ dshVersion: DSH, apiVersion: API, channels: [channels[0]], trustedCatalog, channelPins: { codex: { version: '2.3.0', sha256: 'b'.repeat(64) } } });
  assert.equal(rollback[0].version, '2.3.0');
});
