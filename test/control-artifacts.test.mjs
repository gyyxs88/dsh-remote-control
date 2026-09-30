import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { ControlArtifactProvider, validateDshRecipeLock, validateSessionControlRemotePackage } from '../lib/control-artifacts.mjs';

test('DSH recipe requires an exact top-level closure for every non-optional peer', () => {
  const packageJson = { private: true, dependencies: { '@deepseek-ai/dsh': '0.1.5-rc.2', '@deepseek-ai/required-peer': '0.1.5-rc.2' } };
  const packageLock = { lockfileVersion: 3, packages: {
    '': { dependencies: { ...packageJson.dependencies } },
    'node_modules/@deepseek-ai/dsh': { version: '0.1.5-rc.2', peerDependencies: { '@deepseek-ai/required-peer': '^0.1.5-rc.2' } },
    'node_modules/@deepseek-ai/required-peer': { version: '0.1.5-rc.2' },
  } };
  assert.doesNotThrow(() => validateDshRecipeLock(packageJson, packageLock, '0.1.5-rc.2'));
  const missing = structuredClone(packageJson);
  delete missing.dependencies['@deepseek-ai/required-peer'];
  assert.throws(() => validateDshRecipeLock(missing, packageLock, '0.1.5-rc.2'), (error) => error.code === 'CONTROL_DSH_RECIPE_INVALID' || error.code === 'CONTROL_DSH_RECIPE_PEER_CLOSURE_INVALID');
});

test('desktop rc.2 session-control cannot be prepared for the old remote DSH before any pack or SSH work', async () => {
  const sessionControlPackageRoot = path.resolve('..', 'dsh-session-control');
  const packageJson = JSON.parse(await readFile(path.join(sessionControlPackageRoot, 'package.json'), 'utf8'));
  assert.match(packageJson.version, /^0\.8\.\d+$/u);
  assert.deepEqual(packageJson.dsh.remote.dshCompatibility, { min: '0.2.0-rc.2', max: '0.2.0-rc.2' });
  assert.equal(validateSessionControlRemotePackage(packageJson, '0.2.0-rc.2', '1.0').version, packageJson.version);
  assert.throws(() => validateSessionControlRemotePackage(packageJson, '0.1.5-rc.2', '1.0'), (error) => error.code === 'CONTROL_SESSION_CONTROL_INCOMPATIBLE');
  let spawned = false;
  const cacheDir = path.resolve('temp', `unused-incompatible-artifacts-${randomUUID()}`);
  const provider = new ControlArtifactProvider({
    cacheDir,
    dshRecipeRoot: path.resolve('test', 'fixtures', 'dsh-recipe'),
    sessionControlPackageRoot,
    packageRoot: path.resolve('.'),
    spawnImpl() { spawned = true; throw new Error('pack must not start'); },
  });
  await assert.rejects(provider.prepare(), (error) => error.code === 'CONTROL_SESSION_CONTROL_INCOMPATIBLE');
  assert.equal(spawned, false);
  assert.equal(existsSync(cacheDir), false);
});

test('remote package compatibility is taken from its own manifest', () => {
  const packageJson = { name: 'dsh-session-control', version: '0.8.2', dsh: { remote: {
    manifestVersion: '1.0', pluginId: 'dsh-session-control', version: '0.8.2', placements: ['remote'],
    protocolVersion: '1.0', apiVersion: '1.0', dshCompatibility: { min: '0.1.5-rc.2', max: '0.1.5-rc.2' },
    bundledSkills: [{ id: 'dsh-session-control', version: '0.8.2', sha256: 'a'.repeat(64) }],
  } }, peerDependencies: { '@deepseek-ai/dsh-agent': '0.1.5-rc.2', '@deepseek-ai/dsh-tools': '>=0.1.0-rc.6 || 0.1.5-rc.2' } };
  assert.equal(validateSessionControlRemotePackage(packageJson, '0.1.5-rc.2', '1.0').version, '0.8.2');
  assert.throws(() => validateSessionControlRemotePackage(packageJson, '0.2.0-rc.2', '1.0'), (error) => error.code === 'CONTROL_SESSION_CONTROL_INCOMPATIBLE');
  assert.throws(() => validateSessionControlRemotePackage(packageJson, '0.1.5-rc.2', '2.0'), (error) => error.code === 'CONTROL_SESSION_CONTROL_INCOMPATIBLE');
  packageJson.peerDependencies['@deepseek-ai/dsh-agent'] = '0.1.7-rc.1';
  assert.throws(() => validateSessionControlRemotePackage(packageJson, '0.1.5-rc.2', '1.0'), (error) => error.code === 'CONTROL_SESSION_CONTROL_PEER_INCOMPATIBLE');
});
