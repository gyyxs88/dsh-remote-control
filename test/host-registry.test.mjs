import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { HostRegistry } from '../lib/host-registry.mjs';
import { buildManagedHostProfile } from '../lib/managed-host.mjs';
import { fingerprintSshKey } from '../lib/ssh-discovery.mjs';

const publicKey = Buffer.from('dsh-remote-host-registry-test-key').toString('base64');
const fingerprint = fingerprintSshKey(publicKey);

test('Host registry persists owner-scoped pins without credentials and preserves remote data on removal', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-host-registry-'));
  const registry = await HostRegistry.open({ stateDir: root });
  const knownHostsFile = await registry.stageKnownHost({ hostId: 'lan-212', hostKeyAlias: 'dsh-lan-212', keyType: 'ssh-ed25519', publicKey });
  const profile = buildManagedHostProfile({
    id: 'lan-212', sshTarget: 'lan-dev-212', hostname: '192.168.31.212', user: 'leyi', port: 22,
    hostKeyAlias: 'dsh-lan-212', expectedFingerprint: fingerprint,
    hostKey: { keyType: 'ssh-ed25519', publicKey, fingerprint }, knownHostsFile,
    system: { platform: 'linux', arch: 'x64', uid: 1000, home: '/home/leyi', nodeVersion: '24.12.0' },
    allowedRoot: '/home/leyi/Projects/demo', dshPort: 3183,
  });
  const added = await registry.add(profile);
  assert.equal(added.id, 'lan-212');
  assert.equal(registry.get('lan-dev-212').allowedRoot, '/home/leyi/Projects/demo');
  assert.match(await readFile(knownHostsFile, 'utf8'), /^dsh-lan-212 ssh-ed25519 /u);
  const persisted = await readFile(path.join(root, 'remote-hosts.json'), 'utf8');
  assert.doesNotMatch(persisted, /"(?:password|privateKey|token|cookie)"\s*:/iu);
  if (process.platform !== 'win32') {
    assert.equal((await stat(root)).mode & 0o777, 0o700);
    assert.equal((await stat(path.join(root, 'remote-hosts.json'))).mode & 0o777, 0o600);
    assert.equal((await stat(knownHostsFile)).mode & 0o777, 0o600);
  }
  await registry.add({ ...added, allowedRoot: '/home/leyi/Projects', updatedAt: new Date().toISOString() }, { replace: true });
  assert.equal(registry.get('lan-212').allowedRoot, '/home/leyi/Projects');
  const removed = await registry.remove('lan-212');
  assert.equal(removed.remoteRoot, '/home/leyi/.dsh-remote/lan-212');
  assert.equal(registry.list().length, 0);
  await assert.rejects(HostRegistry.open({ stateDir: root }), (error) => error.code === 'HOST_REGISTRY_LOCKED');
  await registry.close();
  const reopened = await HostRegistry.open({ stateDir: root });
  assert.equal(reopened.list().length, 0);
  await reopened.close();
});

test('Host registry rejects duplicate ids, duplicate SSH targets, and paths outside the probed home', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-host-registry-invalid-'));
  const registry = await HostRegistry.open({ stateDir: root });
  const knownHostsFile = await registry.stageKnownHost({ hostId: 'host-a', hostKeyAlias: 'dsh-host-a', keyType: 'ssh-ed25519', publicKey });
  const base = buildManagedHostProfile({ id: 'host-a', sshTarget: 'server-a', hostname: 'server-a', user: 'user', port: 22, hostKeyAlias: 'dsh-host-a', expectedFingerprint: fingerprint, hostKey: { keyType: 'ssh-ed25519', publicKey, fingerprint }, knownHostsFile, system: { platform: 'linux', arch: 'x64', uid: 1000, home: '/home/user', nodeVersion: '24.1.0' } });
  await registry.add(base);
  await assert.rejects(registry.add(base), (error) => error.code === 'HOST_ALREADY_REGISTERED');
  assert.throws(() => buildManagedHostProfile({ ...base, id: 'bad', remoteRoot: '/srv/dsh', system: { platform: 'linux', arch: 'x64', uid: 1000, home: '/home/user', nodeVersion: '24.1.0' } }), (error) => error.code === 'REMOTE_ROOT_OUTSIDE_HOME');
  await registry.close();
});
