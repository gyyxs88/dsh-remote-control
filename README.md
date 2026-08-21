# dsh-remote-control

DSH 远程项目阶段 A/B：本机 Remote Control Connector、Linux x86_64 Remote Host stdio bridge、受信 bootstrap、版本化插件/Skill Desired State 同步、远端 operation/revision 对账，以及独立本机 Model Gateway 的 SSH 反向隧道接线。

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
- 独立 `ModelGateway` 进程边界：只绑定 `127.0.0.1`，按 Host 签发短期 token，模型名必须在本机 provider 目录中，绝不向远端发送底层密钥。
- SSH stdio bridge 和 SSH reverse tunnel 的严格 Host Key 参数构造；要求固定 `known_hosts` 和指纹/公钥 pin，禁止自动接受未知 key、`curl | sh` 和公网 reverse bind。
- Stage A Runtime Manager 只有接口和显式 `missing`/`needs-attention` 结果，不安装 Codex、Claude Code、Grok Build 或 ACP。

## 阶段 B 已交付

- `PluginRequirement` / `SkillRequirement` 使用版本化 Desired State，固定 `placement`、版本、受信来源、SHA-256、DSH/API 兼容范围和 `requiredBy`。
- `TrustedArtifactRegistry` 是唯一产物入口；未知插件、缺摘要、版本/API 不兼容、manifest 不匹配和生命周期安装脚本均 fail closed。项目插件不能提交任意远端安装命令。
- 同步器只选 `remote`/`both`，对真实 `.tgz` 做文件、归档、package manifest 和 SHA-256 校验；远端使用临时目录、探测、版本保留和 `current` 原子切换，已验证旧版本不被删除。
- 插件自带 Skill 由插件 manifest 绑定版本；项目 Skill 仍以独立 Desired State 项同步。凭据、Session JSONL/SQLite、operation 状态、日志、缓存和本机插件状态不进入同步。
- `project.open` 必须携带与 Desired State 绑定的已完成同步回执；`partial`、`incompatible`、`needs-attention` 和 `persistence-unknown` 不会静默创建 Session，并在 project/reconcile 摘要中保留。
- `dsh-session-control` 包含正式的 `dsh.remote` manifest 与 socket `ping` 返回的机读 capability/version 元数据，继续只负责单 Host 的 Workspace、Session、权限、审批和 Schedule。

## 安装与运行

本机依赖 Node.js 22 或更高版本；`dsh-session-control` 的正式 socket bridge 依赖 Node.js 24。Remote Host 正式目标是 Linux x86_64，启动前必须先配置并探测远端 DSH Host 内的正式 `dsh-session-control` service/port：

```bash
npm install
node bin/dsh-remote-host.mjs bridge --stdio \
  --data-dir "$HOME/.dsh-remote/state" \
  --session-control-socket /run/user/1000/dsh-session-control.sock
```

缺少 `--session-control-socket` 或 `--session-control-module`、socket probe 失败、或 port 未声明 `ready=true` 时，Remote Host 在启动前 fail closed，不宣称 `project.open` capability。若使用 module，它应导出 `createSessionControlPort()` 或默认的 `openProject()` port；它必须调用远端 DSH Host 内的正式 `dsh-session-control` 服务，不得直接写 Session JSONL 或 SQLite。正式 socket bridge 的配置见 `dsh-session-control` README。

SSH `expectedFingerprint` 使用 OpenSSH `ssh-keygen -lf` 兼容的 `SHA256:<Base64>` 格式：摘要使用标准 Base64 字符集，保留 `+`、`/`，移除尾部 `=`；代码会先读取并比对固定 `known_hosts` 中的实际 key，再启动 SSH。

### 首次安装

首装不依赖远端预装本包。部署层先用 `npm pack` 产生固定版本的 `.tgz`，在受信 catalog 中登记 artifact 的 `version/name/target/protocolVersion/size/sha256` 以及 installer 的 `installerSha256`，然后通过 `SshCommandTransport` 上传 installer 和 artifact。计划依次执行 `mkdir`、远端 `sha256sum` 校验 installer、`node dsh-remote-host-installer.mjs ... --atomic --no-root`、已安装 entrypoint probe 和清理；installer 将包放入 `versions/<version>/package`，再原子切换 `current`。若清理响应丢失，对账使用 `current/bin/dsh-remote-host-installer.mjs --status` 和持久 manifest，不依赖已删除的 staging 文件。`remoteRoot` 必须是远端绝对 POSIX 路径，不能使用会被远端 shell 误解释的 `~`。

本机 Gateway 由 DSH 控制面独立启动：

```bash
node bin/dsh-model-gateway.mjs --port 0
```

### 项目插件与 Skill 同步

控制面先从管理员维护的 `TrustedArtifactRegistry` 解析项目 Desired State，再通过同一受信 SSH/SFTP transport 上传产物。远端稳定入口为已安装版本中的 `current/bin/dsh-remote-artifact-installer.mjs`：它只接受固定的 kind/id/version/package/sha256，拒绝 root、路径逃逸、危险归档条目和 lifecycle script，不执行 `npm install` 或项目自带安装命令。

每个插件或项目 Skill 安装到 `<remoteRoot>/{plugins,skills}/<id>/versions/<version>/package`，只通过校验后的 `current` 指针启用。响应丢失时同步器只调用稳定的 `--status` 入口对账，不依赖 staging；不能证明终态就返回 `persistence-unknown`。未配置同步器时，只要 Desired State 有远端 requirement，`project.open` 会明确进入 `needs-attention`。

内置命令在没有 `--provider-module` 注入时只提供健康检查，不读取环境变量、配置文件、API Key 或登录目录，也不会调用真实模型。生产 provider/model/credential 解析由本机 DSH Gateway adapter 注入；adapter 通过进程内 token 使用路径服务 `/v1/models` 和 `/v1/generate`，token 只保留在进程内，持久状态仅保存 hash。测试使用 fake provider，绝不调用真实 provider。

## 开发与验证

```powershell
npm run check
npm run test:stage-a
npm run test:stage-b
npm run pack:check
```

测试使用 fake transport、fake session-control、临时文件、真实 `.tgz` 归档和本地 fake HTTP provider，不启动真实远端主机、不调用付费模型、不读取或测试任何真实密钥。阶段 A 证据见 [`docs/stage-a-acceptance.md`](docs/stage-a-acceptance.md)，阶段 B 证据见 [`docs/stage-b-acceptance.md`](docs/stage-b-acceptance.md)；两份记录都明确区分 fake/integration 代码验收与尚未授权的真实 Linux SSH 部署验收。

## 安全和恢复底线

- 未知或变化的 SSH Host Key 直接拒绝。
- Remote Host 与 Model Gateway 只使用 SSH stdio/反向隧道和 loopback，不开放公网端口。
- 本机凭据不下发远端；第三方 Agent 登录态不复制。
- 有副作用请求必须带 `operationId`、`idempotencyKey`、来源/目标身份、正文哈希和权限快照。
- 网络中断后先查询 operation；无法证明终态时进入 `needs-attention`，不盲目重复创建 Workspace、Session 或绑定。
- Remote Host 重启会把未到达 durable terminal state 的 operation 标为 `needs-attention`，Connector 只接受同一 incarnation 的不回退 revision。
- 审计状态只保存摘要、标识、结果和错误，不保存 prompt 全文、Gateway token、API Key、Cookie 或认证文件。

## 后续阶段

Codex/Claude/Grok/ACP 受信驱动与认证引导属于阶段 C；更完整的长任务恢复、诊断和实机平台扩展属于阶段 D。本仓库不会为了阶段 A/B 预装这些外部 Agent。

## License

MIT
