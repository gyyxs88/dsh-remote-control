import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { buildReverseTunnelArgs, buildStdioBridgeArgs, SshCommandTransport, SshStdioBridge } from '../lib/ssh.mjs';
import { ModelGateway } from '../lib/gateway.mjs';
import { DshRemoteError } from '../lib/errors.mjs';

test('SSH bridge and reverse tunnel pin the actual known_hosts key and fail closed on policy injection', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-ssh-pin-'));
  try {
    const publicKey = Buffer.from('stage-a-test-key').toString('base64');
    const fingerprint = `SHA256:${createHash('sha256').update(Buffer.from(publicKey, 'base64')).digest('base64url')}`;
    const knownHosts = join(root, 'known_hosts');
    await writeFile(knownHosts, `remote-stage-a ssh-ed25519 ${publicKey}\n`);
    const policy = { knownHostsFile: knownHosts, hostKeyAlias: 'remote-stage-a', expectedFingerprint: fingerprint };
    assert.throws(() => buildStdioBridgeArgs({ host: '-oProxyCommand=bad', policy }), DshRemoteError);
    assert.throws(() => buildStdioBridgeArgs({ host: 'user@example', policy: { ...policy, expectedFingerprint: 'SHA256:wrong' } }), DshRemoteError);
    const bridge = buildStdioBridgeArgs({ host: 'user@example', policy, dataDir: '/home/test/.dsh-remote/host' });
  assert.ok(bridge.includes('StrictHostKeyChecking=yes'));
  assert.ok(bridge.includes('HostKeyAlias=remote-stage-a'));
    assert.ok(bridge.at(-1).includes('dsh-remote-host'));
    assert.ok(bridge.at(-1).includes("'dsh-remote-host'"));
    assert.throws(() => buildStdioBridgeArgs({ host: 'user@example', policy, extraArgs: ['-o', 'ProxyCommand=bad'] }), DshRemoteError);
    const tunnel = buildReverseTunnelArgs({ host: 'user@example', policy, localPort: 18080, remotePort: 18081 });
  assert.ok(tunnel.includes('ExitOnForwardFailure=yes'));
  assert.ok(tunnel.includes('127.0.0.1:18081:127.0.0.1:18080'));
    assert.throws(() => buildReverseTunnelArgs({ host: 'user@example', policy, localPort: 18080, remotePort: 18081, bindAddress: '0.0.0.0' }), DshRemoteError);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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

test('SSH command transport enforces timeout and preserves quoted remote argv', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-ssh-transport-'));
  try {
    const publicKey = Buffer.from('stage-a-test-key').toString('base64');
    const fingerprint = `SHA256:${createHash('sha256').update(Buffer.from(publicKey, 'base64')).digest('base64url')}`;
    const knownHosts = join(root, 'known_hosts');
    await writeFile(knownHosts, `remote-stage-a ssh-ed25519 ${publicKey}\n`);
    const policy = { knownHostsFile: knownHosts, hostKeyAlias: 'remote-stage-a', expectedFingerprint: fingerprint };
    let captured;
    const spawnSuccess = (command, args) => {
      captured = { command, args };
      const child = new EventEmitter();
      child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.stdout.setEncoding = () => {}; child.stderr.setEncoding = () => {}; child.stdin = { end() {} }; child.kill = () => {};
      setTimeout(() => child.emit('exit', 0, null), 1);
      return child;
    };
    const transport = new SshCommandTransport({ policy, host: 'user@example', spawnImpl: spawnSuccess, commandTimeoutMs: 1000 });
    await transport.execArgv(['node', '/tmp/a path', '--value', "quote's	safe"]);
    assert.equal(captured.command, 'ssh');
    assert.match(captured.args.at(-1), /quote.*safe/u);
    const spawnTimeout = () => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.stdout.setEncoding = () => {}; child.stderr.setEncoding = () => {}; child.stdin = { end() {} }; child.kill = () => {};
      return child;
    };
    await assert.rejects(() => new SshCommandTransport({ policy, host: 'user@example', spawnImpl: spawnTimeout, commandTimeoutMs: 5 }).execArgv(['node', 'sleep']), (error) => error.code === 'TIMEOUT');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('SSH stdio bridge bounds frames, rejects unknown responses and resets on exit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-ssh-stdio-'));
  try {
    const publicKey = Buffer.from('stage-a-test-key').toString('base64');
    const fingerprint = `SHA256:${createHash('sha256').update(Buffer.from(publicKey, 'base64')).digest('base64url')}`;
    const knownHosts = join(root, 'known_hosts');
    await writeFile(knownHosts, `remote-stage-a ssh-ed25519 ${publicKey}\n`);
    const policy = { knownHostsFile: knownHosts, hostKeyAlias: 'remote-stage-a', expectedFingerprint: fingerprint };
    const children = [];
    const spawnImpl = () => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stdout.setEncoding = () => {};
      child.stdin = { write(payload) { child.payload = payload; } };
      child.kill = () => { child.killed = true; };
      children.push(child);
      return child;
    };
    const bridge = new SshStdioBridge({ policy, host: 'user@example', command: 'dsh-remote-host', dataDir: '/home/test/.dsh-remote/host', spawnImpl, requestTimeoutMs: 100, maxFrameBytes: 1024, maxPending: 2 });
    const first = bridge.request({ type: 'gateway.probe' });
    const child = children[0];
    await new Promise((resolve) => setImmediate(resolve));
    const request = JSON.parse(child.payload);
    child.stdout.emit('data', `${JSON.stringify({ id: 'unknown', response: {} })}\n`);
    child.stdout.emit('data', `${JSON.stringify({ id: request.id, response: { ok: true } })}\n`);
    assert.deepEqual(await first, { ok: true });
    child.stdout.emit('data', `${JSON.stringify({ id: request.id, response: { ok: true } })}\n`);
    assert.equal(bridge.protocolErrors, 2);
    const second = bridge.request({ type: 'gateway.probe' });
    child.emit('exit', 1, 'SIGTERM');
    await assert.rejects(second, (error) => error.code === 'SSH_BRIDGE_EXITED');
    await assert.rejects(() => bridge.request({ prompt: 'x'.repeat(2_000) }), (error) => error.code === 'SSH_BRIDGE_FRAME_TOO_LARGE');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
