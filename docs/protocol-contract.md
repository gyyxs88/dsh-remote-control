# 阶段 A 协议契约

协议名称为 `dsh-remote-control`，当前版本 `1.0`。兼容规则是同一 major 才能握手，minor 取双方较小值；major 不同直接拒绝。所有 JSON frame 都是一条独立消息，stdio bridge 外层可带 `{ "id": string, "message": object }`。

## Host Hello

Connector 发送：

```json
{
  "type": "host.hello",
  "protocol": { "name": "dsh-remote-control", "major": 1, "minor": 0, "version": "1.0" },
  "sourceHostId": "local-host",
  "sourceSessionId": "controller-session",
  "capabilities": ["host.hello", "project.open", "state.reconcile"]
}
```

Remote Host 返回 `host.hello.response`，包括 `hostId`、同一 incarnation 内稳定的 `incarnationId`、DSH 版本、`linux/x86_64` 平台、能力集合和当前 durable `revision`。Host 重装或状态重建必须产生新的 incarnation。

## Operation envelope

所有副作用 operation 共享以下字段：

```json
{
  "type": "project.open",
  "operationId": "uuid",
  "idempotencyKey": "project.open:sha256-prefix",
  "sourceHostId": "local-host",
  "sourceSessionId": "controller-session",
  "targetHostId": "remote-host",
  "body": {},
  "bodySha256": "sha256(body)",
  "permissionSnapshot": {
    "preset": "workspace-write",
    "capturedAt": "2026-08-21T00:00:00.000Z",
    "expiresAt": "2026-08-21T00:15:00.000Z"
  }
}
```

Remote Host 以 `idempotencyKey + bodySha256 + type` 查找既有 operation。相同请求返回原 operation，不再次调用 Session Control；同一幂等键绑定不同正文直接拒绝。

operation 状态为：`pending`、`running`、`completed`、`partial`、`failed`、`needs-attention`。只有 `completed`/`partial`/`failed`/`needs-attention` 是 durable terminal state。断线、进程重启或传输层错误无法证明终态时只能进入 `needs-attention`。

## Project Open

`body.absolutePath` 必须是远端 Linux 的 POSIX 绝对路径，禁止 traversal；`desiredState` 至少包含 DSH 版本、插件/Skill/Runtime 数组、初始权限和 `local-gateway-required` 或 `remote-autonomous` 路由。

Remote Host 先检查 allowed root 和 Runtime Manager，再通过 `SessionControlPort.openProject()` 调用目标 Host 的正式 `dsh-session-control` 服务。该 port 负责按既有语义创建/复用目录、Workspace、Session、权限和 Schedule；返回的 `workspaceId`/`sessionId` 才能写入本仓库的 Project 摘要。Partial 成功原样保留，不删除用户目录、Git 数据或已经创建的会话。

阶段 A Runtime Manager 对非空 runtime requirement 返回 `missing`，不会安装外部 Agent；只有空 runtime 集合可直接完成原生 DSH Agent 项目。

## Reconcile

Connector 保存 `hostId`、`incarnationId` 和最后确认 revision，但不写远端 Session JSONL/SQLite。重连时发送 `state.reconcile`：

- incarnation 相同且 revision 不回退：接受远端 project/operation 摘要；
- 远端 revision 更高：更新本机只读缓存；
- 远端 revision 更低：返回 `accepted=false`，不覆盖本机已确认事实；
- incarnation 变化：`needs-attention`，要求显式重新采纳，禁止盲目重建。

## Gateway

Gateway bind 也是幂等 operation。远端只保存 Gateway endpoint、过期时间和 token 的 SHA-256，不保存 token 明文。Endpoint 必须是 `http://127.0.0.1:<port>`。SSH 反向隧道使用：

```text
远端 127.0.0.1:<remotePort>
  -> SSH -R 127.0.0.1:<remotePort>:127.0.0.1:<localPort>
  -> 本机 127.0.0.1:<localPort>
```

Gateway 只暴露 loopback、Host-scoped 短期 token 和本机 provider 返回的模型目录；未知模型直接拒绝。
