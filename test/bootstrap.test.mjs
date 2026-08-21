import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createArtifactManifest, verifyTrustedArtifact, buildBootstrapPlan, ArtifactBootstrapper, sha256File } from '../lib/bootstrap.mjs';
import { DshRemoteError, TransportError } from '../lib/errors.mjs';

test('trusted artifact bootstrap verifies digest and uses atomic no-root argv', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-remote-bootstrap-'));
  try {
    const artifact = join(root, 'host-artifact.tgz');
    await writeFile(artifact, 'stage-a-artifact');
    const manifest = await createArtifactManifest({ filePath: artifact, version: '0.1.0' });
    const installerPath = fileURLToPath(new URL('../bin/dsh-remote-host-installer.mjs', import.meta.url));
    const installerSha256 = await sha256File(installerPath);
    const trustedCatalog = { '0.1.0': { version: manifest.version, name: manifest.name, sha256: manifest.sha256, size: manifest.size, target: manifest.target, protocolVersion: manifest.protocolVersion, installerSha256 } };
    const trusted = await verifyTrustedArtifact({ filePath: artifact, manifest, trustedCatalog });
    const plan = buildBootstrapPlan({ artifact: { ...trusted, installerSha256 }, remoteRoot: '/home/test/.dsh-remote' });
    assert.equal(plan.safety.noCurlPipeSh, true);
    assert.equal(plan.safety.noRoot, true);
    assert.ok(plan.commands[2].includes('--atomic'));
    assert.ok(plan.commands[2].includes('--sha256'));
    const calls = [];
    const bootstrapper = new ArtifactBootstrapper({ trustedCatalog, transport: {
      async upload(...args) { calls.push(['upload', ...args]); },
      async execArgv(argv) { calls.push(['exec', argv]); return { stdout: argv[0] === 'sha256sum' ? `${installerSha256}  ${argv[1]}\n` : argv.includes('--probe') ? JSON.stringify({ status: 'ok', component: 'dsh-remote-host', platform: 'linux', arch: 'x64' }) : '', stderr: '', code: 0 }; },
    } });
    const result = await bootstrapper.bootstrap({ filePath: artifact, version: '0.1.0', remoteRoot: '/home/test/.dsh-remote' });
    assert.equal(result.status, 'completed');
    assert.equal(calls[0][0], 'exec');
    assert.equal(calls[1][0], 'upload');
    assert.equal(calls[2][0], 'upload');
    assert.equal(calls[4][1].includes('--no-root'), true);
    await writeFile(artifact, 'tampered');
    await assert.rejects(() => verifyTrustedArtifact({ filePath: artifact, manifest, trustedCatalog }), DshRemoteError);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('bootstrap fails closed without a catalog and reconciles an unknown terminal state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-remote-bootstrap-unknown-'));
  try {
    const artifact = join(root, 'host-artifact.tgz');
    await writeFile(artifact, 'stage-a-artifact');
    const manifest = await createArtifactManifest({ filePath: artifact, version: '0.1.0' });
    const installerPath = fileURLToPath(new URL('../bin/dsh-remote-host-installer.mjs', import.meta.url));
    const installerSha256 = await sha256File(installerPath);
    const trustedCatalog = { '0.1.0': { version: manifest.version, name: manifest.name, sha256: manifest.sha256, size: manifest.size, target: manifest.target, protocolVersion: manifest.protocolVersion, installerSha256 } };
    const noCatalog = new ArtifactBootstrapper({ transport: { async upload() {}, async execArgv() { return { stdout: '', stderr: '', code: 0 }; } } });
    await assert.rejects(() => noCatalog.bootstrap({ filePath: artifact, version: '0.1.0', remoteRoot: '/home/test/.dsh-remote' }), (error) => error.code === 'ARTIFACT_NOT_TRUSTED');
    let calls = 0;
    let stagingRemoved = false;
    let reconcileArgv;
    const bootstrapper = new ArtifactBootstrapper({ trustedCatalog, transport: {
      async upload() {},
      async execArgv(argv) {
        calls += 1;
        if (argv.includes('--status')) {
          reconcileArgv = argv;
          return { stdout: JSON.stringify({ status: 'installed', version: '0.1.0', sha256: manifest.sha256 }), stderr: '', code: 0 };
        }
        if (argv[0] === 'rm') {
          stagingRemoved = true;
          throw new TransportError('response lost after remote cleanup completed');
        }
        if (argv[0] === 'sha256sum') return { stdout: `${installerSha256}  ${argv[1]}\n`, stderr: '', code: 0 };
        if (argv.includes('--probe')) return { stdout: JSON.stringify({ status: 'ok', component: 'dsh-remote-host', platform: 'linux', arch: 'x64' }), stderr: '', code: 0 };
        return { stdout: '', stderr: '', code: 0 };
      },
    } });
    await assert.rejects(() => bootstrapper.bootstrap({ filePath: artifact, version: '0.1.0', remoteRoot: '/home/test/.dsh-remote' }), (error) => error.code === 'NEEDS_ATTENTION');
    const operationId = [...bootstrapper.statuses.keys()][0];
    assert.equal(bootstrapper.status(operationId).status, 'needs-attention');
    assert.equal((await bootstrapper.reconcile(bootstrapper.status(operationId).plan)).status, 'completed');
    assert.equal(stagingRemoved, true);
    assert.equal(reconcileArgv[1], bootstrapper.status(operationId).plan.installedInstallerPath);
    assert.equal(reconcileArgv[1].includes('/staging/'), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
