# DSH Remote Project 控制端 Skill 验收

范围：控制端 DSH 插件、Host 注册表、首次 Host Key 确认、受信本机 artifact 生成、自动部署编排、远程项目/Schedule 工具和 bundled Skill。

## 已验证

- `dsh.control` manifest 固定 `dsh-remote-project 0.1.0` 的完整文件 SHA-256；真实 npm pack/install 后再次读取 Skill 并核对摘要。
- 控制插件只向显式 `controllerSessionIds` 挂载完整 `remote_*` 工具；冲突时不做部分挂载。Full Access 自主执行，Workspace Write 变更留在来源审批，read-only 与 relay 变更 fail closed。
- Host 注册表和 managed known_hosts 为 owner-only，进程持锁，拒绝重复 Host/SSH identity、目录逃逸和不匹配指纹；持久数据不含密码、私钥、token 或 Cookie。
- `ssh -G`/`ssh-keyscan` 使用固定 argv、有界输出和超时；probe 只返回候选指纹，必须用精确确认值登记。
- artifact provider 对当前受信本包、同 profile 的 `dsh-session-control` 使用 `npm pack --ignore-scripts`，对精确 DSH lock 生成只含两个 manifest 的 recipe；项目输入不能成为 artifact trust root。
- 第一次 `remote_project_open` 复用正式 DSH/Remote Host bootstrap、插件同步、loopback DSH、固定 controller、Unix socket 与 Connector；断响应继续按现有 stable status/operation/revision 对账。
- 独立 `schedule.create` / `schedule.delete` operation 绑定来源、目标 Session、正文和幂等键，并调用正式 Session Control API；创建 Schedule 不再通过重开项目间接实现。
- 临时 DSH profile 真实安装两个 npm tgz、启动 Web Host、创建指定 controller Session 后，正式 `skill.list` 返回 `dsh-remote-project` 与 `dsh-session-control`；因此不是只验证了源码导出或 mock 注册。

## 局域网 212 实机验收

验收主机登记为 `lan-212-skill`，仅允许项目根 `/home/leyi/Projects/dsh-remote-skill-acceptance`。首次连接展示并精确确认了 `SHA256:Y8MVcDjdWeBjOtv4Zw3O4EgDBCEp9DMeqxw4DR/ZRso`；由于该主机的 `ssh-keyscan` KEX 不兼容，探测改用临时、隔离的 `known_hosts` 获取候选 key，正式连接仍使用持久 pin 和 `StrictHostKeyChecking=yes`，没有降低信任边界。

- 自动部署并启动 DSH `0.1.0-rc.6`、Remote Host `0.2.0` 与 `dsh-session-control 0.6.4`，均为非 root 用户目录和 user service。
- 正式项目链路创建 Workspace `12d653ff-65db-467c-8bb1-1eddaf835c2b` 与 Session `session-99407a24-9e01-4648-b8c0-081e730e7514`，权限为 `workspace-write`。
- 正式 `schedule.create` 创建 `schedule-1`，随后正式 `schedule.delete` 删除；没有通过项目重开或直接改存储模拟。
- 本机控制器重启后用同一幂等请求再次执行，返回相同 Host、Workspace、Session 和 operation receipt；对账 revision 为 `8`，没有重复项目或 Schedule。
- 全程没有提交模型 prompt、调用真实 provider、触发登录或读取凭据；本次验收只证明远端部署、控制、调度和恢复链路。

## 仍保留的边界

- 首次未知 Host Key 必须由用户或管理员通过独立可信渠道核对，不能为“傻瓜化”而自动接受。
- SSH 私钥/agent、远端 Node 24、npm、Corepack、tar、systemd user 与 linger 仍是主机前置条件；插件不安装系统级 Node，也不申请 root。
- Model Gateway 的真实本机 provider adapter、真实 Codex/Claude/Grok 登录和真实付费模型不属于本 Skill 验收；Skill 不读取或复制这些秘密。
