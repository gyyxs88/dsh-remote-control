import test from 'node:test';
import assert from 'node:assert/strict';
import { DshHttpClient } from '../lib/dsh-http-client.mjs';

function fakeDshFetch() {
  const calls = [];
  const fetchImpl = async (_url, options = {}) => {
    if (!options.method) return new Response('ok', { status: 200 });
    const request = JSON.parse(options.body);
    calls.push(request);
    let value;
    if (request.method === 'workspace.create') value = { workspace: { workspaceId: 'workspace-1', path: '/home/test/Projects/anchor', title: 'anchor', sessionIds: [], createdAt: 'now', updatedAt: 'now' }, created: true };
    else if (request.method === 'session.create') value = { sessionId: request.payload.sessionId };
    else if (request.method === 'session.rename') value = { title: request.payload.title, seq: 1 };
    else throw new Error(`unexpected method ${request.method}`);
    return new Response(JSON.stringify({ type: 'server-response', rpcId: request.rpcId, result: { ok: true, value } }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { calls, fetchImpl };
}

test('loopback DSH HTTP client creates a fixed controller and warms it without a model turn', async () => {
  const fake = fakeDshFetch();
  const client = new DshHttpClient({ endpoint: 'http://127.0.0.1:3181', fetchImpl: fake.fetchImpl });
  assert.deepEqual(await client.waitUntilReady(), { ready: true });
  const controller = await client.ensureController({ workspacePath: '/home/test/Projects/anchor', sessionId: 'session-controller-12345678' });
  assert.equal(controller.sessionId, 'session-controller-12345678');
  const warmed = await client.warmController(controller.sessionId);
  assert.equal(warmed.warmed, true);
  assert.deepEqual(fake.calls.map((call) => call.method), ['workspace.create', 'session.create', 'session.rename']);
  assert.equal(fake.calls.at(-1).payload.title, 'DSH Remote Controller');
});

test('DSH HTTP client rejects non-loopback endpoints and malformed envelopes', async () => {
  assert.throws(() => new DshHttpClient({ endpoint: 'http://192.168.1.2:3181' }), /loopback/);
  const client = new DshHttpClient({ endpoint: 'http://127.0.0.1:3181', fetchImpl: async () => new Response('{}', { status: 200 }) });
  await assert.rejects(() => client.call('workspace.list', {}), /response is invalid/);
});
