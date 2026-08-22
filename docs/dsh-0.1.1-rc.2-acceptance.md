# DSH 0.1.1-rc.2 升级验收

日期：2026-08-22

结论：`dsh-remote-control 0.2.2`、`dsh-session-control 0.6.6` 与 `dsh-subagent-code-agents 0.1.2` 已完成 DSH `0.1.1-rc.2` 的仓库、隔离 Web Host 和 LAN 212 实机验收。没有调用模型、provider 或供应商登录。

## 依赖与安全基线

- 官方 `@deepseek-ai/dsh` 目标版本固定为 `0.1.1-rc.2`；锁文件中的 DSH 包保持同版本。
- 默认 npm peer 解析在独立消费者中持续高 CPU/高内存且不落盘，因此仍使用 `legacy-peer-deps`，并把 19 个缺失的 DSH/Cordis peer 与 React/React DOM 显式固定在根依赖；补齐后 `npm ls --all --omit=dev` 无缺失、invalid 或 extraneous 条目。
- lifecycle script 仍只批准五个精确身份：`@deepseek-ai/dsh-subprocess-local@0.1.1-rc.2`、`@google/genai@1.52.0`、`koffi@3.1.6`、`node-pty@1.2.0-beta.15`、`protobufjs@7.6.5`。
- 新版 Linux bwrap profile 使用私有 PID namespace 与独立 `/proc`，不会暴露宿主 `/proc/<pid>/root` 魔法链接。

## 仓库验证

- remote-control：`npm run check`；78 tests，73 pass、5 个平台条件 skip；真实 tgz pack/install/import、5 bin、插件入口和 bundled Skill digest smoke 通过。
- session-control：Node 24.19.0；62 tests，61 pass、1 个 Windows Unix socket skip；真实 tgz remote manifest smoke 通过。
- subagent-code-agents：Node 24.19.0；161 tests，158 pass、3 个环境条件 skip；真实 workspace/root tgz、六个 bundled internal package 与导出 smoke 通过。

## 隔离 Web Host

独立 DSH_HOME、独立依赖树和端口 `127.0.0.1:3182` 启动 `0.1.1-rc.2`，没有读取正式 3080 的状态或凭据。验收结果：

- 创建 Workspace 与 Session 成功，`session.list` 可见；只调用 rename，不发送 prompt。
- `skill.list` 同时返回 `dsh-remote-project` 与 `dsh-session-control`。
- `dsh-remote-control 0.2.2`、`dsh-session-control 0.6.6`、`dsh-subagent-code-agents 0.1.2` 均从真实 tgz 加载。
- GenUI 固定公开提交 `1ca5da4eb9394972cce2c1ccacfedc22eec3166b`（package `0.9.1`），正式声明兼容 `0.1.1-rc.*`；client、Mermaid asset 与 at-file client HTTP 均为 200。

## LAN 212 实机

受权主机 `lan-212-skill` 保持固定 ED25519 指纹和既有远端根，原子升级后：

- DSH `0.1.1-rc.2`、Remote Host `0.2.2`、Session Control `0.6.6`；systemd user service 为 active，旧版本目录保留。
- 项目目录 `/home/leyi/Projects/dsh-remote-skill-acceptance` 复用 Workspace `12d653ff-65db-467c-8bb1-1eddaf835c2b`，新 Session 为 `session-42553ecc-6c4a-4fba-9125-ff6f3c7911e8`，权限为 `workspace-write`。
- 正式创建 `schedule-1` 后正式删除，最终 `deleted=true`。
- 显式重启 `dsh-remote-lan-212-skill.service` 后，用相同 project/create/delete 幂等键重放，返回相同 Workspace、Session 和 operation；reconcile=`confirmed`、revision=`24`，没有重复创建。

## 未扩张边界

- 没有执行真实模型请求、供应商登录或认证探测，也没有读取/复制任何秘密。
- 212 未安装 Codex、Claude Code、Grok Build 或 ACP runtime；本次验证的是 DSH、Remote Host、Session Control、项目、Schedule 与恢复链。
- Windows 正式实例切换和回滚证据在本地 cutover 后单独记录，不把隔离/212 验收冒充为本机正式切换。
