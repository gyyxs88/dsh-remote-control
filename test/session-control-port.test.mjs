import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UnixSocketSessionControlPort } from '../lib/session-control-port.mjs';

test('UnixSocketSessionControlPort probes and delegates the formal bridge contract', { skip: process.platform !== 'linux' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-session-port-'));
  const socketPath = join(root, 'session.sock');
  const server = net.createServer((socket) => {
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      buffer += chunk;
      const index = buffer.indexOf('\n');
      if (index < 0) return;
      const request = JSON.parse(buffer.slice(0, index));
      const response = request.type === 'remote-project.ping'
        ? { type: 'remote-project.pong', hostId: request.hostId, protocolVersion: '1.0' }
        : { type: 'remote-project.result', result: { projectId: 'p', workspaceId: 'w', sessionId: 's', workspacePath: '/srv/p', state: 'completed' } };
      socket.end(`${JSON.stringify(response)}\n`);
    });
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  try {
    const port = new UnixSocketSessionControlPort({ socketPath, hostId: 'remote-host' });
    assert.equal((await port.probe()).hostId, 'remote-host');
    const result = await port.openProject({ absolutePath: '/srv/p', idempotencyKey: 'key', desiredState: { defaultPermission: 'workspace-write' } }, { sourceHostId: 'local-host', sourceSessionId: 'controller', operationId: 'op-1' });
    assert.equal(result.sessionId, 's');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});
