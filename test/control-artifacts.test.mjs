import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ControlArtifactProvider, validateDshRecipeLock } from '../lib/control-artifacts.mjs';

test('DSH recipe requires an exact top-level closure for every non-optional peer', () => {
  const packageJson = { private: true, dependencies: { '@deepseek-ai/dsh': '0.1.0-rc.8', '@deepseek-ai/required-peer': '0.1.0-rc.8' } };
  const packageLock = { lockfileVersion: 3, packages: {
    '': { dependencies: { ...packageJson.dependencies } },
    'node_modules/@deepseek-ai/dsh': { version: '0.1.0-rc.8', peerDependencies: { '@deepseek-ai/required-peer': '^0.1.0-rc.8' } },
    'node_modules/@deepseek-ai/required-peer': { version: '0.1.0-rc.8' },
  } };
  assert.doesNotThrow(() => validateDshRecipeLock(packageJson, packageLock, '0.1.0-rc.8'));
  const missing = structuredClone(packageJson);
  delete missing.dependencies['@deepseek-ai/required-peer'];
  assert.throws(() => validateDshRecipeLock(missing, packageLock, '0.1.0-rc.8'), (error) => error.code === 'CONTROL_DSH_RECIPE_INVALID' || error.code === 'CONTROL_DSH_RECIPE_PEER_CLOSURE_INVALID');
});

test('control artifact provider packs installed trusted sources without lifecycle scripts', async () => {
  const cacheDir = await mkdtemp(path.join(os.tmpdir(), 'dsh-control-artifacts-'));
  const provider = new ControlArtifactProvider({
    cacheDir,
    dshRecipeRoot: path.resolve('..'),
    sessionControlPackageRoot: path.resolve('..', 'dsh-session-control'),
    packageRoot: path.resolve('.'),
  });
  const artifacts = await provider.prepare();
  assert.equal(artifacts.dshVersion, '0.1.0-rc.8');
  assert.equal(artifacts.remoteHost.version, '0.2.1');
  assert.equal(artifacts.sessionControl.version, '0.6.5');
  assert.equal(artifacts.sessionControl.pluginRequirement.sha256, artifacts.sessionControl.sha256);
  assert.equal(artifacts.sessionControl.skillRequirement.bundledWith.pluginVersion, '0.6.5');
  const resolved = await artifacts.sessionControl.registry.resolve({ kind: 'plugin', ...artifacts.sessionControl.pluginRequirement }, { dshVersion: artifacts.dshVersion, apiVersion: artifacts.apiVersion });
  assert.equal(resolved.packageJson.name, 'dsh-session-control');
});
