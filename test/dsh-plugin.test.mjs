import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools';
import { createScope, scopeTarget } from '@deepseek-ai/dsh-scope';

import packageJson from '../package.json' with { type: 'json' };
const plugin = await import(process.env.REMOTE_TEST_PLUGIN_ENTRY ?? '../lib/dsh-plugin.mjs');
const { Config, apply, admitRemoteController, authorizeRemoteTool, currentTurnIsRelay, registerRemoteTools, REMOTE_TOOL_NAMES } = plugin;
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

function contextFor(agent, preset = 'danger-full-access') {
  return { agents: { get: (id) => id === agent?.id ? agent : undefined }, permissionPresets: { current: () => preset } };
}

test('current official Full Access admits every live session without a list; legacy lists have no effect', () => {
  for (const header of [{}, { origin: 'subagent' }, { parentSession: 'parent' }]) {
    const agent = { id: 'any-live-agent', session: { header, snapshotEvents: () => [] } };
    const ctx = contextFor(agent);
    assert.equal(admitRemoteController(ctx, agent), true);
    assert.equal(admitRemoteController(ctx, agent, new Set(), false), true);
    for (const preset of ['workspace-write', 'read-only', 'custom', 'auto', 'unknown', undefined]) {
      ctx.permissionPresets.current = () => preset;
      assert.equal(admitRemoteController(ctx, agent, new Set([agent.id]), true), false);
    }
  }
  assert.equal(Object.hasOwn(Config.dict, 'controllerSessionIds'), false);
  assert.equal(Object.hasOwn(Config.dict, 'authorizeAllOrdinarySessions'), false);
});

test('missing, malformed or stale live identity and missing/throwing permission service fail closed', () => {
  const agent = { id: 'live', session: { snapshotEvents: () => [] } };
  const ctx = contextFor(agent);
  for (const invalid of [undefined, {}, { id: '' }, { id: ' ' }, { id: 123, session: {} }, { id: 'live' }, { id: 'live', session: null }, { id: 'live', session: 'cached' }, { ...agent }]) {
    assert.equal(admitRemoteController(ctx, invalid, new Set(['live']), true), false);
  }
  for (const service of [undefined, {}, { current: () => { throw new Error('projection absent'); } }]) {
    ctx.permissionPresets = service;
    assert.equal(admitRemoteController(ctx, agent), false);
    for (const name of REMOTE_TOOL_NAMES) assert.equal(authorizeRemoteTool(ctx, { name, agent }, () => ({ kind: 'allow' })).kind, 'deny');
  }
  ctx.permissionPresets = { current: () => 'danger-full-access' };
  ctx.agents.get = () => undefined;
  assert.equal(admitRemoteController(ctx, agent), false);
});

test('rc.2 Session snapshot and native permission preset guard remote tools', () => {
  const events = [{ type: 'turn/start' }, { type: 'user/message', data: { source: { kind: 'plugin', plugin: 'dsh-session-control', form: 'relay' } } }];
  const session = { snapshotEvents: () => events };
  const agent = { id: 'controller', session };
  let passedSession;
  const ctx = contextFor(agent);
  ctx.permissionPresets.current = (value) => { passedSession = value; return 'danger-full-access'; };
  const next = () => ({ kind: 'allow' });
  const exec = { name: 'remote_project_open', agent, arguments: { host_id: 'lan', path: '/srv/project' } };
  assert.equal(currentTurnIsRelay(agent), true);
  assert.equal(authorizeRemoteTool(ctx, exec, next).kind, 'deny');
  assert.equal(passedSession, session);
  session.snapshotEvents = () => { throw new Error('unreadable'); };
  assert.equal(authorizeRemoteTool(ctx, exec, next).kind, 'deny');
  session.snapshotEvents = () => events;
  events[1] = { type: 'user/message', data: { source: { kind: 'user' } } };
  assert.equal(authorizeRemoteTool(ctx, exec, next).kind, 'allow');
  assert.equal(passedSession, session);
  ctx.permissionPresets.current = () => 'workspace-write';
  for (const name of REMOTE_TOOL_NAMES) assert.equal(authorizeRemoteTool(ctx, { ...exec, name }, next).kind, 'deny');
  assert.equal(authorizeRemoteTool(ctx, { name: 'unrelated' }, next).kind, 'allow');
});

const settle = () => new Promise(resolve => setImmediate(resolve));

async function lifecycleHarness(t, config = {}) {
  const ctx = new Context();
  const agents = new Map();
  const presets = new Map();
  const scopes = [];
  ctx.provide('systemPrompt', { tools: () => () => {} });
  new ToolRuntime(ctx);
  ctx.provide('agents', { get: (id) => agents.get(id), list: () => [...agents.values()] });
  ctx.provide('skills', { register: () => () => {} });
  const permissionService = config.permissionService ?? { current(session) {
    const preset = presets.get(session);
    if (preset instanceof Error) throw preset;
    return preset;
  } };
  const removeService = ctx.provide('permissionPresets', permissionService);
  const add = async (id, preset, parent) => {
    const agent = { id, session: { header: { origin: parent ? 'subagent' : undefined }, snapshotEvents: () => [] } };
    const scope = createScope(ctx, agent, parent ? { parent } : undefined);
    scopes.push(scope);
    agent.ctx = scope.ctx;
    presets.set(agent.session, preset);
    agents.set(id, agent);
    await settle();
    ctx.emit(scopeTarget(ctx, agent), 'agent/created', { agent });
    await settle();
    return agent;
  };
  const first = await add('first', 'danger-full-access');
  const stateDir = await mkdtemp(path.join(tmpdir(), 'dsh-permission-lifecycle-'));
  const fiber = ctx.plugin(plugin, { ...config, stateDir });
  await fiber;
  await settle();
  assert.equal(fiber.error, undefined);
  t.after(async () => { await fiber.dispose(); for (const scope of scopes.reverse()) await scope.dispose(); });
  const change = async (agent, preset, type = 'permission/preset') => {
    presets.set(agent.session, preset);
    ctx.emit(scopeTarget(ctx, agent), 'session/event', agent.session, { type, data: {} });
    await settle();
  };
  const gate = (agent, name = 'remote_host_list', next = () => Promise.resolve({ kind: 'allow' })) => ctx.waterfall(scopeTarget(ctx, agent), 'tools/pre-execute', { agent, name, arguments: {} }, next);
  return { ctx, first, agents, presets, add, change, gate, fiber, removeService };
}

test('Web rc.1 official PermissionPresetService.set/current completes three-event regrant', { skip: process.env.REMOTE_TEST_SDK !== 'rc1' }, async (t) => {
  const { default: PermissionPresetService } = await import('@deepseek-ai/dsh-permission-presets');
  const permissionCtx = new Context();
  let projection;
  permissionCtx.provide('shell', { sandboxMode: 'workspace-write' });
  permissionCtx.provide('approval', { config: { policy: 'ask' } });
  permissionCtx.provide('sessions', { list: () => [] });
  permissionCtx.provide('sessionProjections', { register: (value) => { projection = value; }, stateOf: (session) => session.permissionState });
  const official = new PermissionPresetService(permissionCtx, { presets: {
    'workspace-write': { sandbox: 'workspace-write', approval: 'ask' },
    'danger-full-access': { sandbox: 'danger-full-access', approval: 'never' },
  }, defaultPreset: { get: () => undefined } });
  const h = await lifecycleHarness(t, { permissionService: official });
  const session = h.first.session;
  session.permissionState = { ...projection.init(), preset: 'workspace-write', sandbox: 'workspace-write', approval: 'ask' };
  const observed = [];
  session.append = (type, data) => {
    session.permissionState = projection.apply(session.permissionState, { type, data });
    h.ctx.emit(scopeTarget(h.ctx, h.first), 'session/event', session, { type, data });
    observed.push({ type, current: official.current(session), tools: h.ctx.tools.schemas(h.first).length });
  };
  official.set(session, 'danger-full-access');
  assert.deepEqual(observed.map(value => value.type), ['permission/preset', 'sandbox/mode', 'approval/policy']);
  assert.deepEqual(observed.map(value => value.tools), [0, 0, REMOTE_TOOL_NAMES.length]);
  assert.equal(official.current(session), 'danger-full-access');
  const cached = h.ctx.tools.get('remote_host_list', h.first);
  official.set(session, 'workspace-write');
  assert.equal(h.ctx.tools.schemas(h.first).length, 0);
  await assert.rejects(cached.execute({}), { code: 'REMOTE_PERMISSION_DENIED' });
  official.set(session, 'danger-full-access');
  assert.equal(h.ctx.tools.schemas(h.first).length, REMOTE_TOOL_NAMES.length);
  await assert.rejects(cached.execute({}), { code: 'REMOTE_PERMISSION_DENIED' });
});

test('official Cordis/tools lifecycle mounts full without a list, denies nonfull despite legacy config', async (t) => {
  const h = await lifecycleHarness(t, { controllerSessionIds: ['limited'], authorizeAllOrdinarySessions: true });
  assert.equal(h.ctx.tools.schemas(h.first).length, REMOTE_TOOL_NAMES.length);
  const limited = await h.add('limited', 'workspace-write');
  assert.equal(h.ctx.tools.schemas(limited).length, 0);
  for (const name of REMOTE_TOOL_NAMES) assert.equal((await h.gate(limited, name)).kind, 'deny');
  assert.equal((await h.gate(h.first, 'remote_host_list', () => Promise.resolve({ kind: 'ask', reason: 'official approval' }))).kind, 'ask');
  const decision = await h.ctx.waterfall(scopeTarget(h.ctx, h.first), 'agent/pre-step', { agent: h.first }, () => Promise.resolve({ kind: 'continue' }));
  assert.equal(decision.kind, 'continue');
});

test('three official permission events revoke then regrant; old definitions stay revoked', async (t) => {
  const h = await lifecycleHarness(t);
  const old = h.ctx.tools.get('remote_host_list', h.first);
  assert.equal((await old.execute({})).ok, true);
  await h.change(h.first, 'workspace-write');
  assert.equal(h.ctx.tools.schemas(h.first).length, 0);
  await assert.rejects(old.execute({}), { code: 'REMOTE_PERMISSION_DENIED' });
  await h.change(h.first, 'custom', 'permission/preset');
  await h.change(h.first, 'custom', 'sandbox/mode');
  assert.equal(h.ctx.tools.schemas(h.first).length, 0);
  await h.change(h.first, 'danger-full-access', 'approval/policy');
  const fresh = h.ctx.tools.get('remote_host_list', h.first);
  assert.notEqual(old, fresh);
  assert.equal((await fresh.execute({})).ok, true);
  await assert.rejects(old.execute({}), { code: 'REMOTE_PERMISSION_DENIED' });
  assert.equal(h.ctx.tools.schemas(h.first).length, REMOTE_TOOL_NAMES.length);
  // A service failure without an event is denied by the captured definition.
  h.presets.set(h.first.session, new Error('projection unavailable'));
  await assert.rejects(fresh.execute({}), { code: 'REMOTE_PERMISSION_DENIED' });
  assert.equal(h.ctx.tools.schemas(h.first).length, 0);
  h.presets.set(h.first.session, 'danger-full-access');
  h.ctx.emit('permission-presets/catalog-changed');
  await settle();
  assert.equal(h.ctx.tools.schemas(h.first).length, REMOTE_TOOL_NAMES.length);
  await assert.rejects(fresh.execute({}), { code: 'REMOTE_PERMISSION_DENIED' });
});

test('official scoped inheritance never grants nonfull children; full children own independent tools', async (t) => {
  const h = await lifecycleHarness(t);
  const child = await h.add('child', 'workspace-write', h.first);
  assert.equal(h.ctx.tools.schemas(child).length, 0);
  await h.change(child, 'danger-full-access');
  assert.equal(h.ctx.tools.schemas(child).length, REMOTE_TOOL_NAMES.length);
  const parentTool = h.ctx.tools.get('remote_host_list', h.first);
  const childTool = h.ctx.tools.get('remote_host_list', child);
  assert.notEqual(parentTool, childTool);
  await assert.rejects(parentTool.execute({}, { agent: child }), { code: 'REMOTE_PERMISSION_DENIED' });
  assert.equal(h.ctx.tools.schemas(h.first).length, REMOTE_TOOL_NAMES.length);
  await h.change(h.first, 'workspace-write');
  assert.equal(h.ctx.tools.schemas(h.first).length, 0);
  assert.equal(h.ctx.tools.schemas(child).length, REMOTE_TOOL_NAMES.length);
  await h.change(child, 'workspace-write');
  h.presets.set(h.first.session, 'danger-full-access');
  h.ctx.emit(scopeTarget(h.ctx, h.first), 'session/event', h.first.session, { type: 'approval/policy', data: {} });
  assert.equal(h.ctx.tools.schemas(child).length, 0);
  await settle();
  assert.equal(h.ctx.tools.schemas(child).length, 0);
  await assert.rejects(childTool.execute({}), { code: 'REMOTE_PERMISSION_DENIED' });
});

test('conflicting tool names refuse partial mounting and removal permits a complete mount', async (t) => {
  const h = await lifecycleHarness(t);
  const cleanup = h.ctx.tools.register(defineTool({ name: 'remote_host_list', description: 'foreign tool fixture', parameters: {},
    output: { schema: { type: 'object', additionalProperties: true }, render: () => [] }, execute: () => ({ foreign: true }) }));
  const conflicting = await h.add('conflicting', 'danger-full-access');
  assert.deepEqual(h.ctx.tools.schemas(conflicting).map(tool => tool.name), ['remote_host_list']);
  cleanup();
  await settle();
  assert.equal(h.ctx.tools.schemas(conflicting).length, REMOTE_TOOL_NAMES.length);
});

test('invalid live IDs and Sessions never mount even with a cached Full Access preset', async (t) => {
  const h = await lifecycleHarness(t);
  for (const id of ['', ' ', undefined, 123]) {
    const invalid = await h.add(id, 'danger-full-access');
    assert.equal(h.ctx.tools.schemas(invalid).length, 0);
    assert.equal(authorizeRemoteTool(h.ctx, { name: 'remote_host_list', agent: invalid }, () => ({ kind: 'allow' })).kind, 'deny');
  }
  const noSession = await h.add('missing-session', 'workspace-write');
  noSession.session = null;
  h.ctx.emit(scopeTarget(h.ctx, noSession), 'agent/created', { agent: noSession });
  assert.equal(h.ctx.tools.schemas(noSession).length, 0);
});

test('live identity disposal, missing service and plugin shutdown revoke both gates and cached references', async (t) => {
  const h = await lifecycleHarness(t);
  const old = h.ctx.tools.get('remote_host_list', h.first);
  h.agents.delete(h.first.id);
  assert.equal((await h.gate(h.first)).kind, 'deny');
  await assert.rejects(old.execute({}), { code: 'REMOTE_PERMISSION_DENIED' });
  h.ctx.emit(scopeTarget(h.ctx, h.first), 'agent/disposed', { agent: h.first });
  const next = await h.add('new', 'danger-full-access');
  const cached = h.ctx.tools.get('remote_host_list', next);
  await h.removeService();
  await settle();
  assert.equal(authorizeRemoteTool(h.ctx, { name: 'remote_host_list', agent: next }, () => ({ kind: 'allow' })).kind, 'deny');
  await assert.rejects(cached.execute({}), { code: 'REMOTE_PERMISSION_DENIED' });
  assert.equal(h.ctx.tools.schemas(next).length, 0);
  await h.fiber.dispose();
  await assert.rejects(cached.execute({}), { code: 'REMOTE_PERMISSION_DENIED' });
});
