import path from 'node:path';

import z from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';

import { RemoteProjectController } from './remote-project-controller.mjs';
import { registerBundledSkill } from './skill.mjs';

export const name = 'dsh-remote-control';
export const inject = ['agents', 'skills', 'tools', 'permissionPresets'];

export const Config = z.object({
  controllerSessionIds: z.array(z.string()).default([]),
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

const MUTATING_TOOLS = new Set(['remote_host_add', 'remote_host_update', 'remote_host_remove', 'remote_project_open', 'remote_schedule_create', 'remote_schedule_delete']);
const JSON_OUTPUT = { type: 'object', additionalProperties: true };

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

function currentTurnIsRelay(agent) {
  const events = agent?.session?.events;
  if (!Array.isArray(events)) return false;
  let start = -1;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index].type === 'turn/end') return false;
    if (events[index].type === 'turn/start') { start = index; break; }
  }
  if (start < 0) return false;
  return events.slice(start + 1).some((event) => event.type === 'user/message' && event.data?.source?.kind === 'plugin' && event.data.source.plugin === 'dsh-session-control' && event.data.source.form === 'relay');
}

function mutationReason(name, args) {
  if (name === 'remote_host_add') return `登记 SSH 主机 ${String(args.host_id ?? '')} (${String(args.ssh_target ?? '')}) 并固定 Host Key 指纹`;
  if (name === 'remote_host_update') return `调整远程主机 ${String(args.host_id ?? '')} 的允许目录或服务端口`;
  if (name === 'remote_host_remove') return `删除远程主机 ${String(args.host_id ?? '')} 的本机登记；远端安装保留`;
  if (name === 'remote_project_open') return `在远程主机 ${String(args.host_id ?? '')} 打开项目 ${String(args.path ?? '')}`;
  if (name === 'remote_schedule_create') return `为远程主机 ${String(args.host_id ?? '')} 的目标会话创建定时任务`;
  return `删除远程主机 ${String(args.host_id ?? '')} 的定时任务 ${String(args.schedule_id ?? '')}`;
}

export function registerRemoteTools(toolCtx, controller) {
  const disposers = [];
  const register = (definition) => disposers.push(toolCtx.tools.register(defineTool(definition)));
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
  const authorized = new Set(config.controllerSessionIds ?? []);
  const mounted = new Map();
  const mount = (agent) => {
    if (!authorized.has(agent?.id) || mounted.has(agent)) return;
    const conflicts = REMOTE_TOOL_NAMES.filter((toolName) => ctx.tools.get(toolName, agent) !== undefined);
    if (conflicts.length > 0) { ctx.logger.error(`dsh-remote-control: refusing partial mount; conflicting tools: ${conflicts.join(', ')}`); return; }
    const cleanup = agent.ctx.effect(() => registerRemoteTools(agent.ctx, controller), 'dsh-remote-control.tools()');
    mounted.set(agent, cleanup);
  };
  ctx.effect(() => {
    const stopCreated = ctx.on('agent/created', ({ agent }) => mount(agent));
    const stopDisposed = ctx.on('agent/disposed', ({ agent }) => { const cleanup = mounted.get(agent); mounted.delete(agent); void Promise.resolve(cleanup?.()); });
    const stopPreExecute = ctx.on('tools/pre-execute', (exec, next) => {
      if (!REMOTE_TOOL_NAMES.includes(exec.name)) return next();
      if (!authorized.has(exec.agent?.id)) return { kind: 'deny', reason: '当前会话没有远程主机控制权限' };
      if (currentTurnIsRelay(exec.agent)) return { kind: 'deny', reason: '中继消息触发的轮次不能操作远程主机' };
      if (!MUTATING_TOOLS.has(exec.name)) return next();
      const preset = ctx.permissionPresets.current(exec.agent.session.events);
      if (preset === 'danger-full-access') return next();
      if (preset === 'workspace-write') return { kind: 'ask', reason: mutationReason(exec.name, exec.arguments ?? {}) };
      return { kind: 'deny', reason: '只有 Workspace Write 或 Full access 控制会话可以修改远程主机或项目' };
    });
    for (const agent of ctx.agents.list()) mount(agent);
    return async () => {
      stopCreated(); stopDisposed(); stopPreExecute();
      const cleanups = [...mounted.values()]; mounted.clear();
      await Promise.allSettled(cleanups.map((cleanup) => Promise.resolve(cleanup?.())));
      await controller.dispose();
    };
  }, 'dsh-remote-control.lifecycle()');
}
