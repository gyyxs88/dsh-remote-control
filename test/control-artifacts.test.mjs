import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ControlArtifactProvider } from '../lib/control-artifacts.mjs';

test('control artifact provider packs installed trusted sources without lifecycle scripts', async () => {
  const cacheDir = await mkdtemp(path.join(os.tmpdir(), 'dsh-control-artifacts-'));
  const provider = new ControlArtifactProvider({
    cacheDir,
    dshRecipeRoot: path.resolve('..'),
    sessionControlPackageRoot: path.resolve('..', 'dsh-session-control'),
    packageRoot: path.resolve('.'),
  });
  const artifacts = await provider.prepare();
  assert.equal(artifacts.dshVersion, '0.1.0-rc.6');
  assert.equal(artifacts.remoteHost.version, '0.2.0');
  assert.equal(artifacts.sessionControl.version, '0.6.4');
  assert.equal(artifacts.sessionControl.pluginRequirement.sha256, artifacts.sessionControl.sha256);
  assert.equal(artifacts.sessionControl.skillRequirement.bundledWith.pluginVersion, '0.6.4');
  const resolved = await artifacts.sessionControl.registry.resolve({ kind: 'plugin', ...artifacts.sessionControl.pluginRequirement }, { dshVersion: artifacts.dshVersion, apiVersion: artifacts.apiVersion });
  assert.equal(resolved.packageJson.name, 'dsh-session-control');
});
