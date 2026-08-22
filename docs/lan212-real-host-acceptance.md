# LAN 212 真实主机验收

日期：2026-08-22
目标：`192.168.31.212` / Ubuntu 24.04 / Linux x86_64 / 非 root 用户 `leyi`
结论：阶段 A/B 的全新 Host 自动部署与远程项目主链通过；阶段 C 的 Runtime Manager 基础服务通过，真实 Codex/Claude/Grok/ACP 供应商安装、登录和模型请求仍未执行。

## 冷启动证据

最终验收使用此前不存在的独立根目录 `/home/leyi/.dsh-remote-auto-v3`，没有复用主机上的既有 DSH、pnpm、Remote Host 或插件目录。Host Key 固定为 OpenSSH ED25519 指纹 `SHA256:Y8MVcDjdWeBjOtv4Zw3O4EgDBCEp9DMeqxw4DR/ZRso`；未知或变化 key 仍 fail closed。

自动链实际完成：

| 环节 | 真实结果 |
| --- | --- |
| DSH 安装 | 受信锁文件配方 SHA-256 `4d3207...7870c`；非 root `npm ci` 安装 `0.1.0-rc.6`；全部 `@deepseek-ai/dsh*` 顶层包保持 rc.6；原生 `node-pty`/`koffi` probe 通过。 |
| 包管理器 | Corepack 固定 pnpm `11.19.0`；wrapper 位于 owner-only Remote Root。 |
| 服务 | `dsh-remote-lan212-auto-v3.service` 已 `enabled` 且 `active`，只监听 `127.0.0.1:3183`；远端根目录 `0700`，Runtime Manager token 和 profile manifest `0600`。 |
| Remote Host | 受信 artifact 安装 `dsh-remote-control 0.1.13`，Host id `lan-dev-212-auto-v3`，stdio/Unix socket 通道握手成功。 |
| controller | Workspace `9472a145-7ee9-4937-8ae5-40d15249ca9a`，固定 Session `session-auto-controller-212-v3-0001`；通过正式 `session.rename` API 恢复 live，不发送 prompt、不调用模型。 |
| 插件 | `dsh-session-control 0.6.3` 从 missing 安装，artifact SHA-256 `0b9aeb...66247`；profile 激活后 socket 正式提供 project/schedule/policy 服务。 |
| 项目 | 目录 `/home/leyi/Projects/dsh-remote-auto-v3-project`；Workspace `cd6d4cd4-a2af-4ef0-a5f0-3818554551e1`；Session `session-ca4aa0eb-9453-473e-a87b-c963c3c65a4b`；permission=`workspace-write`。 |
| Gateway | 本机 fake provider 通过 SSH reverse tunnel 绑定远端 `127.0.0.1:43186`，Host-scoped 短期 token 生效；没有真实 provider 或付费模型请求。 |
| Schedule | 正式创建 `schedule-1`，随后通过 Connector `schedule.delete` operation 删除；结果 `deleted=true`，Session Control operation 持久化。 |
| 权限 | 正式 verifier 返回 `authority=dsh-session-control`、`workspace-write`，workspace root 精确等于目标项目目录，target 为远端子会话。 |
| 重启恢复 | 显式重启 systemd user service 后，DSH/插件/Remote Host 重连；Host incarnation `aa6cc500-3a7a-4870-80bd-828addfa8c69` 与 project receipt 保持一致，reconcile=`confirmed`、revision=10。 |

第二次同链重放显示 DSH=`reused`、插件=`reused`、project/Workspace/Session 标识保持不变，Schedule 删除不产生第二份副作用。

## 实机发现并修复的问题

1. 冷启动 Remote Host installer 不能导入尚未上传的仓库相对模块；改为自包含入口。
2. OpenSSH SFTP 目标被错误加入 shell 引号；改为校验后的原始 `host:/absolute/path` argv。
3. Windows 打包的 CRLF shebang 和不可执行位导致 Linux bin 无法启动；安装时规范化并固定 owner executable。
4. plugin 与 bundled Skill 同 id/version 被误判重复；重复键加入 kind。
5. DSH 直接安装会把 rc.6 的传递依赖漂移到 rc.8；改用受信 `package-lock.json` 和完整版本漂移校验。
6. 完全禁止 DSH lifecycle script 会让 `node-pty` 缺原生模块；只允许锁文件中五个精确包执行脚本，并增加 native probe，普通项目插件仍全部禁用脚本。
7. staging 先创建 Remote Root 导致目录为 `0755`；安装器确认 owner/non-symlink 后收敛为 `0700`，不放宽 Runtime Manager token 校验。
8. Remote Host 同版本重放读取了错误 manifest 层级；修正为 `versions/<version>/package/manifest.json`。
9. Session Control 首次返回无法证明 Workspace/Session 身份时，Remote Host 以 needs-attention 保留原 operation，并只允许同幂等请求恢复。
10. Schedule 创建缺少 AbortSignal；正式调用加入 60 秒 signal。Schedule 删除补齐 Session Control、Remote Host operation 与 Connector 三层 API，响应未知时可同键恢复。
11. DSH controller/target 的无模型恢复不能把 HTTP `session.prompt('/goal')` 当作客户端 slash-command 分发；改为正式 `session.rename` 解析 live Agent，不触发 LLM。
12. rc.8 把 20 个运行时接口声明为非可选 peer；`legacy-peer-deps` 生成的旧配方未安装这些接口，并在同工作区隔离验收时被父目录 rc.6 `node_modules` 意外托底。配方现要求每个非可选 peer 都在 lock 顶层可解析，根依赖固定精确版本，五个 install script 通过 `allowScripts` 按包名和版本批准；隔离审计由 258 条缺失边收敛为 0。

## rc.8 原地升级复验

同一受权 Host `lan-212-skill` 已从 DSH `0.1.0-rc.6` 原子升级到 `0.1.0-rc.8`，Remote Host 从 `0.2.0` 升至 `0.2.1`，`dsh-session-control` 从 `0.6.4` 升至 `0.6.5`；systemd user service 保持 `active`，旧版本目录保留用于回退。

- 项目目录 `/home/leyi/Projects/dsh-remote-skill-acceptance` 复用原 Workspace `12d653ff-65db-467c-8bb1-1eddaf835c2b`，rc.8 验收 Session 为 `session-15c346c0-80a3-42a3-8c67-7bcdcb92e0c7`。
- 正式 Schedule `schedule-1` 创建后删除，最终 `deleted=true`；未留下待触发任务。
- 显式重启 `dsh-remote-lan-212-skill.service` 后，同幂等请求返回相同 Workspace、Session、operation receipt，reconcile=`confirmed`、revision=`16`。
- 全程未提交模型 prompt、未调用 provider、未执行供应商登录、未读取或复制秘密。

## 未验收边界

- 212 未安装 Codex、Claude Code、Grok Build 或 ACP runtime；没有供应商受信 artifact，因此没有伪造阶段 C 的真实 runtime 安装结论。
- 未执行真实供应商登录、认证过期、真实模型生成或付费请求，也未读取、复制或提交任何秘密。
- 本轮仅覆盖 Linux x86_64 + systemd user service；Linux ARM64、macOS、Windows OpenSSH 和无 systemd 保活仍属于后续平台扩展。
- 未配置 GitHub-hosted 或第三方 CI；发布依据是本机全套测试、真实 pack smoke、LAN 实机证据和 GitHub PR 检查。
