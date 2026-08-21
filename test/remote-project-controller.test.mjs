import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { HostRegistry } from '../lib/host-registry.mjs';
import { RemoteProjectController } from '../lib/remote-project-controller.mjs';
import { fingerprintSshKey } from '../lib/ssh-discovery.mjs';

const publicKey = Buffer.from('remote-project-controller-key').toString('base64');
const fingerprint = fingerprintSshKey(publicKey);

test('Remote Project controller covers registration, project open, schedule, reconcile, update and local removal', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'dsh-remote-controller-'));
  const registry = await HostRegistry.open({ stateDir });
  const calls = [];
  const connection = {
    async inspect() { return { remoteHost: { status: 'installed' }, dsh: { status: 'ready' } }; },
    async openProject(options) { calls.push(['open', options]); return { state: 'completed', result: { workspaceId: 'workspace-1', sessionId: options.targetSessionId ?? 'session-1', scheduleState: options.schedule ?? null } }; },
    async reconcile() { calls.push(['reconcile']); return { status: 'current', accepted: true, revision: 3 }; },
    async deleteSchedule(options) { calls.push(['delete', options]); return { state: 'completed', result: { deleted: true, scheduleId: options.scheduleId } }; },
    async createSchedule(options) { calls.push(['create-schedule', options]); return { state: 'completed', result: { scheduleId: 'schedule-1' } }; },
    close() { calls.push(['close']); },
  };
  const controller = new RemoteProjectController({
    registry,
    artifactProvider: { async prepare() { return { fixture: true }; } },
    identity: { sourceHostId: 'local-host', sourceSessionId: 'controller-session' },
    stateDir,
    hostKeyProber: async (sshTarget) => ({ resolved: { sshTarget, hostname: '192.168.31.212', user: 'leyi', port: 22 }, candidates: [{ keyType: 'ssh-ed25519', publicKey, fingerprint }] }),
    systemProber: async () => ({ platform: 'linux', arch: 'x64', uid: 1000, home: '/home/leyi', nodeVersion: '24.12.0' }),
    connectionFactory: async () => connection,
  });
  const probed = await controller.probeHost({ sshTarget: 'lan-dev-212' });
  assert.equal(probed.status, 'needs-confirmation');
  await assert.rejects(controller.addHost({ hostId: 'lan-212', sshTarget: 'lan-dev-212' }), (error) => error.code === 'SSH_HOST_KEY_CONFIRMATION_REQUIRED');
  const added = await controller.addHost({ hostId: 'lan-212', sshTarget: 'lan-dev-212', expectedFingerprint: fingerprint, allowedRoot: '/home/leyi/Projects/demo', dshPort: 3183 });
  assert.equal(added.status, 'registered');
  assert.equal(controller.listHosts().hosts.length, 1);
  const opened = await controller.openProject({ hostId: 'lan-212', absolutePath: '/home/leyi/Projects/demo', permission: 'workspace-write', idempotencyKey: 'open-lan-212-demo' });
  assert.equal(opened.operation.state, 'completed');
  await controller.createSchedule({ hostId: 'lan-212', absolutePath: '/home/leyi/Projects/demo', targetSessionId: 'session-1', schedule: { prompt: 'check', after_seconds: 3600 }, idempotencyKey: 'schedule-create-lan-212' });
  await controller.deleteSchedule({ hostId: 'lan-212', targetSessionId: 'session-1', scheduleId: 'schedule-1', idempotencyKey: 'schedule-delete-lan-212' });
  assert.equal((await controller.reconcile({ hostId: 'lan-212' })).reconciliation.revision, 3);
  await controller.updateHost({ hostId: 'lan-212', allowedRoot: '/home/leyi/Projects' });
  assert.equal(controller.getHost('lan-212').allowed_root, '/home/leyi/Projects');
  const removed = await controller.removeHost({ hostId: 'lan-212' });
  assert.equal(removed.remote_installation_preserved, true);
  assert.equal(controller.listHosts().hosts.length, 0);
  assert.equal(calls.filter(([kind]) => kind === 'open').length, 1);
  assert.equal(calls.filter(([kind]) => kind === 'create-schedule').length, 1);
  await controller.dispose();
});
