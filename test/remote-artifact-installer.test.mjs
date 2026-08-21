import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import { installRemoteArtifact, inspectRemoteArtifact } from '../lib/remote-artifact-installer.mjs';

const execFile = promisify(execFileCallback);

async function makeArtifact(root, version) {
  const packageRoot = join(root, 'package');
  await mkdir(packageRoot, { recursive: true });
  await writeFile(join(packageRoot, 'package.json'), `${JSON.stringify({ name: 'dsh-atomic-plugin', version, dsh: { remote: { pluginId: 'atomic-plugin', version, placements: ['remote'], protocolVersion: '1.0', bundledSkills: [] } } }, null, 2)}\n`);
  await writeFile(join(packageRoot, 'index.mjs'), `export const version = ${JSON.stringify(version)}\n`);
  const artifactPath = join(root, `dsh-atomic-plugin-${version}.tgz`);
  await execFile('tar', ['-czf', artifactPath, '-C', root, 'package']);
  const bytes = await readFile(artifactPath);
  return { artifactPath, version, packageName: 'dsh-atomic-plugin', sha256: createHash('sha256').update(bytes).digest('hex'), size: (await stat(artifactPath)).size };
}

test('remote artifact installer uses temp extraction and atomic current switch while retaining verified old versions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-artifact-installer-'));
  try {
    const v1 = await makeArtifact(root, '1.0.0');
    const v2 = await makeArtifact(root, '1.1.0');
    const linkType = process.platform === 'win32' ? 'junction' : 'dir';
    const first = await installRemoteArtifact({ ...v1, expectedSha256: v1.sha256, kind: 'plugin', id: 'atomic-plugin', installRoot: join(root, 'remote'), linkType });
    assert.equal(first.status, 'installed');
    const second = await installRemoteArtifact({ ...v2, expectedSha256: v2.sha256, kind: 'plugin', id: 'atomic-plugin', installRoot: join(root, 'remote'), linkType });
    assert.equal(second.status, 'installed');
    const status = await inspectRemoteArtifact({ kind: 'plugin', id: 'atomic-plugin', installRoot: join(root, 'remote') });
    assert.equal(status.version, '1.1.0');
    assert.equal(status.sha256, v2.sha256);
    const oldManifest = await readFile(join(root, 'remote', 'plugins', 'atomic-plugin', 'versions', '1.0.0', 'manifest.json'), 'utf8');
    assert.match(oldManifest, /"version": "1\.0\.0"/u);
    assert.equal((await lstat(join(root, 'remote', 'plugins', 'atomic-plugin', 'current'))).isSymbolicLink(), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
