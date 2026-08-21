# 阶段 B 验收记录

状态：代码闭环与 fake/integration 验收完成后更新；真实 Linux SSH 主机部署仍未验收。

范围：插件与 Skill Desired State、可信 registry、选择性同步、临时安装、探测、原子版本切换、旧版本保留、同步回执与 Remote Host project/reconcile 接线。Codex、Claude Code、Grok Build、ACP 安装器和真实 provider 不在阶段 B。

## 已验证的代码路径

| 项目 | 证据 |
| --- | --- |
| 版本化协议 | `PluginRequirement` / `SkillRequirement` 校验 placement、固定版本、source、SHA-256、DSH/API 范围和 requiredBy；Desired State 拒绝缺摘要、重复项和非法范围。 |
| Trusted registry | 真实 `.tgz` 归档做 regular-file、大小、SHA-256、tar entry、package identity、remote/skill manifest 和 lifecycle script 校验；未知、缺失 allowlist 和不兼容项 fail closed。 |
| 选择性同步 | fake transport 证明只处理 `remote`/`both`，control-only 不上传；bundled Skill 不重复安装，独立 Skill 使用独立项。 |
| 幂等与对账 | 已验证同版本复用；清理或 rollback 命令远端完成但响应丢失时，不重放安装，使用稳定 `--status`（不依赖 staging）同时对账 Desired State 目标与 rollback 目标。rollback 已确认完成时同步保持 `needs-attention`，未知时保持 `persistence-unknown`。 |
| 原子安装与 rollback | `dsh-remote-artifact-installer` 只接受 Linux x86_64、非 root、固定 kind/id/version/package/SHA-256、`--atomic --no-scripts`；临时解包、manifest 探测、版本目录和 `current` 原子切换，旧版本不删除。正式 rollback 只切回 manifest/版本/SHA/package/target/protocol/safeTree 全通过的版本，或安全撤销到 missing。 |
| 多 action 恢复 | 两个插件故障注入证明 A 旧版→新版后 B 安装失败会逆序恢复 A；A 新旧版本目录均保留，Session Control 调用数为 0；rollback 回执记录 attempted/completed/failed/unknown。 |
| Project 接线 | `project.open` 要求 remote/both requirement 有绑定的 completed sync receipt；partial、incompatible、needs-attention、persistence-unknown 不调用 Session Control，状态在 operation/project/reconcile 中保留。 |
| Session Control 边界 | `dsh-session-control` package 与正式 socket `ping` 提供 `dsh.remote` manifest，声明 remote placement、protocol/API、capability 和 bundled Skill digest；它仍不拥有 SSH、插件传输或跨 Host Session 存储。 |
| 打包 smoke | `npm pack` 后临时目录真实 install/import，并检查所有 bin；session-control 额外检查 packed remote manifest import。 |

## 验收命令

```powershell
cd D:\Project\deepseek-harness-lab\dsh-remote-control
npm run check
npm run test:stage-b
npm run pack:check
git diff --check

cd D:\Project\deepseek-harness-lab\dsh-session-control
npm run check
npm test
npm run pack:check
git diff --check
```

本轮 remote-control 验收结果：`npm run check` 通过；`npm test` 共 38 项，36 通过、2 个仅 Linux 目标跳过；`npm run pack:check` 真实 tgz install/import + 4 个 bin smoke 通过；`git diff --check` 通过。

测试只使用临时目录、真实本地 `.tgz`、fake/local installer transport、fake Session Control 和本地 fake provider；不读取或测试任何真实密钥，不调用付费模型，不连接未授权远端。

## 尚未完成的实机验收

当前没有获授权的 Linux x86_64 SSH 主机，因此以下内容不在本记录中冒充完成：真实 Host Key pin 与 OpenSSH 登录、SFTP 上传、非 root 远端 `dsh-remote-artifact-installer` 执行、真实 `dsh-session-control` service socket、真实 Workspace/Session/Schedule、真实 Gateway reverse tunnel 和长时间断线恢复。获得授权主机后，应使用已登记 catalog 和独立运维窗口执行一次端到端部署验收；不得用生产秘密或真实付费 provider 替代 fake/integration 证据。

## 独立安全复核要点

- registry 信任根来自运维预登记的摘要，Desired State 自身不能生成或覆盖可信摘要；文件必须是 regular non-symlink，版本、文件名、大小、归档条目、package manifest 和 SHA-256 逐项匹配。
- 远端入口在实际 Linux x86_64 进程中检查 UID，拒绝 root；安装 root 的 canonical ancestor、插件/Skill ID、版本目录、归档路径和 `current` 指针均拒绝 traversal/symlink escape。
- SSH transport 仍使用已 pin 的 known_hosts；插件同步只调用固定安装器 argv，不把项目 source 当 Shell/URL/安装脚本执行；生命周期脚本和 `npm install` 均被拒绝。
- 上传、安装、probe、清理均串行执行；超时/响应丢失不重试副作用，使用持久 current/status 入口对账，不能证明时显式 `persistence-unknown`。
- 同步回执绑定 Desired State 摘要和每个远端 requirement 的 key/version/SHA-256；Remote Host 在 receipt 完成前不调用 Session Control，跨来源 operation/read 约束保持不变。
- 同步输入不包含凭据、Session 数据、operation 状态、日志、缓存或本机插件运行状态；没有实现第三方 Agent 安装器或真实 provider 调用。

## 风险与后续边界

- 阶段 B 只提供插件/Skill 受信产物同步，不实现第三方 Agent Runtime Manager 安装器。
- 远端 package 的正式执行能力仍由下一层 DSH plugin contract 提供；本安装器只校验和布局，不执行 package lifecycle 或任意脚本。
- 真实 Linux、SSH/SFTP 和正式 DSH Host socket 仍需授权实机验收。
