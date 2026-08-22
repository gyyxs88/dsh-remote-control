# 阶段 A/B/C 协议契约

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
  "idempotencyBody": {
    "absolutePath": "/srv/project",
    "desiredState": {}
  },
  "body": {},
  "bodySha256": "sha256(idempotencyBody)",
  "permissionSnapshot": {
    "preset": "workspace-write",
    "capturedAt": "2026-08-21T00:00:00.000Z",
    "expiresAt": "2026-08-21T00:15:00.000Z"
  }
}
```

Remote Host 以 `sourceHostId + sourceSessionId + targetHostId + idempotencyKey + bodySha256 + type` 查找既有 operation。相同请求返回原 operation，不再次调用 Session Control；同一幂等键绑定不同正文直接拒绝。`project.open` 必须显式携带 `idempotencyBody`，其中只包含绝对路径、规范化 Desired State 和调用者提供的 target/ticket/display/schedule 身份字段，不包含同步回执等远端派生字段；其他 operation 的 `bodySha256` 绑定其完整 body。

operation 状态为：`pending`、`running`、`completed`、`partial`、`failed`、`needs-attention`。只有 `completed`/`partial`/`failed`/`needs-attention` 是 durable terminal state。插件同步的细分状态位于 `project.pluginSync.status`，允许 `completed`、`partial`、`incompatible`、`needs-attention`、`persistence-unknown`；这些状态不能被压缩成成功或静默 fallback。断线、进程重启或传输层错误无法证明终态时只能进入 `needs-attention`，并保留 `persistence-unknown` 细分原因。

## Desired State 与可信 registry

`desiredState` 的插件、Skill 和 Runtime 项必须是以下版本化结构；没有摘要或没有 `TrustedArtifactRegistry` 精确 allowlist 项时拒绝：

```json
{
  "id": "dsh-session-control",
  "version": "0.6.0",
  "placement": "remote",
  "source": { "registry": "dsh-public", "artifact": "dsh-session-control-0.6.0.tgz" },
  "sha256": "64 个小写十六进制字符",
  "compatibility": {
    "dsh": { "min": "0.1.0-rc.6", "max": "0.1.1-rc.2" },
    "api": { "min": "1.0", "max": "1.0" }
  },
  "requiredBy": ["project:default"]
}
```

`placement` 只能是 `control`、`remote` 或 `both`。同步器只解析 `remote`/`both`；control-only 项不上传。Skill 的 `bundledWith` 必须指向同版本插件，并由插件 remote manifest 的 Skill 摘要覆盖；没有 `bundledWith` 的项目 Skill 单独安装。`source` 只是受信 registry 身份，不是允许项目提交并执行的 URL、Shell 或 npm 安装脚本。

Runtime requirement 额外固定 driver、认证策略、可执行相对路径和协议能力：

```json
{
  "id": "codex",
  "version": "0.1.0",
  "placement": "remote",
  "source": { "registry": "dsh-runtime-public", "artifact": "codex-0.1.0-linux-x86_64.tgz" },
  "sha256": "64 个小写十六进制字符",
  "size": 123456,
  "target": "linux-x86_64",
  "packageName": "dsh-runtime-codex",
  "executablePath": "bin/codex",
  "protocolVersion": "1.0",
  "driver": "codex",
  "authPolicy": "remote-user",
  "capabilities": ["exec", "app-server", "read-only", "workspace-write", "danger-full-access"],
  "compatibility": { "dsh": { "min": "0.1.0-rc.6", "max": "0.1.1-rc.2" }, "api": { "min": "1.0", "max": "1.0" } },
  "requiredBy": ["project:default"]
}
```

Runtime registry 必须同时证明 artifact 的文件名、版本、target、size、SHA-256、package manifest、`dsh.runtime` 身份、executable layout 和 protocol 一致；渠道的 `dsh.remote.channelRuntime` 只描述稳定需求，不冒充供应商版本。缺摘要、未知 runtime、版本/API 不兼容或可执行路径逃逸均拒绝。普通项目只能声明 allowlist 中的 runtime，不能提供安装脚本或供应商下载 URL。

registry 对本机固定文件做 regular-file、大小、SHA-256、tar entry、package identity、DSH/API manifest 和 lifecycle script 校验。远端安装入口固定为已部署版本中的 `dsh-remote-artifact-installer.mjs`，只在临时目录解包、探测后原子切换 `current`，旧的已验证版本和正在使用的版本不删除。

## Project Open

`body.absolutePath` 必须是远端 Linux 的 POSIX 绝对路径，禁止 traversal；`desiredState` 至少包含 DSH/API 版本、插件/Skill/Runtime 数组、初始权限和 `local-gateway-required` 或 `remote-autonomous` 路由。

有 remote/both requirement 时，`body.pluginSync` 和有 runtime requirement 时的 `body.runtimeSync` 必须包含 `desiredStateSha256`、每项绑定的 verified result 和 `status: completed`。缺少同步器、allowlist 拒绝、兼容性错误、部分成功或终态未知都会创建 `needs-attention` operation，不调用 Session Control；Connector 的 `project.open` response 与后续 `state.reconcile` 会返回该同步状态。成功回执只能覆盖每个远端 requirement，不能伪造 control-only 项的安装。

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

Schedule 清理使用独立的 `schedule.delete` operation：正文固定 `targetSessionId + scheduleId`，外层继续绑定 source/target/idempotency/body hash/permission snapshot。Remote Host 只调用正式 `SessionControlPort.deleteSchedule()`；成功回执保存 Session Control operation id，不直接写目标 Session。transport/response 终态未知时进入 needs-attention，只允许同一来源、同一正文和同一幂等键重放。

### Runtime 状态与认证 challenge

Runtime Manager 只返回以下状态：`not-required`、`missing`、`installing`、`auth-required`、`ready`、`installed-auth-unverified`、`update-required`、`incompatible`、`degraded`。没有可靠且不计费的认证探测时，安装/探测成功只能是 `installed-auth-unverified`；首次真实调用若发现未认证，必须转为 `auth-required`，不能伪造 `ready`。

`runtime.status` 和 `runtime.auth.challenge` 必须绑定 host handshake 与 exact runtime requirement。Remote Host 以固定 argv 启动受管认证进程，流式读取有界 stdout/stderr；一旦发现供应商公开 URL 或 user/device code，就返回 `challengeId`、公开字段和 `expiresAt`，进程仍由 daemon 持有。`runtime.auth.status` 对账进程的 pending/completed/failed/expired 状态，`runtime.auth.cancel` 取消并清理整个进程组；响应丢失只按 challengeId 查询，不重复启动。认证不是客户端提交 output 或 `authority` 字段自证：Remote Host 先为来源控制端、Host 和 runtime 生成 server nonce，调用正式 Session Control verifier 确认后才签发 ticket；`project.open` 可在新 target Session 创建前提交 ticket，但服务端会把它绑定到 `source + operationId + idempotencyKey + bodySha256` reservation。只有已经发出过 Session Control 调用的原 operation 才能在 ticket 交互期限后恢复对账；Session Control 返回真实 target 后，reservation 才 commit 为 exact target lease，最终 receipt 持久化后标记 consumed。reservation 不含秘密，跨 source、第二 operation、未使用 ticket 和重放 ticket 均拒绝。执行策略则只能在 Session 创建后按真实 target Session 查询。challenge 只允许返回 `runtimeId/version/state/methods`、公开登录 URL、设备码和过期时间，不返回或持久化完整 stdout、API key、OAuth token、Cookie、环境变量全文或认证目录。Codex 使用 `codex login`；Claude Code 使用 `claude auth login`；Grok 使用 `grok login --device-auth`；ACP 由 driver 定义认证协议。

Runtime Manager 在 daemon 进程边界外通过权限 `0600` 的 Unix socket 暴露 `runtime-manager.ping`、`runtime-manager.inspect` 和 `runtime-manager.resolve`。socket 外层携带 Host-scoped capability token、稳定 `sourceHostId/sourceSessionId`；`targetHostId/targetSessionId` 是远端 DSH 身份，不得复用 Connector 的来源 Session 字段。token 文件必须是当前用户拥有的 owner-only 普通文件，拒绝 symlink、可写父目录和权限漂移。resolve 只有在 daemon 已验证 project receipt、source/target 归属和 exact runtime 后才消费 auth lease，返回同一个绝对 executable；断线、重启、lease 过期或版本/hash 变化均 fail closed。

### ChannelExecutionPolicy

外部 Agent 启动请求只能从目标 Session Control verifier 注入 `ChannelExecutionPolicy`；公共 request 字段不能自证或覆盖它。策略为 `read-only`、`workspace-write` 或 `danger-full-access`，带匹配 owner、workspace root、source/target Session 和 verified provenance。只有 Full Access 可使用 bypass、always-approve 或 sandbox-off；Workspace Write 必须把人工审批留在目标子会话，Read Only 只能使用渠道正式只读能力。渠道无法兑现目标组合时在 spawn 前返回 `unsupported-permission-policy`；能力提示不是安全边界，DSH 外层沙箱仍是受限模式兜底。

## Reconcile

Connector 保存 `hostId`、`incarnationId` 和最后确认 revision，但不写远端 Session JSONL/SQLite。重连时发送 `state.reconcile`：

- incarnation 相同且 revision 不回退：接受远端 project/operation 摘要；
- 远端 revision 更高：更新本机只读缓存；
- 远端 revision 更低：返回 `accepted=false`，不覆盖本机已确认事实；
- incarnation 变化：`needs-attention`，要求显式重新采纳，禁止盲目重建。

Reconcile 必须同时读取 Desired State 目标 runtime identity 和本轮 rollback target；不能因为 staging 已清理而丢失判断能力。runtime sync 的回执与 desired digest、source/target host、每项 version/SHA-256/executable identity 绑定；rollback 未知时只能报告 `persistence-unknown`/`needs-attention`。

## Gateway

Gateway bind 也是幂等 operation。远端只保存 Gateway endpoint、过期时间和 token 的 SHA-256，不保存 token 明文。Endpoint 必须是 `http://127.0.0.1:<port>`。SSH 反向隧道使用：

```text
远端 127.0.0.1:<remotePort>
  -> SSH -R 127.0.0.1:<remotePort>:127.0.0.1:<localPort>
  -> 本机 127.0.0.1:<localPort>
```

Gateway 只暴露 loopback、Host-scoped 短期 token 和本机 provider 返回的模型目录；未知模型直接拒绝。
