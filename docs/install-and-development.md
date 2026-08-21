# 安装、开发与接入说明

## 本机开发

```powershell
cd D:\Project\deepseek-harness-lab\dsh-remote-control
npm install
npm run check
npm run test:stage-a
npm run pack:check
```

仓库没有运行时依赖。Windows 开发机上的测试不假设本机能启动 Linux Remote Host；Remote Host 入口会在非 Linux x86_64 上 fail closed。正式远端使用打包后的固定版本，并由本机 Connector 通过 SSH 上传经过 SHA-256 校验的 artifact。

## 远端 Host 接入

1. 本机必须已有一份由受信运维渠道确认的 `known_hosts`，以及匹配的 Host Key fingerprint 或 public key pin。
2. Connector 使用 `StrictHostKeyChecking=yes`、固定 `UserKnownHostsFile` 和 `HostKeyAlias` 建立 SSH。
3. Bootstrap 只上传已在 trusted digest catalog 中的固定 artifact；远端 installer 使用 `--sha256 --atomic --no-root`，不执行 `curl | sh`。
4. 远端通过 stdio bridge 启动 `dsh-remote-host`，Host Agent 只保存自己的 Host/Project/Operation 摘要。
5. `SessionControlPort` 由远端 DSH Host 组装，连接该 Host 内的 `dsh-session-control` 正式服务。远程仓库不能直接打开目标 Session 的 JSONL/SQLite。
6. 本机 Model Gateway 监听 loopback，Connector 为远端 Host 建立短期 token 和 SSH reverse tunnel。断开 Gateway 时，原生 Agent 新轮次应等待 Gateway，而不是重新投递。

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

## 不做的事

- 不把本机 `.dsh-home`、Provider 凭据或第三方 CLI 登录目录复制到远端。
- 不在 Stage A 中安装或认证 Codex、Claude Code、Grok Build、ACP。
- 不让远端 Host 监听公网端口。
- 不把 fake port 当成生产 DSH Session 实现。
