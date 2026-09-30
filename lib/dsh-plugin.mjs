import path from 'node:path';

import z from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';

import { RemoteProjectController } from './remote-project-controller.mjs';
import { DshRemoteError } from './errors.mjs';
import { registerBundledSkill } from './skill.mjs';

export const name = 'dsh-remote-control';
export const inject = ['agents', 'skills', 'tools', 'permissionPresets'];

export const Config = z.object({
  stateDir: z.string().required(),
  dshRecipeRoot: z.string().default(''),
  sessionControlPackageRoot: z.string().default(''),
  sshPath: z.string().default('ssh'),
  scpPath: z.string().default('scp'),
  sshKeyscanPath: z.string().default('ssh-keyscan'),
  npmPath: z.string().default(''),
  tarPath: z.string().default('tar'),
});

export const REMOTE_TOOL_NAMES = Object.freeze([
  'remote_host_list',
  'remote_host_probe',
  'remote_host_add',
  'remote_host_update',
  'remote_host_remove',
  'remote_host_inspect',
  'remote_project_open',
  'remote_project_reconcile',
  'remote_schedule_create',
  'remote_schedule_delete',
]);

const JSON_OUTPUT = { type: 'object', additionalProperties: true };

function hasAgentIdentity(ctx, agent) {
  try {
    return typeof agent?.id === 'string' && agent.id.trim().length > 0 && agent.session !== null && typeof agent.session === 'object'
      && ctx?.agents?.get?.(agent.id) === agent;
  } catch { return false; }
}

export function admitRemoteController(ctx, agent) {
  try {
    return hasAgentIdentity(ctx, agent) && ctx?.permissionPresets?.current?.(agent.session) === 'danger-full-access';
  } catch {
    return false;
  }
}

function renderJson(_args, value) {
  const text = JSON.stringify(value, null, 2);
  return [{ type: 'text', text: text.length > 24_000 ? `${text.slice(0, 24_000)}\n…(truncated)` : text }];
}

function scheduleFromArgs(args) {
  const schedule = { prompt: args.prompt };
  if (args.after_seconds !== undefined) schedule.after_seconds = args.after_seconds;
  if (args.at !== undefined) schedule.at = args.at;
  if (args.every_seconds !== undefined) schedule.every_seconds = args.every_seconds;
  return schedule;
}

export function currentTurnIsRelay(agent) {
  const session = agent?.session;
  // An unreadable current turn cannot authorize a remote operation.
  if (typeof session?.snapshotEvents !== 'function') return true;
  let events;
  try { events = session.snapshotEvents(); } catch { return true; }
  if (!Array.isArray(events)) return true;
  let start = -1;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index].type === 'turn/end') return false;
    if (events[index].type === 'turn/start') { start = index; break; }
  }
  if (start < 0) return false;
  return events.slice(start + 1).some((event) => event.type === 'user/message' && event.data?.source?.kind === 'plugin' && event.data.source.plugin === 'dsh-session-control' && event.data.source.form === 'relay');
}

export function authorizeRemoteTool(ctx, exec, next) {
  if (!REMOTE_TOOL_NAMES.includes(exec.name)) return next();
  if (!admitRemoteController(ctx, exec.agent)) return { kind: 'deny', reason: '远程管理工具要求当前会话具有官方 Full Access 权限' };
  if (currentTurnIsRelay(exec.agent)) return { kind: 'deny', reason: '中继消息触发的轮次不能操作远程主机' };
  return next();
}

export function registerRemoteTools(toolCtx, controller, guard = () => {}, onDefinition = () => {}) {
  const disposers = [];
  const register = (definition) => {
    const tool = defineTool({ ...definition, execute(args, exec) { guard(exec); return definition.execute(args, exec); } });
    onDefinition(tool);
    disposers.push(toolCtx.tools.register(tool));
  };
  register({
    name: 'remote_host_list', description: '列出已登记的 SSH 远程主机及其允许目录，不读取密钥或 token。', parameters: {}, output: { schema: JSON_OUTPUT, render: renderJson }, execute: () => controller.listHosts(),
  });
  register({
    name: 'remote_host_probe', description: '解析 OpenSSH 配置并探测远端 Host Key；只返回待人工核对的指纹，不建立信任。', parameters: { ssh_target: { type: 'string', required: true, description: 'SSH 别名、主机名或 user@host' } }, output: { schema: JSON_OUTPUT, render: renderJson }, execute: (args) => controller.probeHost({ sshTarget: args.ssh_target }),
  });
  register({
    name: 'remote_host_add', description: '在确认精确 Host Key 指纹后登记主机并验证非 root Linux x86_64/Node 24；不保存密码或私钥。', parameters: {
      host_id: { type: 'string', required: true }, ssh_target: { type: 'string', required: true }, expected_fingerprint: { type: 'string', required: true }, allowed_root: { type: 'string' }, remote_root: { type: 'string' }, dsh_port: { type: 'number' },
    }, output: { schema: JSON_OUTPUT, render: renderJson }, execute: (args) => controller.addHost({ hostId: args.host_id, sshTarget: args.ssh_target, expectedFingerprint: args.expected_fingerprint, allowedRoot: args.allowed_root, remoteRoot: args.remote_root, dshPort: args.dsh_port }),
  });
  register({
    name: 'remote_host_update', description: '调整已登记主机的最小允许目录或远端 DSH 回环端口；保留 Host Key pin 和远端数据。', parameters: { host_id: { type: 'string', required: true }, allowed_root: { type: 'string' }, dsh_port: { type: 'number' } }, output: { schema: JSON_OUTPUT, render: renderJson }, execute: (args) => controller.updateHost({ hostId: args.host_id, allowedRoot: args.allowed_root, dshPort: args.dsh_port }),
  });
  register({
    name: 'remote_host_remove', description: '删除本机远程主机登记并关闭连接；不会卸载远端 DSH 或删除项目。', parameters: { host_id: { type: 'string', required: true } }, output: { schema: JSON_OUTPUT, render: renderJson }, execute: (args) => controller.removeHost({ hostId: args.host_id }),
  });
  register({
    name: 'remote_host_inspect', description: '检查已登记主机的 SSH、Remote Host、DSH、插件 profile 和服务状态。', parameters: { host_id: { type: 'string', required: true } }, output: { schema: JSON_OUTPUT, render: renderJson }, execute: (args) => controller.inspectHost({ hostId: args.host_id }),
  });
  register({
    name: 'remote_project_open', description: '自动检查/安装远端 DSH 与必要插件，然后确保绝对目录、Workspace 和普通 Session 存在。必须使用稳定幂等键。', parameters: {
      host_id: { type: 'string', required: true }, path: { type: 'string', required: true }, display_name: { type: 'string' }, permission: { type: 'string', enum: ['read-only', 'workspace-write', 'danger-full-access'] }, target_session_id: { type: 'string' }, idempotency_key: { type: 'string', required: true }, schedule: { type: 'object', additionalProperties: true },
    }, output: { schema: JSON_OUTPUT, render: renderJson }, execute: (args) => controller.openProject({ hostId: args.host_id, absolutePath: args.path, displayName: args.display_name, permission: args.permission, targetSessionId: args.target_session_id, schedule: args.schedule, idempotencyKey: args.idempotency_key }),
  });
  register({
    name: 'remote_project_reconcile', description: '按远端 operation/revision 对账一个主机的项目状态，用于断线、超时或插件重启后的恢复。', parameters: { host_id: { type: 'string', required: true } }, output: { schema: JSON_OUTPUT, render: renderJson }, execute: (args) => controller.reconcile({ hostId: args.host_id }),
  });
  register({
    name: 'remote_schedule_create', description: '在已存在的远程项目 Session 中创建原生持久定时任务；通过同一项目和目标 Session 幂等复用。', parameters: {
      host_id: { type: 'string', required: true }, path: { type: 'string', required: true }, target_session_id: { type: 'string', required: true }, prompt: { type: 'string', required: true }, after_seconds: { type: 'number' }, at: { type: 'string' }, every_seconds: { type: 'number' }, idempotency_key: { type: 'string', required: true },
    }, output: { schema: JSON_OUTPUT, render: renderJson }, execute: (args) => controller.createSchedule({ hostId: args.host_id, absolutePath: args.path, targetSessionId: args.target_session_id, schedule: scheduleFromArgs(args), idempotencyKey: args.idempotency_key }),
  });
  register({
    name: 'remote_schedule_delete', description: '按精确目标 Session 和 Schedule id 删除远端原生定时任务；必须使用稳定幂等键。', parameters: { host_id: { type: 'string', required: true }, target_session_id: { type: 'string', required: true }, schedule_id: { type: 'string', required: true }, idempotency_key: { type: 'string', required: true } }, output: { schema: JSON_OUTPUT, render: renderJson }, execute: (args) => controller.deleteSchedule({ hostId: args.host_id, targetSessionId: args.target_session_id, scheduleId: args.schedule_id, idempotencyKey: args.idempotency_key }),
  });
  return () => { for (const dispose of disposers.reverse()) dispose(); };
}

export async function apply(ctx, config) {
  await registerBundledSkill(ctx);
  const stateDir = path.resolve(config.stateDir);
  const controller = await RemoteProjectController.open({
    stateDir,
    dshRecipeRoot: config.dshRecipeRoot ? path.resolve(config.dshRecipeRoot) : process.cwd(),
    sessionControlPackageRoot: config.sessionControlPackageRoot ? path.resolve(config.sessionControlPackageRoot) : undefined,
    sshPath: config.sshPath,
    scpPath: config.scpPath,
    sshKeyscanPath: config.sshKeyscanPath,
    npmPath: config.npmPath || undefined,
    tarPath: config.tarPath,
  });
  const mounted = new Map();
  const inheritedMasks = new Map();
  const definitions = new WeakSet();
  const pending = new Set();
  let stopped = false;
  const maskInherited = (agent) => {
    // Official scope inheritance must not expose a parent's management tools.
    // Full Access agents receive their own tools, which official masks exempt.
    const view = ctx.tools.view(agent);
    const names = REMOTE_TOOL_NAMES.filter((name) => view.restrictableNames.has(name) && definitions.has(view.visible.get(name)));
    if (names.length === 0) return;
    const cleanup = agent.ctx.tools.restrict({ deny: names });
    const masks = inheritedMasks.get(agent) ?? [];
    masks.push(cleanup);
    inheritedMasks.set(agent, masks);
  };
  const unmount = (agent) => {
    const record = mounted.get(agent);
    if (!record) return;
    record.active = false;
    mounted.delete(agent);
    const task = Promise.resolve(record.cleanup?.());
    pending.add(task);
    void task.finally(() => pending.delete(task)).catch((error) => ctx.logger.error(error));
  };
  const reconcile = (agent) => {
    if (!hasAgentIdentity(ctx, agent)) { unmount(agent); return; }
    if (stopped || !admitRemoteController(ctx, agent)) {
      unmount(agent);
      if (!stopped) maskInherited(agent);
      return;
    }
    if (mounted.has(agent)) return;
    maskInherited(agent);
    const conflicts = REMOTE_TOOL_NAMES.filter((toolName) => ctx.tools.get(toolName, agent) !== undefined);
    if (conflicts.length > 0) { ctx.logger.error(`dsh-remote-control: refusing partial mount; conflicting tools: ${conflicts.join(', ')}`); return; }
    const record = { active: true, cleanup: undefined };
    const guard = (exec) => {
      // Captured references stay revoked even after a later Full Access grant.
      if (exec && exec.agent !== agent) throw new DshRemoteError('remote tool reference belongs to another agent', { code: 'REMOTE_PERMISSION_DENIED' });
      if (!record.active || stopped || !admitRemoteController(ctx, agent)) {
        if (mounted.get(agent) === record) unmount(agent);
        throw new DshRemoteError('remote management requires current official Full Access permission', { code: 'REMOTE_PERMISSION_DENIED' });
      }
      if (currentTurnIsRelay(agent)) throw new DshRemoteError('relay turns cannot operate remote hosts', { code: 'REMOTE_PERMISSION_DENIED' });
    };
    record.cleanup = agent.ctx.effect(() => {
      const cleanup = registerRemoteTools(agent.ctx, controller, guard, (tool) => definitions.add(tool));
      return () => { record.active = false; cleanup(); };
    }, 'dsh-remote-control.tools()');
    mounted.set(agent, record);
  };
  ctx.effect(() => {
    const stopCreated = ctx.on('agent/created', ({ agent }) => reconcile(agent));
    const stopDisposed = ctx.on('agent/disposed', ({ agent }) => {
      unmount(agent);
      for (const cleanup of inheritedMasks.get(agent) ?? []) cleanup();
      inheritedMasks.delete(agent);
    });
    let refreshQueued = false;
    let masking = false;
    const stopTools = ctx.on('tools/change', () => {
      // Hide a newly mounted parent's tools from limited descendants in this
      // same dispatch; defer mounting to avoid reentrant registrations.
      if (!stopped && !masking) {
        masking = true;
        try {
          for (const agent of ctx.agents.list()) {
            if (hasAgentIdentity(ctx, agent) && !admitRemoteController(ctx, agent)) maskInherited(agent);
          }
        } finally { masking = false; }
      }
      if (refreshQueued || stopped) return;
      refreshQueued = true;
      queueMicrotask(() => {
        refreshQueued = false;
        if (!stopped) for (const agent of ctx.agents.list()) reconcile(agent);
      });
    });
    const stopSession = ctx.on('session/event', (session) => {
      for (const agent of ctx.agents.list()) if (agent.session === session) reconcile(agent);
    });
    const stopStep = ctx.on('agent/pre-step', ({ agent }, next) => { reconcile(agent); return next(); });
    const stopCatalog = ctx.on('permission-presets/catalog-changed', () => {
      for (const agent of ctx.agents.list()) reconcile(agent);
    });
    const stopPreExecute = ctx.on('tools/pre-execute', (exec, next) => {
      if (REMOTE_TOOL_NAMES.includes(exec.name)) reconcile(exec.agent);
      return authorizeRemoteTool(ctx, exec, next);
    });
    for (const agent of ctx.agents.list()) reconcile(agent);
    return async () => {
      stopped = true;
      stopCreated(); stopDisposed(); stopSession(); stopStep(); stopCatalog(); stopPreExecute(); stopTools();
      for (const agent of [...mounted.keys()]) unmount(agent);
      for (const masks of inheritedMasks.values()) for (const cleanup of masks) cleanup();
      inheritedMasks.clear();
      await Promise.allSettled([...pending]);
      await controller.dispose();
    };
  }, 'dsh-remote-control.lifecycle()');
}
