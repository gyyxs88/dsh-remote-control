# 安装、开发与接入说明

## 本机开发

```powershell
cd D:\Project\deepseek-harness-lab\dsh-remote-control
npm install
npm run check
npm run test:stage-a
npm run test:stage-b
npm run pack:check
```

仓库没有运行时依赖。Windows 开发机上的测试不假设本机能启动 Linux Remote Host；Remote Host 入口会在非 Linux x86_64 上 fail closed。正式远端使用打包后的固定版本，并由本机 Connector 通过 SSH 上传经过 SHA-256 校验的 artifact。

## 远端 Host 接入

1. 本机必须已有一份由受信运维渠道确认的 `known_hosts`，以及匹配的 Host Key fingerprint 或 public key pin。fingerprint 使用 OpenSSH `SHA256:<Base64>` 格式，保留 `+`、`/` 且不带尾部 `=`；代码会在启动 `ssh` 前读取并比对实际条目，缺失或错误 key 直接拒绝。
2. 远端只需具备受支持的 Linux x86_64 与 Node.js 运行时；不要求预装本包或任何外部 Agent。Connector 使用 `StrictHostKeyChecking=yes`、固定 `UserKnownHostsFile` 和 `HostKeyAlias` 建立 SSH。
3. Bootstrap 只上传已在 trusted digest catalog 中的固定 `.tgz` artifact 和 installer；catalog 缺少 artifact 或 installer 摘要时拒绝。远端 installer 使用 `--sha256 --atomic --no-root`，执行 entrypoint probe 后再清理；若清理响应丢失，对账使用已安装 `current/bin/dsh-remote-host-installer.mjs --status`，不依赖 staging。全程不执行 `curl | sh`，且首装不依赖远端预装本包。
4. 远端通过 stdio bridge 启动 `dsh-remote-host`，Host Agent 只保存自己的 Host/Project/Operation 摘要。
5. `SessionControlPort` 由远端 DSH Host 组装，连接该 Host 内的 `dsh-session-control` 正式服务；正式部署优先使用其 Unix socket bridge。远程仓库不能直接打开目标 Session 的 JSONL/SQLite，缺 port 时 daemon 启动即失败。
6. 本机 Model Gateway 监听 loopback，Connector 为远端 Host 建立短期 token 和 SSH reverse tunnel。断开 Gateway 时，原生 Agent 新轮次应等待 Gateway，而不是重新投递。

7. 项目 Desired State 由本机 `TrustedArtifactRegistry` 解析。registry entry 必须预先登记 artifact 文件名、版本、大小、SHA-256、package identity 和兼容范围；项目值不能自证可信，也不能提供安装脚本。`remote`/`both` 插件与独立项目 Skill 通过 `DesiredStateSynchronizer` 上传到 staging，再调用已安装版本的 `current/bin/dsh-remote-artifact-installer.mjs`。
8. 远端插件布局为 `<remoteRoot>/plugins/<id>/versions/<version>`，Skill 布局为 `<remoteRoot>/skills/<id>/versions/<version>`；只有 manifest、package identity、归档树和探测全部通过才原子切换 `current`。旧版本永不因升级删除，正在使用的版本不会被改写。正式 `--rollback` 只允许切回同 kind/id 下 manifest、版本、SHA-256、size、package、target、protocol 和 safeTree 均通过的已存在版本，或安全撤销到 `missing`。
9. 插件自带 Skill 必须由 plugin `dsh.remote.bundledSkills` manifest 按版本和摘要绑定；项目 Skill 没有 `bundledWith` 时独立传输。凭据、Session JSONL/SQLite、operation 状态、日志、缓存、本机插件状态均不在同步范围内。
10. 每个 action 开始前记录 previous current receipt；后续 action 确定失败时，按逆序调用 `--rollback` 恢复本轮可能切换的 action。同步回执保留 rollback `attempted`、`completed`、`failed` 或 `unknown`。同步清理或 rollback 响应丢失时，只用稳定 `--status` 入口同时对账 Desired State 目标和 rollback 目标；staging 已不存在也不能阻止判断。若 rollback 终态仍不能证明，返回 `persistence-unknown`，`project.open` 不创建 Session。

## SessionControlPort module

接入模块示意：

```js
import { DshSessionControlPort } from 'dsh-remote-control';

export function createSessionControlPort() {
  return new DshSessionControlPort({
    async openProject(request, context) {
      // 这里调用远端 DSH Host 内正式 dsh-session-control 服务。
      // 不在此处复制 Session JSONL、SQLite、权限或 Schedule。
      return officialSessionControl.openProject(request, context);
    },
  });
}
```

`openProject` 返回至少 `workspaceId`、`sessionId`；可选返回 `projectId`、`workspacePath`、`permissionPreset`、`scheduleState` 和 `state: 'partial'`。

正式 `dsh-session-control` 配置示例：

```yaml
remoteProjectSocket: /run/user/1000/dsh-session-control.sock
remoteProjectHostId: remote-host-01
```

socket bridge 只接受 `remote-project.ping` 和 `remote-project.open`，串行转发到官方 API，并绑定 `sourceSessionId`；不创建第二份 Session 存储。

## 不做的事

- 不把本机 `.dsh-home`、Provider 凭据或第三方 CLI 登录目录复制到远端。
- 不在 Stage A 中安装或认证 Codex、Claude Code、Grok Build、ACP。
- 不让远端 Host 监听公网端口。
- 不把 fake port 当成生产 DSH Session 实现。
