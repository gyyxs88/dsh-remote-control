import test from 'node:test';
import assert from 'node:assert/strict';
import { RemoteHostDaemon } from '../lib/remote-host.mjs';
import { MemoryStateStore, createInitialHostState } from '../lib/state-store.mjs';
import { DshSessionControlPort, FakeSessionControlPort, SessionControlPort } from '../lib/session-control-port.mjs';
import { FakeTransport, RemoteControlConnector } from '../lib/connector.mjs';
import { StageARuntimeManager } from '../lib/runtime-manager.mjs';
import { createClientHello, createOperationEnvelope, sha256 } from '../lib/protocol.mjs';
import { validateDesiredState } from '../lib/desired-state.mjs';

const desired = { dshVersion: '0.1.0-rc.6', plugins: [], skills: [], runtimes: [], defaultPermission: 'workspace-write', modelRoute: 'local-gateway-required' };

async function setup(options = {}) {
  return RemoteHostDaemon.create({ sessionControl: new FakeSessionControlPort(), ...options });
}

test('remote host creates absolute path -> workspace -> session idempotently', async () => {
  const port = new FakeSessionControlPort();
  const daemon = await RemoteHostDaemon.create({ sessionControl: port });
  await daemon.handle(createClientHello({ sourceHostId: 'local', sourceSessionId: 'controller' }));
  const make = (operationId) => createOperationEnvelope({ type: 'project.open', operationId, idempotencyKey: 'project-key', sourceHostId: 'local', sourceSessionId: 'controller', targetHostId: daemon.hostState.host.hostId, body: { absolutePath: '/srv/project', desiredState: desired } });
  const first = await daemon.handle(make('op-1'));
  const second = await daemon.handle(make('op-2'));
  assert.equal(first.operation.state, 'completed');
  assert.equal(second.operation.operationId, 'op-1');
  assert.equal(second.operation.result.workspaceId, 'workspace-1');
  assert.equal(second.operation.result.sessionId, 'session-1');
  assert.equal(port.calls.length, 1);
});

test('project.open persists verified plugin sync status and reconcile returns it without owning Session storage', async () => {
  const daemon = await setup();
  const hostId = daemon.hostState.host.hostId;
  await daemon.handle(createClientHello({ sourceHostId: 'local', sourceSessionId: 'controller' }));
  const desiredWithPlugin = {
    ...desired,
    plugins: [{ id: 'remote-plugin', version: '1.0.0', placement: 'remote', source: { registry: 'trusted', artifact: 'remote-plugin.tgz' }, sha256: 'a'.repeat(64), compatibility: { dsh: { min: '0.1.0-rc.6', max: '0.1.0-rc.6' }, api: { min: '1.0', max: '1.0' } }, requiredBy: ['project:remote'] }],
  };
  const normalized = validateDesiredState(desiredWithPlugin);
  const request = createOperationEnvelope({ type: 'project.open', operationId: 'plugin-open-001', idempotencyKey: 'plugin-open-key', sourceHostId: 'local', sourceSessionId: 'controller', targetHostId: hostId, body: { absolutePath: '/srv/plugin-project', desiredState: desiredWithPlugin, pluginSync: { status: 'completed', desiredStateSha256: sha256(normalized), items: [{ key: 'plugin:remote-plugin@1.0.0', status: 'installed', version: '1.0.0', sha256: 'a'.repeat(64) }] } } });
  const opened = await daemon.handle(request);
  assert.equal(opened.operation.state, 'completed');
  assert.equal(opened.operation.result.pluginSync.status, 'completed');
  const reconciled = await daemon.handle({ type: 'state.reconcile', hostId, incarnationId: daemon.hostState.host.incarnationId, sourceHostId: 'local', sourceSessionId: 'controller', targetHostId: hostId, knownRevision: 0 });
  assert.equal(reconciled.projects[0].pluginSync.status, 'completed');
  assert.equal(daemon.hostState.projects[reconciled.projects[0].projectId].workspaceId, 'workspace-1');
});

test('project.open refuses remote requirements without a verified synchronizer receipt', async () => {
  const daemon = await setup();
  const connector = new RemoteControlConnector({ transport: new FakeTransport(daemon), sourceHostId: 'local', sourceSessionId: 'controller' });
  await connector.connect();
  const response = await connector.openProject({ absolutePath: '/srv/un-synced', desiredState: { ...desired, plugins: [{ id: 'remote-plugin', version: '1.0.0', placement: 'remote', source: { registry: 'trusted', artifact: 'remote-plugin.tgz' }, sha256: 'a'.repeat(64), compatibility: { dsh: { min: '0.1.0-rc.6', max: '0.1.0-rc.6' }, api: { min: '1.0', max: '1.0' } }, requiredBy: ['project:remote'] }] } });
  assert.equal(response.state, 'needs-attention');
  assert.equal(response.error.code, 'PLUGIN_SYNC_NEEDS_ATTENTION');
  assert.equal(daemon.hostState.projects && Object.keys(daemon.hostState.projects).length, 0);
});

test('remote host refuses to start without a ready official Session Control port', async () => {
  await assert.rejects(() => RemoteHostDaemon.create({ sessionControl: new SessionControlPort() }), (error) => error.code === 'SESSION_CONTROL_REQUIRED');
});

test('Stage A does not install external runtimes and marks the project needs attention', async () => {
  const daemon = await setup();
  await daemon.handle(createClientHello({ sourceHostId: 'local', sourceSessionId: 'controller' }));
  const request = createOperationEnvelope({ type: 'project.open', idempotencyKey: 'needs-runtime', sourceHostId: 'local', sourceSessionId: 'controller', targetHostId: daemon.hostState.host.hostId, body: { absolutePath: '/srv/project', desiredState: { ...desired, runtimes: [{ id: 'codex', version: '1.0.0' }] } } });
  const response = await daemon.handle(request);
  assert.equal(response.operation.state, 'needs-attention');
  assert.equal(response.operation.error.code, 'RUNTIME_REQUIREMENT_UNSATISFIED');
});

test('host restart converts in-flight operations to needs-attention', async () => {
  const initial = createInitialHostState({ hostId: 'host-fixed', incarnationId: 'inc-fixed' });
  const store = new MemoryStateStore(initial);
  const request = createOperationEnvelope({ type: 'project.open', operationId: 'op-running', idempotencyKey: 'running', sourceHostId: 'local', sourceSessionId: 'controller', targetHostId: 'host-fixed', body: { absolutePath: '/srv/project', desiredState: desired } });
  await store.update((state) => {
    state.revision = 1;
    state.operations[request.operationId] = { operationId: request.operationId, idempotencyKey: request.idempotencyKey, type: request.type, sourceHostId: request.sourceHostId, sourceSessionId: request.sourceSessionId, targetHostId: request.targetHostId, bodySha256: request.bodySha256, permissionSnapshot: request.permissionSnapshot, state: 'running', revision: 1 };
  });
  const daemon = await RemoteHostDaemon.create({ store, sessionControl: new FakeSessionControlPort() });
  assert.equal(daemon.hostState.operations['op-running'].state, 'needs-attention');
  assert.equal(daemon.hostState.operations['op-running'].error.code, 'HOST_RESTART_INTERRUPTED');
});

test('operation and reconcile reads are bound to the handshaked source and target', async () => {
  const daemon = await setup();
  const hostId = daemon.hostState.host.hostId;
  await daemon.handle(createClientHello({ sourceHostId: 'source-a', sourceSessionId: 'controller-a' }));
  await daemon.handle(createClientHello({ sourceHostId: 'source-b', sourceSessionId: 'controller-b' }));
  const request = createOperationEnvelope({ type: 'project.open', idempotencyKey: 'source-a-project', sourceHostId: 'source-a', sourceSessionId: 'controller-a', targetHostId: hostId, body: { absolutePath: '/srv/project', desiredState: desired } });
  const operation = await daemon.handle(request);
  const stolen = await daemon.handle({ type: 'operation.get', operationId: operation.operation.operationId, sourceHostId: 'source-b', sourceSessionId: 'controller-b', targetHostId: hostId });
  assert.equal(stolen.error.code, 'OPERATION_NOT_FOUND');
  const leaked = await daemon.handle({ type: 'state.reconcile', hostId, incarnationId: daemon.hostState.host.incarnationId, sourceHostId: 'source-b', sourceSessionId: 'controller-b', targetHostId: hostId, knownRevision: 0 });
  assert.equal(leaked.operations.length, 0);
  assert.equal(leaked.projects.length, 0);
  const missingSource = await daemon.handle({ type: 'state.reconcile', hostId, incarnationId: daemon.hostState.host.incarnationId, targetHostId: hostId, knownRevision: 0 });
  assert.equal(missingSource.error.code, 'PROTOCOL_ERROR');
});

test('official session-control adapter forwards workspace, permission and schedule semantics without owning storage', async () => {
  let captured;
  const port = new DshSessionControlPort({
    async openProject(request) {
      captured = request;
      return { projectId: 'project', workspaceId: 'workspace', sessionId: 'session', state: 'completed' };
    },
  });
  const result = await port.openProject({ idempotencyKey: 'key', absolutePath: '/srv/project', desiredState: { ...desired, defaultPermission: 'danger-full-access' }, schedule: { kind: 'after', seconds: 30 } }, { operationId: 'op' });
  assert.equal(result.workspaceId, 'workspace');
  assert.equal(captured.idempotencyKey, 'key');
  assert.equal(captured.permissionPreset, 'danger-full-access');
  assert.deepEqual(captured.schedule, { kind: 'after', seconds: 30 });
});
