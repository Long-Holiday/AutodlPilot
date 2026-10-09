# AutoDL Pilot MCP

基于 TypeScript 的远程 MCP 服务，只包装 [AutoDL 容器实例 Pro API](https://www.autodl.com/docs/instance_pro_api/) 的实例生命周期。Agent 在本机运行，通过 prompt 提供 `pro-...` 实例 ID；MCP 不创建实例，也不选择 GPU。

## 职责边界

| 位置 | 负责什么 |
| --- | --- |
| 远程 MCP 服务器 | 从部署项目根 `.env` 读取开发者 token；单次开机、显式持续请求、状态查询、关机；持久化重试任务。 |
| 本机 Agent | 修改代码、经授权 commit/push、持有 SSH 私钥、SSH 拉取最新代码、执行实验命令、查看日志/进程。 |
| AutoDL 实例 | 接收开关机指令；开机后通过 SSH 执行本机发起的操作。 |

远程 MCP **不执行 SSH/bash，不存储 Git 凭据或实验命令，不管理实验结果，不根据实验完成自动关机**。本机 SSH 免密登录需要先配置，详见 [本机流程](scripts/local/README.md)。

## 快速开始

推荐 **Node 24 LTS**，最低 Node 24。使用已提交的 lockfile 安装：

```bash
npm ci
# 已有 .env 时不覆盖
[ -f .env ] || cp .env.example .env
# 编辑 .env，填入 AUTODL_TOKEN 和不同的 MCP_AUTH_TOKEN
npm run build
npm test
npm start
```

`npm start` 是真实服务启动，会恢复尚未过期、由新版本显式创建的持续任务，可能产生开机与计费操作。未准备好时只运行 build/test；测试不会读取真实 `.env` 或控制真实实例。

配置文件始终从项目根读取，不依赖启动 cwd；`DATABASE_PATH` 的相对路径也从项目根解析。进程已显式设置的环境变量优先于 `.env`。`.env` 不应提交到 Git；远程服务器上建议权限为 `0640` 或更严格。

### 必要配置

```dotenv
# AutoDL 控制台账号设置中的开发者 token
AUTODL_TOKEN=your_autodl_developer_token_here
# 独立 MCP 凭据；不要复用 AUTODL_TOKEN
MCP_AUTH_TOKEN=your_secure_mcp_access_token_here
HOST=127.0.0.1
PORT=3000
DATABASE_PATH=./data/autodl-pilot.db
```

其他选项见 [`.env.example`](.env.example)。默认持续任务最多 **120 分钟**，起始间隔 **10 秒**，最大间隔 **120 秒**，退避因子 **1.5**，附带抖动。该上限从任务创建时计算，重启不会重置；配置可调整，最长支持 24 小时。开机接受/结果不确定后的状态观察窗口默认 180 秒，观察超时不会再次盲目开机。

## 六个 MCP 工具

所有工具运行时校验参数；实例 ID 必须以 `pro-` 开头。除了表内参数，不接受 `start_command`、Git token 或实验命令。

| 工具 | 参数 | 行为 |
| --- | --- | --- |
| `power_on_instance` | `instance_uuid` | 只调用一次开机 API，返回接受或真实失败；不自动创建任务，不等待 running。 |
| `retry_power_on_instance` | `instance_uuid` | 显式启动后台持续请求，快速返回任务 ID 和截止时间；同实例重复请求返回现有任务。 |
| `get_instance_info` | `instance_uuid`, `include_connection?` | 返回原始状态。默认仅查状态；`include_connection=true` 时附安全 SSH host/port/user。 |
| `power_off_instance` | `instance_uuid` | 取消关联持续任务，等待在途开机清理，再提交关机；接受不代表已经停止。 |
| `get_power_on_task_status` | `task_id` **或** `instance_uuid` | 只查本地任务存储。按实例查询最近任务，包含终态；两个参数不能同时提供。 |
| `cancel_power_on_task` | `task_id` | 取消持续请求；不关闭已开机实例。 |

### 典型调用

1. 本机 Agent 根据用户 prompt 获取实例 ID，并调用：

   ```json
   { "name": "power_on_instance", "arguments": { "instance_uuid": "pro-759127a8714f" } }
   ```

2. 返回 `status: "accepted"` 时由 Agent 查询真实状态；不要再调用持续工具。若返回 `status: "gpu_unavailable"`、`retryable: true`，由 Agent 显式调用：

   ```json
   { "name": "retry_power_on_instance", "arguments": { "instance_uuid": "pro-759127a8714f" } }
   ```

   API/网络超时会带 `outcome_uncertain: true`：先查询状态，不能把它当作 GPU 不足直接重复开机。业务错误保留原始 `code`、`message`、`request_id`。

3. 根据返回的 `task.task_id` 查询进度，或按实例查询：

   ```json
   { "name": "get_power_on_task_status", "arguments": { "instance_uuid": "pro-759127a8714f" } }
   ```

   任务状态为 `PENDING / RUNNING / RETRYING / SUCCESS / FAILED / CANCELLED / TIMEOUT`；这些是本项目任务状态，**不是官方实例状态枚举**。`RUNNING` 表示 worker 正在工作，不代表 GPU 实例已运行。`retry_count` 计数每次实际 `power_on` 尝试，包括第一次后台尝试；返回 `next_retry_at`、`deadline_at`、最后错误和停止原因，时间均为 Unix 毫秒。

4. 确认实例 `running` 后查询连接信息：

   ```json
   { "name": "get_instance_info", "arguments": { "instance_uuid": "pro-759127a8714f", "include_connection": true } }
   ```

   仅投影 `ssh_host / ssh_port / ssh_user`；不返回 `root_password`、Jupyter token 或平台提供的任意 SSH 命令。详情查询失败时仍保留成功取得的状态，并返回 `connection_warning`。

5. 本机检查免密 SSH，修改代码并经授权 commit/push，执行拉取和实验命令；无需向 MCP 登记实验。结束后根据用户意图调用 `power_off_instance`，再查询实际状态。

### 持续任务语义与边界

- 同实例初次开机、worker 和关机由实例级所有权锁协调；取消不提前释放锁，迟到响应不能覆盖任务终态。
- 只有已知停止态才发起后台开机。兼容约定为 `stopped / shutdown`；官方文档只给出了 `running` 示例，未公布完整状态表。其他状态原样返回、继续查询，**不猜测为已停止**。
- GPU 不足使用保守文案兼容规则，不杜撰官方错误码。HTTP 429、5xx 和状态查询网络故障按退避处理；未知业务错误、鉴权/参数错误停止任务。
- API 接受开机后只观察状态。发送前记录 `VERIFY` 阶段，避免崩溃恢复时盲目重发。成功进入 `running` 才将持续任务标记 `SUCCESS`。
- 取消、超时和失败只停止持续任务，不自动关机。客户端断开不取消任务；服务重启按原截止时间恢复显式持续任务。
- 网络取消无法撤回 AutoDL 已收到的请求。关机顺序避免本服务旧 worker 再发开机，但不能承诺平台侧绝无迟到请求；请查询实际状态，必要时再次显式关机。
- 以 **单服务进程/单实例部署** 使用 SQLite 和进程内锁，不运行多个进程共同调度同一数据库。

## 官方 API 对齐

服务使用 Node 原生 HTTP(S) 请求，支持文档明确写出的 **GET + JSON body**，无 POST/GET-query 猜测式 fallback：

| 操作 | 方法/路径 | JSON body |
| --- | --- | --- |
| 开机 | `POST /api/v1/dev/instance/pro/power_on` | `{ "instance_uuid": "pro-...", "payload": "gpu" }` |
| 关机 | `POST /api/v1/dev/instance/pro/power_off` | `{ "instance_uuid": "pro-..." }` |
| 状态 | `GET /api/v1/dev/instance/pro/status` | `{ "instance_uuid": "pro-..." }` |
| 可选连接详情 | `GET /api/v1/dev/instance/pro/snapshot` | `{ "instance_uuid": "pro-..." }` |

AutoDL 的认证是 `Authorization: <AUTODL_TOKEN>`，**不加 Bearer**；本机访问 MCP 才使用 `Authorization: Bearer <MCP_AUTH_TOKEN>`。不支持 API 无卡开机，也不发送 `start_command`。官方认证要求、状态和错误契约以 [文档](https://www.autodl.com/docs/instance_pro_api/) 为准。

## 远程部署与连接

MCP 为无状态 **Streamable HTTP**：每个 POST 创建独立 server/transport，调度器共享；不依赖会话 ID，GET/DELETE 返回 405。无需 SSE 常驻连接。

- 默认监听 `127.0.0.1:3000`，用 HTTPS 反向代理暴露 `/mcp`，或使用受信任 SSH/私有网络隧道。不要将携带 token 的明文 HTTP 直接暴露公网。
- 仅接受 Authorization 头，不接受 URL query token。
- 带 `Origin` 的请求必须精确匹配 `MCP_ALLOWED_ORIGINS`；默认空列表拒绝浏览器请求。不带 Origin 的正常 MCP Agent 请求可通过认证。
- `/health` 是无鉴权服务存活检查，不测试 AutoDL、不包含账户信息。

支持远程 HTTP 的客户端可参考 [`scripts/mcp-client-config.json`](scripts/mcp-client-config.json)：

```json
{
  "mcpServers": {
    "autodl-pilot": {
      "type": "http",
      "url": "https://mcp.example.com/mcp",
      "headers": { "Authorization": "Bearer your_secure_mcp_access_token_here" }
    }
  }
}
```

只替换 MCP 访问 token，不把 AutoDL 开发者 token 放在客户端。具体配置字段以所用客户端支持的 HTTP 配置为准。

### systemd（Linux）

在远程服务器上准备系统级 `/usr/bin/node`（推荐 Node 24 LTS）、npm、编译工具及 systemd 后：

```bash
sudo bash scripts/setup-remote.sh
# 检查 /opt/autodl-pilot/.env；已有文件不覆盖
sudo systemctl enable --now autodl-mcp
sudo journalctl -u autodl-mcp -f
```

脚本默认只准备部署，不启用服务；源项目 `.env` 在目标尚无配置时才复制，否则复制模板。数据目录归服务用户 `autodl-pilot` 所有，构建以非 root 用户在独立 staging 目录执行，不包含数据库或密钥。旧产物保留在输出的 staging 路径，确认后自行清理。

已在运行的服务只能显式使用 `sudo bash scripts/setup-remote.sh --start` 停止、更新和重启。模板仅允许写入默认 `data/`；若自定义数据库目录，同时调整 `ReadWritePaths` 和目录权限。`HOST` 若在已有 `.env` 中配置为 `0.0.0.0`，不会自动改写；部署前请检查监听和防火墙。

## 从 1.x 升级

2.x 是有意收敛的接口变更：删除余额、实例枚举、实验三工具与 SSH 指引工具，删除 `start_command` 和取消原因参数；首次失败不再自动重试。客户端应显式使用 `retry_power_on_instance`。

数据库采用增量迁移，不删除历史实验表、记录或旧命令列，也不将其返回 MCP。旧版本自动创建的活动任务标记停止并要求显式重新发起，避免升级时意外恢复计费操作。新版本显式任务可在服务重启后继续恢复。

## 开发与验证

```bash
npm run build
npm run typecheck
npm test
npm run check:shell
```

测试使用假凭据、本地假 AutoDL HTTP 服务、SDK MCP 客户端、虚拟时间和替身 SSH/Git，覆盖 API 方法/请求体/脱敏、单次与显式持续请求、并发取消/关机、截止时间/恢复、MCP 重连/鉴权/校验、本机脚本执行与错误退出。不代表已完成真实 AutoDL 开关机、SSH 登录或服务器部署验证。

源码分为 `src/autodl`、`src/scheduler`、`src/storage`、`src/mcp`；本机辅助脚本独立放在 `scripts/local`，不属于 MCP 运行时。
