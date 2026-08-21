# 阶段 A 验收记录

日期：2026-08-21  
仓库：`gyyxs88/dsh-remote-control`  
目标：协议与最小远端闭环  
环境：Windows 开发机，项目固定 Node.js 24.19.0 做验证；未授权真实远端 SSH 主机，因此不执行真实 bootstrap、SSH 登录或付费模型调用。

## 证据

在仓库目录执行：

```powershell
npm run check
npm run test:stage-a
npm pack --dry-run
```

阶段 A 定向测试结果：12 passed，0 failed。

覆盖项：

| 区域 | 证据 |
| --- | --- |
| Protocol | 同 major 版本协商、major 不兼容拒绝、Host/Operation/Project 字段校验、正文 hash 绑定 |
| Project chain | 绝对 POSIX 路径、`project.open` 幂等、Workspace/Session 由 SessionControlPort 返回并 attach 摘要 |
| Operations | response 丢失后远端已完成的 operation 查询/对账、source ownership、过期权限快照拒绝 |
| Revision | 同一 Host incarnation 内 revision 单调；低 revision 不覆盖本机缓存 |
| Restart | durable state 中 pending/running operation 在 Host 重启时转为 `needs-attention` |
| Incarnation | Host 重装/状态变化时 Connector 拒绝盲目重建 |
| Bootstrap | artifact SHA-256/尺寸/目标校验，固定 digest catalog，atomic/no-root/no-curl-pipe-sh 检查 |
| SSH | 必须固定 known_hosts 和 fingerprint/public-key pin；stdio bridge 与 reverse tunnel 只允许 loopback |
| Gateway | 独立 HTTP 进程边界、Host-scoped 短期 token、模型目录 allowlist、未知模型拒绝、token 不落盘 |
| Runtime | 非空外部 runtime 需求显式 `missing`/`needs-attention`，不安装或认证三方 Agent |

## 阶段 A 结论

代码闭环和 fake transport 验收已完成：本机 Connector 可以握手 Remote Host，提交幂等项目 operation，经过远端 SessionControlPort 获得 Workspace/Session 摘要，并在断响应/重连后以 operation 与 revision 对账恢复展示；原生 Agent 的默认 Gateway 路径与 SSH reverse tunnel 参数已接线。

真实 Linux x86_64 Host、真实 DSH Host 内 `dsh-session-control` service module、真实 SSH Host Key 和本机 provider 仍需获得授权环境后单独进行部署验收；本记录不把 fake transport 或“进程启动”冒充为真实远端验收。

## 后续边界

阶段 B 才加入插件/Skill Desired State 的固定产物同步与回滚；阶段 C 才加入第三方 Agent 运行时驱动和认证引导。任何真实 provider 或秘密测试都不属于本次验收。
