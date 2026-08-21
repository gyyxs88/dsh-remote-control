import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import packageJson from '../package.json' with { type: 'json' };
import { registerRemoteTools, REMOTE_TOOL_NAMES } from '../lib/dsh-plugin.mjs';
import { loadBundledSkill } from '../lib/skill.mjs';

test('bundled Remote Project Skill is model/user invocable and digest-bound to the control manifest', async () => {
  const skill = await loadBundledSkill();
  assert.equal(skill.name, 'dsh-remote-project');
  assert.equal(skill.invocation.modelInvocable, true);
  assert.match(skill.content, /remote_project_open/u);
  const source = await readFile(skill.path);
  const digest = createHash('sha256').update(source).digest('hex');
  assert.equal(packageJson.dsh.control.bundledSkills[0].sha256, digest);
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
