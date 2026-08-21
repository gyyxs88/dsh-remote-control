# dsh-remote-control

DSH 远程项目阶段 A：本机 Remote Control Connector、Linux x86_64 Remote Host stdio bridge、受信 bootstrap 基础、远端 operation/revision 对账，以及独立本机 Model Gateway 的 SSH 反向隧道接线。

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

## 安装与运行

本机依赖 Node.js 22 或更高版本。Remote Host 正式目标是 Linux x86_64，启动前需要由部署层提供真实的 `dsh-session-control` port module：

```bash
npm install
node bin/dsh-remote-host.mjs bridge --stdio \
  --data-dir "$HOME/.dsh-remote/state" \
  --session-control-module /absolute/path/to/session-control-port.mjs
```

该 module 应导出 `createSessionControlPort()` 或默认的 `openProject()` port。它必须调用远端 DSH Host 内的正式 `dsh-session-control` 服务；不要在 module 中直接写 Session JSONL 或 SQLite。

本机 Gateway 由 DSH 控制面独立启动：

```bash
node bin/dsh-model-gateway.mjs --port 0
```

内置命令在没有 provider 注入时只提供健康检查，不读取环境变量、配置文件、API Key 或登录目录，也不会调用真实模型。生产 provider/model/credential 解析由本机 DSH Gateway adapter 注入。

## 开发与验证

```powershell
npm run check
npm run test:stage-a
npm run pack:check
```

测试使用 fake transport、fake session-control、临时文件和本地 HTTP provider，不启动真实远端主机、不调用付费模型、不读取或测试任何真实密钥。完整验收证据见 [`docs/stage-a-acceptance.md`](docs/stage-a-acceptance.md)。

## 安全和恢复底线

- 未知或变化的 SSH Host Key 直接拒绝。
- Remote Host 与 Model Gateway 只使用 SSH stdio/反向隧道和 loopback，不开放公网端口。
- 本机凭据不下发远端；第三方 Agent 登录态不复制。
- 有副作用请求必须带 `operationId`、`idempotencyKey`、来源/目标身份、正文哈希和权限快照。
- 网络中断后先查询 operation；无法证明终态时进入 `needs-attention`，不盲目重复创建 Workspace、Session 或绑定。
- Remote Host 重启会把未到达 durable terminal state 的 operation 标为 `needs-attention`，Connector 只接受同一 incarnation 的不回退 revision。
- 审计状态只保存摘要、标识、结果和错误，不保存 prompt 全文、Gateway token、API Key、Cookie 或认证文件。

## 后续阶段

插件/Skill Desired State、固定版本同步和原子回滚属于阶段 B；Codex/Claude/Grok/ACP 受信驱动与认证引导属于阶段 C；更完整的长任务恢复、诊断和实机平台扩展属于阶段 D。本仓库不会为了阶段 A 预装这些外部 Agent。

## License

MIT
