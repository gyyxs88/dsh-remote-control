import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import packageJson from '../package.json' with { type: 'json' };
import { admitRemoteController, authorizeRemoteTool, currentTurnIsRelay, registerRemoteTools, REMOTE_TOOL_NAMES } from '../lib/dsh-plugin.mjs';
import { loadBundledSkill } from '../lib/skill.mjs';

test('bundled Remote Project Skill is model/user invocable and digest-bound to the control manifest', async () => {
  const skill = await loadBundledSkill();
  assert.equal(skill.name, 'dsh-remote-project');
  assert.equal(skill.invocation.modelInvocable, true);
  assert.match(skill.content, /remote_project_open/u);
  const source = await readFile(skill.path);
  const digest = createHash('sha256').update(source).digest('hex');
  assert.equal(packageJson.dsh.control.bundledSkills[0].sha256, digest);
  assert.equal(packageJson.version, packageJson.dsh.control.version);
  assert.equal(packageJson.dsh.control.dshCompatibility.max, '0.2.0-rc.2');
});

test('DSH plugin registers the complete remote tool surface and maps public arguments', async () => {
  const definitions = new Map();
  const toolCtx = { tools: { register(definition) { definitions.set(definition.name, definition); return () => definitions.delete(definition.name); } } };
  const calls = [];
  const controller = new Proxy({}, { get: (_target, name) => (...args) => { calls.push([name, ...args]); return { ok: true }; } });
  const dispose = registerRemoteTools(toolCtx, controller);
  assert.deepEqual([...definitions.keys()].sort(), [...REMOTE_TOOL_NAMES].sort());
  await definitions.get('remote_project_open').execute({ host_id: 'lan', path: '/srv/project', permission: 'workspace-write', idempotency_key: 'open-project-key' });
  assert.deepEqual(calls[0], ['openProject', { hostId: 'lan', absolutePath: '/srv/project', displayName: undefined, permission: 'workspace-write', targetSessionId: undefined, schedule: undefined, idempotencyKey: 'open-project-key' }]);
  await definitions.get('remote_schedule_create').execute({ host_id: 'lan', path: '/srv/project', target_session_id: 'session-1', prompt: 'check', every_seconds: 600, idempotency_key: 'schedule-create-key' });
  assert.deepEqual(calls[1][1].schedule, { prompt: 'check', every_seconds: 600 });
  dispose();
  assert.equal(definitions.size, 0);
});

test('all-ordinary remote admission excludes subagents and remembers normal sessions', () => {
  const authorized = new Set(['explicit-controller']);
  const ctx = { agents: { get: () => undefined, isOwnedBy: () => false } };
  const ordinary = { id: 'ordinary', session: { header: { cwd: '/workspace' } } };
  const subagent = { id: 'subagent', session: { header: { cwd: '/workspace', origin: 'subagent' } } };
  assert.equal(admitRemoteController(ctx, ordinary, authorized, false), false);
  assert.equal(admitRemoteController(ctx, ordinary, authorized, true), true);
  assert.equal(authorized.has('ordinary'), true);
  assert.equal(admitRemoteController(ctx, subagent, authorized, true), false);
  assert.equal(authorized.has('subagent'), false);
});

test('rc.2 Session snapshot and native permission preset guard remote tools', () => {
  const events = [{ type: 'turn/start' }, { type: 'user/message', data: { source: { kind: 'plugin', plugin: 'dsh-session-control', form: 'relay' } } }];
  const session = { snapshotEvents: () => events };
  const agent = { id: 'controller', session };
  const authorized = new Set([agent.id]);
  let passedSession;
  const ctx = { permissionPresets: { current(value) { passedSession = value; return 'workspace-write'; } } };
  const next = () => ({ kind: 'allow' });
  const exec = { name: 'remote_project_open', agent, arguments: { host_id: 'lan', path: '/srv/project' } };
  assert.equal(currentTurnIsRelay(agent), true);
  assert.equal(authorizeRemoteTool(ctx, exec, next, authorized).kind, 'deny');
  assert.equal(passedSession, undefined);
  assert.equal(authorizeRemoteTool(ctx, { ...exec, agent: { ...agent, session: {} } }, next, authorized).kind, 'deny');
  events[1] = { type: 'user/message', data: { source: { kind: 'user' } } };
  assert.equal(authorizeRemoteTool(ctx, exec, next, authorized).kind, 'ask');
  assert.equal(passedSession, session);
  ctx.permissionPresets.current = () => 'danger-full-access';
  assert.equal(authorizeRemoteTool(ctx, exec, next, authorized).kind, 'allow');
});
