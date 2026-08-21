import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { fingerprintSshKey, probeSshHostKeys, selectHostKey } from '../lib/ssh-discovery.mjs';

function fakeSpawn(responses) {
  return (command, args) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.killed = false;
    child.kill = () => { child.killed = true; };
    queueMicrotask(() => {
      const response = responses.shift();
      assert.equal(command, response.command);
      response.assertArgs?.(args);
      child.stdout.end(response.stdout ?? '');
      child.stderr.end(response.stderr ?? '');
      child.emit('exit', response.code ?? 0, null);
    });
    return child;
  };
}

test('SSH discovery resolves config, returns fingerprints, and requires an exact confirmation', async () => {
  const ed = Buffer.from('ssh-ed25519-fixture').toString('base64');
  const rsa = Buffer.from('ssh-rsa-fixture').toString('base64');
  const spawnImpl = fakeSpawn([
    { command: 'ssh', stdout: 'hostname 192.168.31.212\nuser leyi\nport 2222\n' },
    { command: 'ssh-keyscan', assertArgs: (args) => assert.deepEqual(args.slice(-2), ['ed25519,ecdsa,rsa', '192.168.31.212']), stdout: `[192.168.31.212]:2222 ssh-rsa ${rsa}\n[192.168.31.212]:2222 ssh-ed25519 ${ed}\n` },
  ]);
  const probe = await probeSshHostKeys('lan-dev-212', { spawnImpl });
  assert.equal(probe.resolved.user, 'leyi');
  assert.equal(probe.resolved.port, 2222);
  assert.equal(probe.candidates[0].keyType, 'ssh-ed25519');
  assert.equal(selectHostKey(probe, fingerprintSshKey(ed)).publicKey, ed);
  assert.throws(() => selectHostKey(probe, 'SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'), (error) => error.code === 'SSH_HOST_KEY_MISMATCH');
  assert.throws(() => selectHostKey(probe), (error) => error.code === 'SSH_HOST_KEY_CONFIRMATION_REQUIRED');
});
