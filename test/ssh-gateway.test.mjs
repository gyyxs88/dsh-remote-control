import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReverseTunnelArgs, buildStdioBridgeArgs } from '../lib/ssh.mjs';
import { ModelGateway } from '../lib/gateway.mjs';
import { DshRemoteError } from '../lib/errors.mjs';

const policy = { knownHostsFile: 'C:/safe/known_hosts', hostKeyAlias: 'remote-stage-a', expectedFingerprint: 'SHA256:abc123' };

test('SSH bridge and reverse tunnel fail closed on host-key and bind policy', () => {
  assert.throws(() => buildStdioBridgeArgs({ host: 'example', policy: { knownHostsFile: 'C:/safe/known_hosts', hostKeyAlias: 'remote' } }), DshRemoteError);
  const bridge = buildStdioBridgeArgs({ host: 'user@example', policy });
  assert.ok(bridge.includes('StrictHostKeyChecking=yes'));
  assert.ok(bridge.includes('HostKeyAlias=remote-stage-a'));
  assert.ok(bridge.includes('dsh-remote-host'));
  const tunnel = buildReverseTunnelArgs({ host: 'user@example', policy, localPort: 18080, remotePort: 18081 });
  assert.ok(tunnel.includes('ExitOnForwardFailure=yes'));
  assert.ok(tunnel.includes('127.0.0.1:18081:127.0.0.1:18080'));
  assert.throws(() => buildReverseTunnelArgs({ host: 'user@example', policy, localPort: 18080, remotePort: 18081, bindAddress: '0.0.0.0' }), DshRemoteError);
});

test('Model Gateway exposes only loopback and validates host-scoped model access', async () => {
  const gateway = new ModelGateway({ provider: {
    async listModels() { return ['test-model']; },
    async generate({ prompt, hostId }) { return { text: `${hostId}:${prompt}` }; },
  } });
  const address = await gateway.listen();
  assert.equal(address.host, '127.0.0.1');
  const token = gateway.issueHostToken('remote-host');
  const unauthorized = await fetch(`${address.endpoint}/v1/models`);
  assert.equal(unauthorized.status, 401);
  const models = await fetch(`${address.endpoint}/v1/models`, { headers: { authorization: `Bearer ${token.token}` } });
  assert.deepEqual(await models.json(), { models: ['test-model'] });
  const generated = await fetch(`${address.endpoint}/v1/generate`, { method: 'POST', headers: { authorization: `Bearer ${token.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'test-model', prompt: 'hello' }) });
  assert.deepEqual(await generated.json(), { result: { text: 'remote-host:hello' }, hostId: 'remote-host' });
  const badModel = await fetch(`${address.endpoint}/v1/generate`, { method: 'POST', headers: { authorization: `Bearer ${token.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'unknown', prompt: 'hello' }) });
  assert.equal(badModel.status, 403);
  await gateway.close();
});
