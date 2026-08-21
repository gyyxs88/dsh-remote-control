# 安装、开发与接入说明

## 本机开发

```powershell
cd D:\Project\deepseek-harness-lab\dsh-remote-control
npm install
npm run check
npm run test:stage-a
npm run test:stage-b
npm run test:stage-c
npm run pack:check
```

核心 Remote Host 入口没有第三方运行时依赖；DSH 控制端插件使用当前 DSH 提供的 `@deepseek-ai/dsh-tools`、Schemastery 和同 profile 的 `dsh-session-control` peer。Windows 开发机上的测试不假设本机能启动 Linux Remote Host；Remote Host 入口会在非 Linux x86_64 上 fail closed。正式远端使用打包后的固定版本，并由本机 Connector 通过 SSH 上传经过 SHA-256 校验的 artifact。

## 控制端自然语言入口

1. `dsh-remote-control/plugin` 只向 `controllerSessionIds` 显式列出的普通控制会话挂载 `remote_*` 工具，同时注册 bundled `dsh-remote-project` Skill；配置为空时 fail closed。
2. 主机登记持久化到 owner-only `remote-hosts.json` 和每 Host 独立 `known_hosts`。只保存 SSH 别名、公开 Host Key、目录和服务身份；不保存私钥、密码、Gateway token、Cookie 或供应商凭据。同一 stateDir 只允许一个 DSH 进程持锁。
3. `remote_host_probe` 使用固定 argv 的 `ssh -G` 与 `ssh-keyscan`，返回公开候选指纹但不建立信任。只有 `remote_host_add` 收到用户已核对的精确 OpenSSH SHA-256 指纹后，才写入 managed pin 并以 BatchMode 探测非 root Linux x86_64/Node 24。
4. `remote_project_open` 首次使用时从本机已安装的受信包生成 Remote Host 和 `dsh-session-control` `.tgz`，从精确 DSH `package-lock.json` 生成 recipe；`npm pack --ignore-scripts`、摘要和 manifest 校验后才进入现有 bootstrap/sync 链路。默认从当前 DSH 根和 peer package 解析，也可用 `dshRecipeRoot` / `sessionControlPackageRoot` 显式固定。
5. 用户给出的项目路径必须是绝对 POSIX 路径并位于 Host 的 `allowedRoot`；路径不存在时由正式 Session Control project API 创建。变更允许根使用 `remote_host_update`，应选择能覆盖用户明确目录的最窄范围，不设为 `/`。
6. `danger-full-access` 控制器可自主执行；`workspace-write` 的登记、更新、项目、Schedule 等变更通过 DSH `tools/pre-execute` 留在当前控制会话审批。relay 消息不能触发远程工具。
7. 超时和断线时复用原幂等键并使用 `remote_project_reconcile`；Host/Session/Schedule 的 operation 和 revision 仍由远端正式服务判定，Skill 不自证成功。

## 远端 Host 接入

1. 本机必须已有一份由受信运维渠道确认的 `known_hosts`，以及匹配的 Host Key fingerprint 或 public key pin。fingerprint 使用 OpenSSH `SHA256:<Base64>` 格式，保留 `+`、`/` 且不带尾部 `=`；代码会在启动 `ssh` 前读取并比对实际条目，缺失或错误 key 直接拒绝。
2. 远端需具备 Linux x86_64、Node.js 24、npm、Corepack、tar 与可用的 systemd user service，并为该非 root 用户启用 linger；没有 linger 时安装器明确返回 `DSH_SERVICE_LINGER_REQUIRED`，不能把只在登录期间存活的进程冒充长期自主 Host。不要求预装 DSH、pnpm、本包或任何外部 Agent。Connector 使用 `StrictHostKeyChecking=yes`、固定 `UserKnownHostsFile` 和 `HostKeyAlias` 建立 SSH。
3. `DshHostBootstrapper` 先上传受信的 `package.json + package-lock.json` 配方和自包含 DSH installer；配方只允许一个精确 `@deepseek-ai/dsh` 依赖，所有顶层 DSH 包必须保持同一版本。普通项目插件继续禁用 lifecycle；DSH 本体只允许锁文件中五个已登记包的精确安装脚本，并必须通过 DSH 版本、`node-pty`、`koffi`、loopback HTTP 和 systemd service probe。Remote Root 收敛为 `0700`，服务 `enabled --now`，pnpm 由 Corepack 固定版本。
4. 通过 `SshLocalTunnel + DshHttpClient` 连接远端 loopback DSH API，创建固定 controller Workspace/Session；恢复 live Agent 使用 `session.rename`，不发送 prompt、不触发模型。插件 artifact 同步到不可变版本目录后，`writeDshProfileConfig()` 生成带摘要的 profile，远端核对每个 plugin manifest/package identity，再用 `pnpm install --ignore-scripts` 激活并重启 DSH。
5. Remote Host Bootstrap 只上传 trusted digest catalog 中的固定 `.tgz` artifact 和单文件自包含 installer；catalog 缺少 artifact 或 installer 摘要时拒绝。远端使用 `--sha256 --atomic --no-root`，执行 entrypoint probe 后再清理；若清理响应丢失，对账使用已安装 `current/bin/dsh-remote-host-installer.mjs --status`，不依赖 staging。全程不执行 `curl | sh`。
6. 远端通过 stdio bridge 启动 `dsh-remote-host`，`SshStdioBridge.remoteHostOptions` 显式传递 Session Control socket/module、Runtime Manager socket/token、Host id、allowed root 与 runtime root；不要求另建 wrapper 脚本。Host Agent 只保存自己的 Host/Project/Operation 摘要。
7. `SessionControlPort` 由远端 DSH Host 组装，连接该 Host 内的 `dsh-session-control` 正式服务；正式部署优先使用其 Unix socket bridge。远程仓库不能直接打开目标 Session 的 JSONL/SQLite，缺 port 时 daemon 启动即失败。
8. 本机 Model Gateway 监听 loopback，Connector 为远端 Host 建立短期 token 和 SSH reverse tunnel。断开 Gateway 时，原生 Agent 新轮次应等待 Gateway，而不是重新投递。

9. 项目 Desired State 由本机 `TrustedArtifactRegistry` 解析。registry entry 必须预先登记 artifact 文件名、版本、大小、SHA-256、package identity 和兼容范围；项目值不能自证可信，也不能提供安装脚本。`remote`/`both` 插件与独立项目 Skill 通过 `DesiredStateSynchronizer` 上传到 staging，再调用已安装版本的 `current/bin/dsh-remote-artifact-installer.mjs`。
10. 远端插件布局为 `<remoteRoot>/plugins/<id>/versions/<version>`，Skill 布局为 `<remoteRoot>/skills/<id>/versions/<version>`；只有 manifest、package identity、归档树和探测全部通过才原子切换 `current`。旧版本永不因升级删除，正在使用的版本不会被改写。正式 `--rollback` 只允许切回同 kind/id 下 manifest、版本、SHA-256、size、package、target、protocol 和 safeTree 均通过的已存在版本，或安全撤销到 `missing`。
11. 插件自带 Skill 必须由 plugin `dsh.remote.bundledSkills` manifest 按版本和摘要绑定；项目 Skill 没有 `bundledWith` 时独立传输。凭据、Session JSONL/SQLite、operation 状态、日志、缓存、本机插件状态均不在同步范围内。
12. 每个 action 开始前记录 previous current receipt；后续 action 确定失败时，按逆序调用 `--rollback` 恢复本轮可能切换的 action。同步回执保留 rollback `attempted`、`completed`、`failed` 或 `unknown`。同步清理或 rollback 响应丢失时，只用稳定 `--status` 入口同时对账 Desired State 目标和 rollback 目标；staging 已不存在也不能阻止判断。若 rollback 终态仍不能证明，返回 `persistence-unknown`，`project.open` 不创建 Session。

## 阶段 C Runtime Manager

Runtime Manager 只接收管理员预登记的 Linux x86_64 runtime artifact。项目 Desired State 的 runtime 项固定版本、target、size、SHA-256、package name、绝对 executable 的相对布局、protocol、driver、认证策略和兼容范围；项目不能提供 URL、curl|sh 或安装脚本。安装过程沿用 Stage B 的临时目录、非 root、safeTree、probe、原子 current、旧版保留、rollback 和稳定 status 对账。

Runtime 仅按需同步：没有 Codex/Claude/Grok/ACP requirement 就不安装任何外部 Agent。远端渠道启动通过 `RuntimeManager.resolveExecutable()` 获取已验证的绝对路径，缺少 manager、runtime 不兼容、未安装或认证状态不满足时结构化拒绝，不回退到 PATH。

认证方法以官方能力为准。固定 argv 启动后，公开 URL/设备码会在进程结束前通过 `runtime.auth.challenge` 返回；随后用 `runtime.auth.status` 查询完成/失败/过期，或用 `runtime.auth.cancel` 取消。Remote Host 不把完整 stdout 写入日志，不接受调用方提交的 output，不重复启动同一 exact runtime 的活动 challenge：

- [OpenAI Codex CLI 登录说明](https://help.openai.com/en/articles/11096431) 与 [Codex app-server](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md)：远端用户完成官方登录；app-server 的 approvals/sandbox profile 由 policy 映射。
- [Claude Code authentication](https://code.claude.com/docs/en/authentication)、[permissions](https://code.claude.com/docs/en/permissions) 和 [sandboxing](https://code.claude.com/docs/en/sandboxing)：支持官方账户/API/企业提示，不复制登录目录。
- [Grok CLI reference](https://docs.x.ai/build/cli/reference)、[headless scripting](https://docs.x.ai/build/cli/headless-scripting) 和 [permissions](https://docs.x.ai/build/features/permissions)：支持 device-auth/API；设备码 challenge 只保留脱敏公开 URL/设备码。
- [ACP](https://agentclientprotocol.com/)：认证和能力由具体 driver 协商，未知组合 fail closed。

Runtime 状态包括 `not-required`、`missing`、`installing`、`auth-required`、`ready`、`installed-auth-unverified`、`update-required`、`incompatible`、`degraded`。无可靠且不计费的认证探测时，安装后是 `installed-auth-unverified`，不能宣称 `ready`；challenge 过期转为 `auth-required`。认证秘密只留远端用户/driver 进程内，绝不读写或复制 `~/.codex`、`~/.claude`、`~/.grok`、Cookie、OAuth token 或 API key。

`ChannelExecutionPolicy` 从目标 Session 继承三档权限：只有 `danger-full-access` 可以使用 bypass/always-approve/sandbox-off；`workspace-write` 的人工审批留在目标子会话，渠道不支持的组合在启动前返回 `unsupported-permission-policy`，DSH 外层 sandbox 仍是受限模式的安全边界。

## SessionControlPort module

接入模块示意：

```js
import { DshSessionControlPort } from 'dsh-remote-control';

export function createSessionControlPort() {
  return new DshSessionControlPort({
    async openProject(request, context) {
      // 这里调用远端 DSH Host 内正式 dsh-session-control 服务。
      // 不在此处复制 Session JSONL、SQLite、权限或 Schedule。
      return officialSessionControl.openProject(request, context);
    },
  });
}
```

`openProject` 返回至少 `workspaceId`、`sessionId`；可选返回 `projectId`、`workspacePath`、`permissionPreset`、`scheduleState` 和 `state: 'partial'`。

正式 `dsh-session-control` 配置示例：

```yaml
remoteProjectSocket: /run/user/1000/dsh-session-control.sock
remoteProjectHostId: remote-host-01
```

socket bridge 接受机读 ping、project.open、schedule-create/delete、runtime-auth 与 execution-policy 正式帧，串行转发到官方 API，并绑定 Host/source/target；不创建第二份 Session 存储。

## 不做的事

- 不把本机 `.dsh-home`、Provider 凭据或第三方 CLI 登录目录复制到远端。
- 不在 Stage A 中安装或认证 Codex、Claude Code、Grok Build、ACP。
- 不让远端 Host 监听公网端口。
- 不把 fake port 当成生产 DSH Session 实现。
