---
name: dsh-remote-project
description: 用自然语言登记 SSH 主机、自动部署远端 DSH，并在指定 Linux 目录创建或恢复远程项目会话；适用于“连接某台服务器的某个目录”“把这个远端目录加入 DSH”等请求。
---

# DSH 远程项目

使用 `remote_*` 工具完成远程主机和项目操作。不要让用户输入内部 Host id、Workspace id、Session id、operation id 或部署参数；先自行发现并维护这些标识。不要用 Shell 临时拼接 SSH、SCP、安装或数据库命令绕过插件。

## 定位主机

- 先调用 `remote_host_list`，用名称、SSH 别名、地址和用户描述匹配主机。只有多个候选无法可靠区分时才询问。
- 未登记主机先调用 `remote_host_probe`。首次 Host Key 不能静默信任：把返回的指纹交给用户通过可信渠道核对；用户确认精确指纹后再调用 `remote_host_add`。
- `remote_host_add` 只登记本机信任和连接信息；第一次 `remote_project_open` 会自动检查并安装受信版本的 DSH、Remote Host 和会话控制插件。
- 私钥、密码、token、Cookie 和供应商登录目录都不进入主机登记。SSH 必须已经能以 BatchMode 使用本机现有认证。

## 打开目录

- 目标路径必须是远端 Linux 上的绝对 POSIX 路径，不能使用 `~`、相对路径或 `..`。
- 用户指定的目录不在主机当前 `allowed_root` 下时，调用 `remote_host_update` 把允许根调整为用户明确指定的目录或足以包含它的最窄父目录；不要擅自扩大到 `/`。
- 为每个逻辑动作生成 8–128 字符稳定 `idempotency_key`；同一动作的超时、断线和重试必须复用，参数变化时换新键。
- 调用 `remote_project_open` 一次完成：远端依赖检查/安装、目录创建、Workspace 注册或复用、普通 Session 创建或复用。权限默认 `workspace-write`；只有用户明确要求长期完全自主时才使用 `danger-full-access`。
- 返回 `completed` 后报告远程主机、目录、Workspace/Session 和权限。返回 `needs-attention`、`partial` 或终态不明时，先调用 `remote_project_reconcile`，不要换幂等键重复创建。

## 定时与恢复

- 用户在打开项目时同时要求定时任务，可把 `schedule` 传给 `remote_project_open`；已有目标会话使用 `remote_schedule_create`。
- 删除前必须知道精确目标 Session 和 Schedule id，再调用 `remote_schedule_delete`。
- 断线或插件重启后调用 `remote_project_reconcile`；服务端 operation/revision 是事实源。
- `remote_host_remove` 只删除本机登记并保留远端安装和项目数据。只有用户明确要求时才执行。

最终用用户可理解的主机名称和路径汇报，不主动暴露内部 ID、指纹公钥正文、token、缓存路径或部署命令。
