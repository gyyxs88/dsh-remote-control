# 阶段 C 验收记录

状态：代码闭环与 fake/integration 验收完成；真实 Linux x86_64 SSH 部署、真实第三方登录和真实 provider 仍未验收。

范围：外部 Agent RuntimeRequirement/Runtime Manager、Codex/Claude Code/Grok Build/ACP driver、认证状态/challenge、ChannelExecutionPolicy、按需 runtime Desired State、绝对 executable 接线、多 runtime rollback/reconcile，以及多 Agent 公共 manifest。未实现阶段 D 的长任务恢复、实机平台扩展或供应商安装器。

## 代码与测试证据

| 项目 | 证据 |
| --- | --- |
| 受信 runtime 协议 | `RuntimeRequirement` 固定 id/version/placement/source/SHA-256/size/target/package/executable/protocol/driver/auth policy、DSH/API compatibility 和 `requiredBy`；catalog 缺摘要、未知项、版本/API 不兼容、manifest/target/size/digest 不一致均 fail closed。 |
| 按需安装 | `RuntimeSynchronizer` 只计划 Desired State 中实际需要的 remote runtime；无 runtime requirement 不安装 Codex、Claude、Grok 或 ACP，缺 manager/receipt 不静默 fallback。 |
| 安装安全性 | 复用 Stage B artifact installer 的非 root、临时目录、safeTree、probe、原子 current、旧版保留、rollback 和 stable status；runtime executable 必须 regular non-symlink 且 Linux 下可执行。 |
| 运行时状态 | 覆盖 `missing`、`installed-auth-unverified`、`auth-required`、`ready`、`update-required`、`incompatible`、`degraded`；无可靠认证探测不宣称 ready，challenge 只返回公开 URL/设备码/脱敏状态。 |
| 官方渠道边界 | driver 明确区分 Codex app-server/CLI、Claude Agent SDK、Grok headless/ACP 和 driver-defined ACP；没有真实供应商下载或登录，管理员必须预登记可验证 artifact。 |
| 权限继承 | `ChannelExecutionPolicy` 仅允许 Full Access 使用 bypass/always-approve/sandbox-off；Read Only/Workspace Write 走各渠道正式模式，Workspace Write 需要目标子会话审批；Grok Workspace Write 和 ACP 未声明能力时启动前结构化拒绝。 |
| 多 runtime 回滚 | fake artifact/transport 验证 runtime A 升级后 runtime B 失败会逆序恢复 A；新旧版本目录都保留，Session Control 调用数为 0；rollback 响应丢失通过稳定 status 对账为 completed 或 persistence-unknown。 |
| 认证秘密边界 | 测试只使用 fake auth output；代码不读取 `~/.codex`、`~/.claude`、`~/.grok`、Cookie、OAuth token、API key 或 provider 环境变量全文。 |
| 公共 manifest | `dsh-subagent-code-agents` 四个 channel package 暴露 `dsh.remote.runtime`，启动从注入 Runtime Manager 获取绝对 executable，不通过 PATH 猜测。 |
| 打包 smoke | 两个仓库均需执行真实本地 tgz pack/install/import/bin smoke；临时 consumer 和产物在测试结束清理。 |

## 验收命令

```powershell
cd D:\Project\deepseek-harness-lab\dsh-remote-control
npm run check
npm run test:stage-c
npm run pack:check
git diff --check

cd D:\ds_project\test\dsh-subagent-code-agents
npm run check
npm test
npm run pack:check
git diff --check
```

本轮 fake/integration 目标：remote-control 全部定向测试通过（当前共 43 项，2 个 Linux-only 项在 Windows 跳过）；subagent-code-agents 全部测试通过（当前 143 项）。测试不启动真实 provider、不做真实登录、不读取真实密钥、不连接未授权远端。

## 真实未验收项

当前没有获授权的 Linux x86_64 SSH 主机，因此不把以下内容冒充完成：真实 known_hosts/fingerprint 登录、SFTP 上传、非 root 远端安装和 probe、真实 `dsh-session-control` socket、真实 Workspace/Session/权限/审批/Schedule、真实 Gateway reverse tunnel、真实 Codex/Claude/Grok 登录和真实 ACP driver。获得授权主机后，应在独立运维窗口用已登记 catalog 做一次端到端验收；不得用真实 provider 或秘密替代 fake 证据。

## 遗留风险

- 供应商版本、官方认证流程和 ACP driver capability 会随供应商变化；未登记的 artifact 或未知能力必须继续拒绝，不得自动猜测。
- `installed-auth-unverified` 只能证明安装布局和版本摘要，不能证明账户有额度或模型调用可用；首次调用仍可能要求用户认证。
- fake transport 证明协议和恢复逻辑，不替代真实 Linux/SSH/Session Control 运维验收。
