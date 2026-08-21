import test from 'node:test';
import assert from 'node:assert/strict';
import { CAPABILITIES, createClientHello, createOperationEnvelope, negotiateVersion, validateProjectOpenBody } from '../lib/protocol.mjs';
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
    desiredState: { dshVersion: '0.1.0-rc.6', plugins: [], skills: [], runtimes: [], defaultPermission: 'workspace-write', modelRoute: 'local-gateway-required' },
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
