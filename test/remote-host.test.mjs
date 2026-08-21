import test from 'node:test';
import assert from 'node:assert/strict';
import { RemoteHostDaemon } from '../lib/remote-host.mjs';
import { MemoryStateStore, createInitialHostState } from '../lib/state-store.mjs';
import { DshSessionControlPort, FakeSessionControlPort } from '../lib/session-control-port.mjs';
import { StageARuntimeManager } from '../lib/runtime-manager.mjs';
import { createOperationEnvelope } from '../lib/protocol.mjs';

const desired = { dshVersion: '0.1.0-rc.6', plugins: [], skills: [], runtimes: [], defaultPermission: 'workspace-write', modelRoute: 'local-gateway-required' };

async function setup(options = {}) {
  return RemoteHostDaemon.create({ sessionControl: new FakeSessionControlPort(), ...options });
}

test('remote host creates absolute path -> workspace -> session idempotently', async () => {
  const port = new FakeSessionControlPort();
  const daemon = await RemoteHostDaemon.create({ sessionControl: port });
  const make = (operationId) => createOperationEnvelope({ type: 'project.open', operationId, idempotencyKey: 'project-key', sourceHostId: 'local', sourceSessionId: 'controller', targetHostId: daemon.hostState.host.hostId, body: { absolutePath: '/srv/project', desiredState: desired } });
  const first = await daemon.handle(make('op-1'));
  const second = await daemon.handle(make('op-2'));
  assert.equal(first.operation.state, 'completed');
  assert.equal(second.operation.operationId, 'op-1');
  assert.equal(second.operation.result.workspaceId, 'workspace-1');
  assert.equal(second.operation.result.sessionId, 'session-1');
  assert.equal(port.calls.length, 1);
});

test('Stage A does not install external runtimes and marks the project needs attention', async () => {
  const daemon = await setup();
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
