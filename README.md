# dsh-remote-control

DSH 远程项目阶段 A/B/C：本机 Remote Control Connector、Linux x86_64 上锁定版 DSH/Remote Host 自动部署、stdio bridge、版本化插件/Skill/Runtime Desired State 同步、外部 Agent Runtime Manager、远端 operation/revision 对账，以及独立本机 Model Gateway 的 SSH 反向隧道接线。

本仓库是公开的跨主机控制面仓库：<https://github.com/gyyxs88/dsh-remote-control>。

## 仓库边界

`dsh-session-control` 继续是单个 DSH Host 内的权威语义实现，负责 Workspace、Session、权限、审批和 Schedule 的事件/状态写入。本仓库不复制其 JSONL、SQLite、Session Registry 或审批逻辑，也不把 SSH、bootstrap、Remote Host、Runtime Manager 或 Model Gateway 堆进那个插件。

远端 Host 通过 `SessionControlPort` 注入正式的 `dsh-session-control` 服务。仓库内的 `FakeSessionControlPort` 只用于协议集成测试，不是生产会话存储。

## 阶段 A 已交付

- `Host/Project/Operation/Capability` 协议、major/minor 协商和正文 SHA-256 绑定。
- Linux x86_64 `dsh-remote-host bridge --stdio` 守护进程入口；仅通过 SSH stdio 使用，不监听公网端口。
- 本机 Connector：握手、项目打开、operation 查询、revision 对账和 Host incarnation 变化 fail closed。
- 远端绝对 POSIX 路径 → Workspace → Session 的幂等调用链；真实 Workspace/Session 由注入的 `dsh-session-control` 服务创建和 attach。
- 持久 host state 与 operation 快照；Host 重启时无法证明终态的 operation 进入 `needs-attention`。
- 受信 artifact 的 SHA-256/尺寸校验、固定目标校验、无 root、临时目录和版本目录原子切换基础。
- 全新 Host 的 `DshHostBootstrapper`：上传固定 SHA-256 的 `package.json + package-lock.json` 配方，以非 root `npm ci` 安装精确 DSH 版本，固定 Corepack/pnpm，探测 `node-pty`/`koffi` 原生模块，创建 owner-only 根目录和只监听 loopback 的持久 systemd user service。DSH 安装脚本只允许锁文件中预登记的五个精确包；普通项目插件仍禁止 lifecycle script。
- 独立 `ModelGateway` 进程边界：只绑定 `127.0.0.1`，按 Host 签发短期 token，模型名必须在本机 provider 目录中，绝不向远端发送底层密钥。
- SSH stdio bridge 和 SSH reverse tunnel 的严格 Host Key 参数构造；要求固定 `known_hosts` 和指纹/公钥 pin，禁止自动接受未知 key、`curl | sh` 和公网 reverse bind。
- Stage C Runtime Manager 只接受管理员预登记的固定 artifact；不执行供应商安装脚本、不调用真实 provider，也不把第三方登录目录带过边界。

## 阶段 B 已交付

- `PluginRequirement` / `SkillRequirement` 使用版本化 Desired State，固定 `placement`、版本、受信来源、SHA-256、DSH/API 兼容范围和 `requiredBy`。
- `TrustedArtifactRegistry` 是唯一产物入口；未知插件、缺摘要、版本/API 不兼容、manifest 不匹配和生命周期安装脚本均 fail closed。项目插件不能提交任意远端安装命令。
- 同步器只选 `remote`/`both`，对真实 `.tgz` 做文件、归档、package manifest 和 SHA-256 校验；远端使用临时目录、探测、版本保留和 `current` 原子切换，已验证旧版本不被删除。正式 rollback API/CLI 只切换到 manifest、版本、摘要、package、target、protocol 和 safeTree 均通过的旧版本，也支持安全撤销到 `missing`，不删除任何版本。
- 插件自带 Skill 由插件 manifest 绑定版本；项目 Skill 仍以独立 Desired State 项同步。凭据、Session JSONL/SQLite、operation 状态、日志、缓存和本机插件状态不进入同步。
- `project.open` 必须携带与 Desired State 绑定的已完成同步回执；`partial`、`incompatible`、`needs-attention` 和 `persistence-unknown` 不会静默创建 Session，并在 project/reconcile 摘要中保留。多 action 中后续 action 确定失败时，已切换 action 按逆序 rollback；回执记录 rollback `completed`/`failed`/`unknown`，未知 rollback 终态只报告 `persistence-unknown`。
- `dsh-session-control` 包含正式的 `dsh.remote` manifest 与 socket `ping` 返回的机读 capability/version 元数据，继续只负责单 Host 的 Workspace、Session、权限、审批和 Schedule。

## 阶段 C 已交付

- 渠道包的 `dsh.remote.channelRuntime` 只声明稳定 runtime id、driver、protocol/capability 和 DSH/API 兼容范围；管理员 `channelPins` 再从可含多版本的受信 catalog 解析 exact `RuntimeRequirement`（version/source/size/SHA-256/package/executable/`requiredBy`）。安装包自身的身份仍只由 `dsh.runtime` manifest 校验，不能把渠道包版本冒充供应商 runtime 版本。
- Runtime Manager 复用 Stage B 的受信 catalog、非 root、临时目录、探测、原子 `current`、旧版保留/rollback 和 stable status reconcile；只安装项目实际需要的 runtime，不从 PATH 猜测，也不接受项目任意安装脚本。
- Runtime 状态统一为 `not-required`、`missing`、`installing`、`auth-required`、`ready`、`installed-auth-unverified`、`update-required`、`incompatible`、`degraded`。没有可靠且不计费的认证探测时只报告 `installed-auth-unverified`，不伪造 `ready`。
- 认证由远端受信 driver 以固定 `codex login`、`claude auth login`、`grok login --device-auth` argv 启动受管进程；一旦流式输出公开 URL/设备码就立即返回 `challengeId`，进程继续由 Remote Host 托管，`runtime.auth.status`/`runtime.auth.cancel` 可查询、取消、对账或在 daemon 关闭时清理。只返回脱敏状态、公开 URL 和设备码，不返回完整 stdout；首次调用前仍必须经过 Remote Host 生成 nonce、正式 Session Control 确认和来源绑定的 reservation。reservation 只持久化公开 runtime identity、source、operation、body hash、nonce/期限和状态；Session Control 响应丢失或 daemon 重启时，只允许原 operation/idempotency/body 重放并绑定同一 Session，完成后 reservation 标记 consumed，不能被第二来源或第二项目使用。
- `dsh-subagent-code-agents` 每个渠道 manifest 暴露 `dsh.remote.channelRuntime`，启动从 Runtime Manager 获取绝对 executable。`ChannelExecutionPolicy` 只能来自目标 DSH Session 的受信 verifier；只有 Full Access 可用 bypass/always-approve/sandbox-off；Workspace Write 保留目标子会话审批，渠道无法兑现的组合启动前结构化拒绝。
- 多 runtime 部分失败按逆序恢复旧版本；Session Control 仅在 runtime 同步、权限和认证前置条件均可证明成功后调用，回执绑定 desired digest、runtime identity 和 rollback 事实。

## 安装与运行

本机依赖 Node.js 22 或更高版本；`dsh-session-control` 的正式 socket bridge 依赖 Node.js 24。Remote Host 正式目标是 Linux x86_64。冷启动部署要求远端已有 Node.js 24、npm、Corepack、tar、systemd user service，并为该非 root 用户启用 linger；不要求预装 DSH、pnpm、本仓库或项目插件，也不要求 root。`DshHostBootstrapper` 会自动安装并探测 DSH，再通过 loopback SSH local tunnel 创建固定 controller Session、激活正式 `dsh-session-control` profile；完成后 Remote Host 才能启动：

```bash
npm install
node bin/dsh-remote-host.mjs bridge --stdio \
  --data-dir "$HOME/.dsh-remote/state" \
  --session-control-socket /run/user/1000/dsh-session-control.sock \
  --runtime-manager-socket /run/user/1000/dsh-runtime-manager.sock \
  --runtime-manager-token-file /home/dsh/.dsh-remote/runtime-manager.token
```

缺少 `--session-control-socket` 或 `--session-control-module`、socket probe 失败、或 port 未声明 `ready=true` 时，Remote Host 在启动前 fail closed，不宣称 `project.open` capability。若使用 module，它应导出 `createSessionControlPort()` 或默认的 `openProject()` port；它必须调用远端 DSH Host 内的正式 `dsh-session-control` 服务，不得直接写 Session JSONL 或 SQLite。正式 socket bridge 的配置见 `dsh-session-control` README。

`SshStdioBridge` 同样要求显式传入 `remoteHostOptions`，其中必须且只能配置一个 `sessionControlSocket`/`sessionControlModule`；Runtime Manager 的 socket、token 文件、Host id、runtime root 与 allowed root 也通过该对象作为独立 argv 传给远端入口。Connector 不再依赖远端 wrapper 脚本暗中补参数，缺少正式 Session Control 边界时在本机启动 SSH 前即拒绝。

配置 `--runtime-manager-socket` 时，daemon 同时启动权限为 `0600` 的 Runtime Manager Unix service。它只接受带 Host-scoped capability token 的 `runtime-manager.ping`、`runtime-manager.inspect` 和 `runtime-manager.resolve`；token 文件不存在时由 daemon 原子生成，必须是当前用户拥有的 owner-only 普通文件，拒绝 symlink、可写父目录和权限漂移。resolve 外层同时携带稳定的 `runtimeManagerSourceHostId/runtimeManagerSourceSessionId` 与真实 `targetSessionId`：transport/controller 来源和远端 DSH target 是不同身份层，服务端用 project receipt 同时核对三者。DSH channel 通过同一 token 文件创建 `UnixSocketRuntimeManager`，不能注入 JS 函数或 manager 对象；socket 断开、daemon 重启、receipt 漂移和首次认证 lease 过期均返回结构化失败。

Connector 不再隐式生成每次随机的生产身份。使用 `RemoteControlConnector.create({ identityFile })` 生成或恢复 owner-only 的 `connector-identity.json`，再把返回的 `sourceHostId/sourceSessionId` 与远端 DSH Host 上真实存在的 `controllerSessionId` 显式传给 `createRemoteProjectSourceRegistration(identity, { controllerSessionId })`，写入远端 `dsh-session-control` 的精确 `remoteProjectSourceAllowlist`。`sourceSessionId` 是 Connector 外部来源身份，不是远端 controller Session；缺少显式 controller 身份时 helper fail closed。未完成登记时服务端以 `REMOTE_PROJECT_SOURCE_NOT_REGISTERED` 和精确身份回报 `needs-attention`，不会把空 allowlist 当作允许全部来源。

SSH `expectedFingerprint` 使用 OpenSSH `ssh-keygen -lf` 兼容的 `SHA256:<Base64>` 格式：摘要使用标准 Base64 字符集，保留 `+`、`/`，移除尾部 `=`；代码会先读取并比对固定 `known_hosts` 中的实际 key，再启动 SSH。

### 首次安装

首次安装分两层，均不依赖远端预装本包：

1. `DshHostBootstrapper` 校验管理员 catalog 中的 DSH 锁文件配方和自包含 `dsh-remote-dsh-installer.mjs`，上传后再次校验 installer 摘要；远端只在用户目录安装精确 DSH/pnpm，原生模块和回环服务健康后才原子切换。DSH profile 配置是动态但带 SHA-256 的结构化文件；远端再次核对不可变插件版本目录中的 manifest/package 身份后才运行 `pnpm install --ignore-scripts` 并重启服务。controller/target 通过 `session.rename` 的正式 HTTP API 恢复为 live Agent，不发送 prompt，也不触发模型调用。
2. 部署层再用 `npm pack` 产生固定版本的 Remote Host `.tgz`，在受信 catalog 中登记 artifact 的 `version/name/target/protocolVersion/size/sha256` 以及 installer 的 `installerSha256`，通过 `SshCommandTransport` 上传。Remote Host installer 同样是单文件自包含入口，执行远端摘要校验、atomic/no-root 安装、entrypoint probe 和清理；已存在同版本从 `versions/<version>/package/manifest.json` 复核，响应丢失用稳定 installed installer `--status` 对账。

两个 `remoteRoot` 都必须是远端绝对 POSIX 路径，不能使用 `~`。SFTP 上传目标只接受可移植的绝对 POSIX 字符集，并作为原始 `host:/path` argv 交给 OpenSSH，不能把 shell 引号作为目标文件名的一部分。

本机 Gateway 由 DSH 控制面独立启动：

```bash
node bin/dsh-model-gateway.mjs --port 0
```

### 项目插件与 Skill 同步

控制面先从管理员维护的 `TrustedArtifactRegistry` 解析项目 Desired State，再通过同一受信 SSH/SFTP transport 上传产物。远端稳定入口为已安装版本中的 `current/bin/dsh-remote-artifact-installer.mjs`：它只接受固定的 kind/id/version/package/sha256，拒绝 root、路径逃逸、危险归档条目和 lifecycle script，不执行 `npm install` 或项目自带安装命令。

每个插件或项目 Skill 安装到 `<remoteRoot>/{plugins,skills}/<id>/versions/<version>/package`，只通过校验后的 `current` 指针启用。插件与其 bundled Skill 可以使用相同 id/version；重复校验按 `kind + id + version + placement` 隔离，同 kind 的真正重复项仍拒绝。每个 action 开始前记录 current receipt；响应丢失或后续 action 失败时，同步器调用稳定的 `--rollback`/`--status` 入口按逆序恢复，不依赖 staging。rollback 目标已是旧版时返回 `already-current`，目标是 missing 时安全撤销 current 指针并保留 versions；不能证明恢复终态就返回 `persistence-unknown`。未配置同步器时，只要 Desired State 有远端 requirement，`project.open` 会明确进入 `needs-attention`。

内置命令在没有 `--provider-module` 注入时只提供健康检查，不读取环境变量、配置文件、API Key 或登录目录，也不会调用真实模型。生产 provider/model/credential 解析由本机 DSH Gateway adapter 注入；adapter 通过进程内 token 使用路径服务 `/v1/models` 和 `/v1/generate`，token 只保留在进程内，持久状态仅保存 hash。测试使用 fake provider，绝不调用真实 provider。

## 开发与验证

```powershell
npm run check
npm run test:stage-a
npm run test:stage-b
npm run test:stage-c
npm run pack:check
```

单元/集成测试使用 fake transport、fake session-control、临时文件、真实 `.tgz` 归档、fake runtime/artifact/auth output 和本地 fake HTTP provider，不调用付费模型、不读取或测试真实密钥。阶段 A/B/C 代码证据见 [`docs/stage-a-acceptance.md`](docs/stage-a-acceptance.md)、[`docs/stage-b-acceptance.md`](docs/stage-b-acceptance.md) 和 [`docs/stage-c-acceptance.md`](docs/stage-c-acceptance.md)；LAN 212 的全新目录自动部署、真实 SSH/Unix socket/Workspace/Session/Schedule/权限/重启证据见 [`docs/lan212-real-host-acceptance.md`](docs/lan212-real-host-acceptance.md)。

## 安全和恢复底线

- 未知或变化的 SSH Host Key 直接拒绝。
- Remote Host 与 Model Gateway 只使用 SSH stdio/反向隧道和 loopback，不开放公网端口。
- 本机凭据不下发远端；第三方 Agent 登录态不复制。
- 有副作用请求必须带 `operationId`、`idempotencyKey`、来源/目标身份、正文哈希和权限快照。
- 网络中断后先查询 operation；无法证明终态时进入 `needs-attention`，不盲目重复创建 Workspace、Session 或绑定。
- Session Control 已执行但返回身份字段不可判定时同样进入 `needs-attention`；只允许原来源、同正文和同幂等键重放，由 Session Control 返回同一 Workspace/Session 后再完成 Remote Host receipt。
- 远端项目创建附带 Schedule 后，清理通过正式 Unix Socket `remote-project.schedule-delete` 调用 Session Control 的 `deleteSchedule`；请求绑定来源 controller、目标 Session、schedule id 与幂等键，不直接改 Session 日志。
- 本机通过 `RemoteControlConnector.deleteSchedule()` 提交 `schedule.delete` operation；响应丢失只允许同来源、同正文和同幂等键重放，远端以正式 Session Control operation 对账，不需要另开 SSH 命令绕过控制通道。
- Remote Host 重启会把未到达 durable terminal state 的 operation 标为 `needs-attention`，Connector 只接受同一 incarnation 的不回退 revision。
- 审计状态只保存摘要、标识、结果和错误，不保存 prompt 全文、Gateway token、API Key、Cookie 或认证文件。

## 后续阶段

更完整的长任务恢复、诊断和实机平台扩展属于阶段 D。本仓库不会为了阶段 C 预装所有外部 Agent，也不会在没有受信 artifact 时虚构供应商自动安装。

## License

MIT
