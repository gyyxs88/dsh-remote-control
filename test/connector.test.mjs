import test from 'node:test';
import assert from 'node:assert/strict';
import { RemoteHostDaemon } from '../lib/remote-host.mjs';
import { FakeSessionControlPort } from '../lib/session-control-port.mjs';
import { FakeTransport, MemoryConnectorCache, RemoteControlConnector } from '../lib/connector.mjs';
import { NeedsAttentionError, TransportError } from '../lib/errors.mjs';
import { createInitialHostState, MemoryStateStore } from '../lib/state-store.mjs';
import { ModelGateway } from '../lib/gateway.mjs';

const desiredState = { dshVersion: '0.1.0-rc.6', plugins: [], skills: [], runtimes: [], defaultPermission: 'workspace-write', modelRoute: 'local-gateway-required' };

test('connector reconciles a response lost after remote operation completed', async () => {
  const daemon = await RemoteHostDaemon.create({ sessionControl: new FakeSessionControlPort() });
  const transport = new FakeTransport(daemon);
  const connector = new RemoteControlConnector({ transport, cache: new MemoryConnectorCache(), sourceHostId: 'local', sourceSessionId: 'controller' });
  await connector.connect();
  transport.dropNextResponse = true;
  await assert.rejects(() => connector.openProject({ absolutePath: '/srv/project', desiredState: desiredState, idempotencyKey: 'stable-project' }), TransportError);
  const reconciled = await connector.reconcile();
  assert.equal(reconciled.accepted, true);
  const operations = await connector.listOperations();
  assert.equal(operations.operations[0].state, 'completed');
  const reopened = await connector.openProject({ absolutePath: '/srv/project', desiredState: desiredState, idempotencyKey: 'stable-project' });
  assert.equal(reopened.operationId, operations.operations[0].operationId);
});

test('connector refuses a changed host incarnation', async () => {
  const cache = new MemoryConnectorCache();
  const first = await RemoteHostDaemon.create({ sessionControl: new FakeSessionControlPort(), store: new MemoryStateStore(createInitialHostState({ hostId: 'host', incarnationId: 'inc-1' })) });
  const connector = new RemoteControlConnector({ transport: new FakeTransport(first), cache, sourceHostId: 'local', sourceSessionId: 'controller' });
  await connector.connect();
  const second = await RemoteHostDaemon.create({ sessionControl: new FakeSessionControlPort(), store: new MemoryStateStore(createInitialHostState({ hostId: 'host', incarnationId: 'inc-2' })) });
  connector.transport = new FakeTransport(second);
  await assert.rejects(() => connector.connect(), NeedsAttentionError);
});

test('gateway binding is an idempotent operation and never stores the token', async () => {
  const daemon = await RemoteHostDaemon.create({ sessionControl: new FakeSessionControlPort() });
  const connector = new RemoteControlConnector({ transport: new FakeTransport(daemon), cache: new MemoryConnectorCache(), sourceHostId: 'local', sourceSessionId: 'controller' });
  await connector.connect();
  const gatewayToken = 'dshgw_12345678901234567890123456789012';
  const first = await connector.bindGateway({ endpoint: 'http://127.0.0.1:18080', expiresAt: new Date(Date.now() + 60_000).toISOString(), token: gatewayToken, idempotencyKey: 'gateway-binding' });
  const second = await connector.bindGateway({ endpoint: 'http://127.0.0.1:18080', expiresAt: first.result.expiresAt, token: gatewayToken, idempotencyKey: 'gateway-binding' });
  assert.equal(second.operationId, first.operationId);
  assert.equal(JSON.stringify(daemon.hostState).includes(gatewayToken), false);
  assert.equal(Object.values(daemon.hostState.operations)[0].result.endpoint, 'http://127.0.0.1:18080');
  assert.equal(Object.values(daemon.hostState.operations)[0].token, undefined);
  assert.equal(daemon.hostState.gateway.tokenSha256.length, 64);
});

test('native remote model request reaches the injected local Gateway adapter end to end', async () => {
  const gateway = new ModelGateway({ provider: {
    async listModels() { return ['fake-model']; },
    async generate({ prompt, hostId }) { return { text: `${hostId}:${prompt}` }; },
  } });
  const address = await gateway.listen();
  const issued = gateway.issueHostToken('remote-host');
  const daemon = await RemoteHostDaemon.create({ sessionControl: new FakeSessionControlPort(), hostId: 'remote-host' });
  const connector = new RemoteControlConnector({ transport: new FakeTransport(daemon), cache: new MemoryConnectorCache(), sourceHostId: 'local', sourceSessionId: 'controller' });
  await connector.connect();
  await connector.bindGateway({ endpoint: address.endpoint, expiresAt: issued.expiresAt, token: issued.token, idempotencyKey: 'gateway-e2e' });
  const result = await daemon.nativeModelRequest({ model: 'fake-model', prompt: 'hello' });
  assert.deepEqual(result, { text: 'remote-host:hello' });
  await gateway.close();
});
