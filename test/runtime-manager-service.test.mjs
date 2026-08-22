import assert from 'node:assert/strict';
import { chmod, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path, { isAbsolute, join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { RuntimeManagerService, startRuntimeManagerService } from '../lib/runtime-manager-service.mjs';

const configuredSubagentRoot = process.env.DSH_SUBAGENT_CODE_AGENTS_ROOT;
if (configuredSubagentRoot !== undefined && !isAbsolute(configuredSubagentRoot)) throw new Error('DSH_SUBAGENT_CODE_AGENTS_ROOT must be an absolute path');
const { UnixSocketRuntimeManager } = configuredSubagentRoot === undefined
  ? { UnixSocketRuntimeManager: undefined }
  : await import(pathToFileURL(join(configuredSubagentRoot, 'packages', 'core', 'lib', 'runtime-manager-client.js')).href);
const token = 'A'.repeat(32);
const requirement = { id: 'codex', version: '1.0.0', placement: 'remote', source: { registry: 'admin-catalog', artifact: 'fixture' }, target: 'linux-x86_64', protocolVersion: '1.0', size: 10, sha256: 'a'.repeat(64), packageName: 'codex-runtime', executablePath: 'bin/codex', driver: 'codex', authPolicy: 'remote-user', capabilities: ['exec'], compatibility: { dsh: { min: '0.1.0-rc.6', max: '0.1.0-rc.8' }, api: { min: '1.0', max: '1.0' } }, requiredBy: ['channel:codex'] };

function daemonFixture() {
  const daemon = {
    runtimeManager: { async inspect() { return [{ id: 'codex', state: 'installed-auth-unverified', executable: null }]; } },
    resolveCount: 0,
    async resolveRuntimeExecutable(_requirement, { sourceHostId, sourceSessionId, targetSessionId }) {
      if (sourceHostId !== 'local-host' || sourceSessionId !== 'local-controller') {
        const error = new Error('source controller is not bound');
        error.code = 'RUNTIME_SOURCE_UNBOUND';
        throw error;
      }
      if (targetSessionId !== 'target-session') {
        const error = new Error('target Session is not bound');
        error.code = 'RUNTIME_TARGET_SESSION_UNBOUND';
        throw error;
      }
      if (_requirement.version !== '1.0.0') {
        const error = new Error('runtime authentication lease is not valid for this version');
        error.code = 'RUNTIME_AUTH_CONFIRMATION_REQUIRED';
        throw error;
      }
      daemon.resolveCount += 1;
      return { executable: '/home/dsh/.dsh-remote/current/bin/codex', state: 'installed-auth-unverified', authConfirmed: true };
    },
  };
  return daemon;
}

test('runtime manager service preserves outer capability frame and separates target Session identity', async () => {
  const service = new RuntimeManagerService({ daemon: daemonFixture(), hostId: 'remote-host', capabilityToken: token });
  const pong = await service.handle({ hostId: 'remote-host', targetHostId: 'remote-host', capabilityToken: token, message: { type: 'runtime-manager.ping' } });
  assert.deepEqual(pong, { type: 'runtime-manager.pong', hostId: 'remote-host' });
  const resolved = await service.handle({ hostId: 'remote-host', targetHostId: 'remote-host', sourceHostId: 'local-host', sourceSessionId: 'local-controller', capabilityToken: token, message: { type: 'runtime-manager.resolve', targetSessionId: 'target-session', requirement } });
  assert.equal(resolved.result.executable, '/home/dsh/.dsh-remote/current/bin/codex');
  await assert.rejects(service.handle({ hostId: 'remote-host', targetHostId: 'remote-host', capabilityToken: 'B'.repeat(32), message: { type: 'runtime-manager.ping' } }), /capability token is invalid/);
  await assert.rejects(service.handle({ hostId: 'remote-host', targetHostId: 'remote-host', sourceHostId: 'local-host', sourceSessionId: 'local-controller', capabilityToken: token, message: { type: 'runtime-manager.resolve', targetSessionId: 'wrong-target', requirement } }), /target Session is not bound/);
});

test('runtime manager Unix socket server/client consumes the same absolute executable and fails closed on token, target, and restart', { skip: process.platform !== 'linux' || UnixSocketRuntimeManager === undefined }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-runtime-manager-service-'));
  const socketPath = path.join(root, 'runtime-manager.sock');
  const tokenFile = path.join(root, 'runtime-manager.token');
  try {
    const bridge = await startRuntimeManagerService({ daemon: daemonFixture(), socketPath, hostId: 'remote-host', capabilityTokenFile: tokenFile });
    const client = new UnixSocketRuntimeManager({ socketPath, hostId: 'remote-host', sourceHostId: 'local-host', sourceSessionId: 'local-controller', capabilityTokenFile: tokenFile });
    assert.equal((await client.inspect([requirement]))[0].state, 'installed-auth-unverified');
    const resolved = await client.resolveExecutable(requirement, { targetSessionId: 'target-session' });
    assert.equal(resolved.executable, '/home/dsh/.dsh-remote/current/bin/codex');
    const repeated = await client.resolveExecutable(requirement, { targetSessionId: 'target-session' });
    assert.equal(repeated.executable, resolved.executable);
    await assert.rejects(new UnixSocketRuntimeManager({ socketPath, hostId: 'remote-host', sourceHostId: 'local-host', sourceSessionId: 'local-controller', capabilityToken: 'B'.repeat(32) }).inspect([requirement]), /capability token is invalid/);
    await assert.rejects(client.resolveExecutable(requirement, { targetSessionId: 'wrong-target' }), /target Session is not bound/);
    await assert.rejects(client.resolveExecutable({ ...requirement, version: '1.1.0' }, { targetSessionId: 'target-session' }), /lease is not valid/);
    await bridge.close();
    await assert.rejects(client.inspect([requirement]), /socket unavailable|socket closed/);
    const rotated = 'R'.repeat(32);
    const rotatedTemp = `${tokenFile}.next`;
    await writeFile(rotatedTemp, `${rotated}\n`, { mode: 0o600 });
    await rename(rotatedTemp, tokenFile);
    const rotatedBridge = await startRuntimeManagerService({ daemon: daemonFixture(), socketPath, hostId: 'remote-host', capabilityTokenFile: tokenFile });
    await assert.rejects(client.inspect([requirement]), /capability token is invalid/);
    const rotatedClient = new UnixSocketRuntimeManager({ socketPath, hostId: 'remote-host', sourceHostId: 'local-host', sourceSessionId: 'local-controller', capabilityTokenFile: tokenFile });
    assert.equal((await rotatedClient.inspect([requirement]))[0].state, 'installed-auth-unverified');
    await rotatedBridge.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('runtime manager capability token rejects insecure permissions and symlink substitution', { skip: process.platform !== 'linux' }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-runtime-manager-token-'));
  try {
    const insecure = path.join(root, 'insecure.token');
    await writeFile(insecure, `${token}\n`, { mode: 0o644 });
    await assert.rejects(startRuntimeManagerService({ daemon: daemonFixture(), socketPath: path.join(root, 'one.sock'), hostId: 'remote-host', capabilityTokenFile: insecure }), /owner-only/);
    const real = path.join(root, 'real.token');
    await writeFile(real, `${token}\n`, { mode: 0o600 });
    const link = path.join(root, 'link.token');
    await symlink(real, link);
    await assert.rejects(startRuntimeManagerService({ daemon: daemonFixture(), socketPath: path.join(root, 'two.sock'), hostId: 'remote-host', capabilityTokenFile: link }), /regular non-symlink/);
    await chmod(real, 0o644);
    await assert.rejects(startRuntimeManagerService({ daemon: daemonFixture(), socketPath: path.join(root, 'three.sock'), hostId: 'remote-host', capabilityTokenFile: real }), /owner-only/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
