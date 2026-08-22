import test from 'node:test';
import assert from 'node:assert/strict';
import { CAPABILITIES, createClientHello, createOperationEnvelope, negotiateVersion, validateGatewayBinding, validatePermissionSnapshot, validateProjectOpenBody, validateScheduleCreateBody, validateScheduleDeleteBody } from '../lib/protocol.mjs';
import { ProtocolError } from '../lib/errors.mjs';

test('protocol negotiation accepts same major and bounded minor', () => {
  assert.deepEqual(negotiateVersion({ client: '1.4', host: '1.2' }), { name: 'dsh-remote-control', major: 1, minor: 2, version: '1.2' });
  assert.throws(() => negotiateVersion({ client: '2.0', host: '1.0' }), ProtocolError);
});

test('client hello and project body are versioned and constrained', () => {
  const hello = createClientHello({ sourceHostId: 'local', sourceSessionId: 'controller' });
  assert.equal(hello.type, CAPABILITIES.HOST_HELLO);
  const body = validateProjectOpenBody({
    absolutePath: '/srv/project',
    desiredState: { dshVersion: '0.1.1-rc.2', plugins: [], skills: [], runtimes: [], defaultPermission: 'workspace-write', modelRoute: 'local-gateway-required' },
  });
  assert.equal(body.absolutePath, '/srv/project');
  assert.throws(() => validateProjectOpenBody({ absolutePath: 'relative', desiredState: body.desiredState }), ProtocolError);
  assert.throws(() => validateProjectOpenBody({ absolutePath: '/srv/../etc', desiredState: body.desiredState }), ProtocolError);
});

test('operation envelope binds the request hash and permission snapshot', () => {
  const envelope = createOperationEnvelope({ type: 'project.open', idempotencyKey: 'key', sourceHostId: 'local', sourceSessionId: 'controller', targetHostId: 'remote', body: { absolutePath: '/srv/project' } });
  assert.equal(envelope.bodySha256.length, 64);
  assert.equal(envelope.permissionSnapshot.preset, 'workspace-write');
});

test('schedule delete protocol binds exact target Session and schedule identities', () => {
  assert.deepEqual(validateScheduleDeleteBody({ targetSessionId: 'session-target', scheduleId: 'schedule-1' }), { targetSessionId: 'session-target', scheduleId: 'schedule-1' });
  assert.throws(() => validateScheduleDeleteBody({ targetSessionId: '../session', scheduleId: 'schedule-1' }), ProtocolError);
});

test('schedule create protocol binds target Session, prompt, and exactly one timing mode', () => {
  assert.deepEqual(validateScheduleCreateBody({ targetSessionId: 'session-target', schedule: { prompt: 'check', every_seconds: 600 } }), { targetSessionId: 'session-target', schedule: { prompt: 'check', every_seconds: 600 } });
  assert.throws(() => validateScheduleCreateBody({ targetSessionId: 'session-target', schedule: { prompt: 'bad', after_seconds: 1, every_seconds: 600 } }), /exactly one timing mode/);
  assert.throws(() => validateScheduleCreateBody({ targetSessionId: 'session-target', schedule: { prompt: 'bad', every_seconds: 60 } }), /every_seconds/);
});

test('permission and gateway expiries are strict and bounded', () => {
  const now = Date.parse('2026-08-21T00:00:00.000Z');
  assert.throws(() => validatePermissionSnapshot({ preset: 'workspace-write', capturedAt: new Date(now).toISOString(), expiresAt: new Date(now + 15 * 60_000 + 1).toISOString() }, { now }), ProtocolError);
  assert.throws(() => validatePermissionSnapshot({ preset: 'workspace-write', capturedAt: new Date(now + 1_000).toISOString(), expiresAt: new Date(now).toISOString() }, { now }), ProtocolError);
  assert.throws(() => validatePermissionSnapshot({ preset: 'workspace-write', capturedAt: '2026-08-21', expiresAt: new Date(now + 60_000).toISOString() }, { now }), ProtocolError);
  const token = `dshgw_${'x'.repeat(32)}`;
  assert.equal(validateGatewayBinding({ endpoint: 'http://127.0.0.1:8080', expiresAt: new Date(now + 60_000).toISOString(), token }, { now }).endpoint, 'http://127.0.0.1:8080');
  assert.throws(() => validateGatewayBinding({ endpoint: 'http://0.0.0.0:8080', expiresAt: new Date(now + 60_000).toISOString(), token }, { now }), ProtocolError);
});
