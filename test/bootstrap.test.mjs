import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createArtifactManifest, verifyTrustedArtifact, buildBootstrapPlan, ArtifactBootstrapper } from '../lib/bootstrap.mjs';
import { DshRemoteError } from '../lib/errors.mjs';

test('trusted artifact bootstrap verifies digest and uses atomic no-root argv', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-remote-bootstrap-'));
  try {
    const artifact = join(root, 'host-artifact');
    await writeFile(artifact, 'stage-a-artifact');
    const manifest = await createArtifactManifest({ filePath: artifact, version: '0.1.0' });
    const trusted = await verifyTrustedArtifact({ filePath: artifact, manifest, trustedSha256: manifest.sha256 });
    const plan = buildBootstrapPlan({ artifact: trusted, remoteRoot: '/home/test/.dsh-remote' });
    assert.equal(plan.safety.noCurlPipeSh, true);
    assert.equal(plan.safety.noRoot, true);
    assert.ok(plan.commands[1].includes('--atomic'));
    assert.ok(plan.commands[1].includes('--sha256'));
    const calls = [];
    const bootstrapper = new ArtifactBootstrapper({ trustedSha256ByVersion: { '0.1.0': manifest.sha256 }, transport: {
      async upload(...args) { calls.push(['upload', ...args]); },
      async execArgv(argv) { calls.push(['exec', argv]); },
    } });
    const result = await bootstrapper.bootstrap({ filePath: artifact, version: '0.1.0', remoteRoot: '/home/test/.dsh-remote' });
    assert.equal(result.status, 'completed');
    assert.equal(calls[0][0], 'exec');
    assert.equal(calls[1][0], 'upload');
    assert.equal(calls[2][1].includes('--no-root'), true);
    await writeFile(artifact, 'tampered');
    await assert.rejects(() => verifyTrustedArtifact({ filePath: artifact, manifest, trustedSha256: manifest.sha256 }), DshRemoteError);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
