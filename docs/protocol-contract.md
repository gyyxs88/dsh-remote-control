# 阶段 A/B 协议契约

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

operation 状态为：`pending`、`running`、`completed`、`partial`、`failed`、`needs-attention`。只有 `completed`/`partial`/`failed`/`needs-attention` 是 durable terminal state。插件同步的细分状态位于 `project.pluginSync.status`，允许 `completed`、`partial`、`incompatible`、`needs-attention`、`persistence-unknown`；这些状态不能被压缩成成功或静默 fallback。断线、进程重启或传输层错误无法证明终态时只能进入 `needs-attention`，并保留 `persistence-unknown` 细分原因。

## Desired State 与可信 registry

`desiredState` 的插件和 Skill 项必须是以下版本化结构；没有摘要或没有 `TrustedArtifactRegistry` 精确 allowlist 项时拒绝：

```json
{
  "id": "dsh-session-control",
  "version": "0.6.0",
  "placement": "remote",
  "source": { "registry": "dsh-public", "artifact": "dsh-session-control-0.6.0.tgz" },
  "sha256": "64 个小写十六进制字符",
  "compatibility": {
    "dsh": { "min": "0.1.0-rc.6", "max": "0.1.0-rc.6" },
    "api": { "min": "1.0", "max": "1.0" }
  },
  "requiredBy": ["project:default"]
}
```

`placement` 只能是 `control`、`remote` 或 `both`。同步器只解析 `remote`/`both`；control-only 项不上传。Skill 的 `bundledWith` 必须指向同版本插件，并由插件 remote manifest 的 Skill 摘要覆盖；没有 `bundledWith` 的项目 Skill 单独安装。`source` 只是受信 registry 身份，不是允许项目提交并执行的 URL、Shell 或 npm 安装脚本。

registry 对本机固定文件做 regular-file、大小、SHA-256、tar entry、package identity、DSH/API manifest 和 lifecycle script 校验。远端安装入口固定为已部署版本中的 `dsh-remote-artifact-installer.mjs`，只在临时目录解包、探测后原子切换 `current`，旧的已验证版本和正在使用的版本不删除。

## Project Open

`body.absolutePath` 必须是远端 Linux 的 POSIX 绝对路径，禁止 traversal；`desiredState` 至少包含 DSH/API 版本、插件/Skill/Runtime 数组、初始权限和 `local-gateway-required` 或 `remote-autonomous` 路由。

有 remote/both requirement 时，`body.pluginSync` 必须包含 `desiredStateSha256`、每项的 verified result 和 `status: completed`。缺少同步器、allowlist 拒绝、兼容性错误、部分成功或终态未知都会创建 `needs-attention` operation，不调用 Session Control；Connector 的 `project.open` response 与后续 `state.reconcile` 会返回该同步状态。成功回执只能覆盖每个远端 requirement，不能伪造 control-only 项的安装。

同步回执还包含 rollback 事实：

```json
{
  "rollback": {
    "attempted": true,
    "status": "completed",
    "items": [
      {
        "key": "plugin:example@1.0.0",
        "status": "completed",
        "target": {
          "status": "installed",
          "version": "1.0.0",
          "sha256": "...",
          "size": 1234,
          "packageName": "dsh-example",
          "target": "linux-x86_64",
          "protocolVersion": "1.0"
        }
      }
    ]
  }
}
```

每个 action 在切换前记录 `previous` current receipt。后续 action 确定失败时，已可能切换的 action 按逆序调用受信 installer 的 `--rollback`；`--rollback` 只接受同 kind/id 下已存在且 manifest、版本、SHA-256、size、package、target、protocol 和 safeTree 全部有效的版本，或 `target: missing`。它只原子切换/撤销 `current`，不删除新旧 versions，不执行 lifecycle script。rollback 响应丢失后，`state.reconcile` 同时读取 Desired State 目标和 rollback 目标的稳定 `--status`；rollback `unknown` 时整体只能是 `persistence-unknown`，不能降级成普通 `partial`。

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
