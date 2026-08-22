import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DshHostBootstrapper, createDshProfileConfig, writeDshProfileConfig } from '../lib/dsh-host-bootstrap.mjs';
import { sha256File } from '../lib/bootstrap.mjs';

const installerPath = fileURLToPath(new URL('../bin/dsh-remote-dsh-installer.mjs', import.meta.url));

function profileInput() {
  return {
    profileName: 'web',
    dshVersion: '0.1.1-rc.2',
    plugins: [{ id: 'dsh-session-control', packageName: 'dsh-session-control', version: '0.6.6', sha256: 'a'.repeat(64), packagePath: '/home/test/.dsh-remote/plugins/dsh-session-control/versions/0.6.6/package' }],
    sessionControl: {
      controllerSessionId: 'session-12345678-abcd',
      stateDir: '/home/test/.dsh-remote/session-control-state',
      sameWorkspaceOnly: false,
      socketPath: '/run/user/1000/dsh-session-control.sock',
      hostId: 'test-host',
      source: { sourceHostId: 'source-host', sourceSessionId: 'source-session', controllerSessionId: 'session-12345678-abcd' },
    },
  };
}

test('DSH 0.1.1-rc.2 installer pins lifecycle approval and requires an explicit peer closure', async () => {
  const source = await readFile(installerPath, 'utf8');
  assert.match(source, /dsh-subprocess-local', '0\.1\.1-rc\.2'/u);
  assert.match(source, /koffi', '3\.1\.6'/u);
  assert.match(source, /node-pty', '1\.2\.0-beta\.15'/u);
  assert.match(source, /DSH_RECIPE_PEER_CLOSURE_INVALID/u);
  assert.match(source, /packageJson\?\.allowScripts/u);
  assert.match(source, /\['ci', '--omit=dev', '--legacy-peer-deps'/u);
  assert.doesNotMatch(source, /dsh-subprocess-local', '0\.1\.0-rc\.[68]'/u);
});

test('DSH cold-host bootstrap uploads a trusted locked recipe and returns an exact receipt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-host-bootstrap-'));
  try {
    const recipePath = join(root, 'dsh-0.1.1-rc.2-lock.tgz');
    await writeFile(recipePath, 'locked-recipe');
    const recipeInfo = await stat(recipePath);
    const recipeSha256 = await sha256File(recipePath);
    const installerSha256 = await sha256File(installerPath);
    const calls = [];
    const transport = {
      async upload(local, remote) { calls.push(['upload', local, remote]); return { code: 0 }; },
      async execArgv(argv) {
        calls.push(['exec', ...argv]);
        if (argv[0] === 'sha256sum') return { stdout: `${installerSha256}  ${argv[1]}\n` };
        if (argv.includes('--recipe')) return { stdout: JSON.stringify({ status: 'installed', version: '0.1.1-rc.2', pnpmVersion: '11.19.0', serviceName: 'dsh-remote-test.service', port: 3181 }) };
        return { stdout: '' };
      },
    };
    const bootstrapper = new DshHostBootstrapper({
      transport,
      trustedCatalog: { '0.1.1-rc.2': { version: '0.1.1-rc.2', name: 'dsh-0.1.1-rc.2-lock.tgz', sha256: recipeSha256, size: recipeInfo.size, pnpmVersion: '11.19.0', installerSha256 } },
    });
    const result = await bootstrapper.install({ recipePath, version: '0.1.1-rc.2', pnpmVersion: '11.19.0', remoteRoot: '/home/test/.dsh-remote', dshHome: '/home/test/.dsh-remote/dsh-home', profileName: 'web', hostId: 'test-host', serviceName: 'dsh-remote-test.service', port: 3181, operationId: 'bootstrap-operation-1' });
    assert.equal(result.status, 'completed');
    assert.equal(result.result.version, '0.1.1-rc.2');
    assert.equal(calls.filter((call) => call[0] === 'upload').length, 2);
    assert.ok(calls.some((call) => call.includes('--pnpm-version') && call.includes('11.19.0')));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('DSH profile config binds immutable plugin receipts and the exact remote controller', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-profile-config-'));
  try {
    const configPath = join(root, 'profile.json');
    const input = profileInput();
    const direct = createDshProfileConfig(input);
    const written = await writeDshProfileConfig(configPath, input);
    assert.deepEqual(written.config, direct);
    assert.match(written.sha256, /^[a-f0-9]{64}$/u);
    assert.equal(JSON.parse(await readFile(configPath, 'utf8')).sessionControl.source.controllerSessionId, 'session-12345678-abcd');
    assert.throws(() => createDshProfileConfig({ ...input, sessionControl: { ...input.sessionControl, source: { ...input.sessionControl.source, controllerSessionId: 'session-different-1234' } } }), /exact target controller/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('DSH profile activation uploads only the generated config and trusted installer', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-profile-activation-'));
  try {
    const profileConfigPath = join(root, 'profile.json');
    const { sha256 } = await writeDshProfileConfig(profileConfigPath, profileInput());
    const installerSha256 = await sha256File(installerPath);
    const uploads = [];
    const bootstrapper = new DshHostBootstrapper({ transport: {
      async upload(local, remote) { uploads.push([local, remote]); return { code: 0 }; },
      async execArgv(argv) {
        if (argv[0] === 'sha256sum') return { stdout: `${installerSha256}  ${argv[1]}\n` };
        if (argv.includes('--configure')) return { stdout: JSON.stringify({ status: 'configured', sha256, serviceName: 'dsh-remote-test.service', port: 3181 }) };
        return { stdout: '' };
      },
    }, trustedCatalog: { '0.1.1-rc.2': { installerSha256 } } });
    const result = await bootstrapper.configure({ profileConfigPath, remoteRoot: '/home/test/.dsh-remote', dshHome: '/home/test/.dsh-remote/dsh-home', profileName: 'web', serviceName: 'dsh-remote-test.service', port: 3181, operationId: 'profile-operation-1' });
    assert.equal(result.status, 'completed');
    assert.equal(uploads.length, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});
