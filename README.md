# AutoDL Pilot MCP: 基于 Model Context Protocol 的 AutoDL GPU 实例自动化管理服务

[![Node.js](https://img.shields.io/badge/Node.js-v20%2B-green.svg)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue.svg)](https://www.typescriptlang.org/)
[![MCP](https://img.shields.io/badge/Protocol-MCP%20Streamable%20HTTP-orange.svg)](https://modelcontextprotocol.io/)
[![License](https://img.shields.io/badge/License-MIT-purple.svg)](LICENSE)

AutoDL Pilot 是一个专为本地 AI Agent 设计的 **AutoDL GPU 实例自动化生命周期管理服务**。遵循官方 [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) 规范，采用 **Streamable HTTP** 传输协议，参考 [AutoDL 容器实例Pro官方 API 文档](https://www.autodl.com/docs/instance_pro_api/)，实现 GPU 实例首次开机、智能退避持续开机、关机竞态消除、安全 SSH 鉴权信息脱敏与远程实验任务跟踪。

---

## 目录

- [系统架构与安全边界](#系统架构与安全边界)
- [核心特性](#核心特性)
- [项目目录结构](#项目目录结构)
- [快速开始](#快速开始)
- [MCP Tools 工具接口定义](#mcp-tools-工具接口定义)
- [AI Agent 本地 SSH 与 Git 工作流](#ai-agent-本地-ssh-与-git-工作流)
- [远程服务器生产部署方案](#远程服务器生产部署方案)
- [测试套件说明](#测试套件说明)

---

## 系统架构与安全边界

### 1. 架构总览

```mermaid
flowchart TD
    subgraph Local["本地开发机 (Local Environment)"]
        Agent["🤖 本地 AI Agent"]
        GitLocal["📦 本地 Git 仓库\n(代码编写/Commit/Push)"]
        SSHKey["🔑 本地 Ed25519 私钥\n(~/.ssh/id_ed25519_autodl)"]
        SSHClient["💻 本地 SSH Client\n(wait-for-ssh / git-sync-run)"]
    end

    subgraph RemoteServer["远程部署服务器 (Remote Server)"]
        subgraph MCPServer["AutoDL Pilot MCP 服务 (:3000)"]
            AuthMiddle["🛡️ Bearer Token 鉴权中间件"]
            Transport["⚡ Streamable HTTP Transport (/mcp)"]
            Tools["🧰 MCP Tools 处理器"]
            Scheduler["🔄 持续开机调度器 & 互斥锁"]
            ExpMgr["🧪 实验元数据管理器"]
            SQLite[("💾 SQLite 持久化\n(WAL 模式)")]
            Client["🌐 AutoDL 官方 API Client"]
        end
    end

    subgraph AutoDLPlatform["AutoDL 云平台"]
        OfficialAPI["☁️ AutoDL 官方 API\n(api.autodl.com)"]
        GPUInstance["🖥️ GPU 容器实例 (SSH/Jupyter)"]
    end

    Agent -->|1. HTTP /mcp 携带 MCP_AUTH_TOKEN| AuthMiddle
    AuthMiddle --> Transport --> Tools
    Tools --> Scheduler & ExpMgr
    Scheduler -->|记录任务状态| SQLite
    ExpMgr -->|记录实验信息| SQLite
    Scheduler --> Client
    Tools --> Client
    Client -->|2. 调用官方 API| OfficialAPI

    Agent -->|3. 获取已脱敏 SSH 信息| Tools
    Agent -->|4. 本地执行免密登录与代码同步| SSHClient
    SSHClient -->|5. 使用本地私钥免密登录| GPUInstance
    GitLocal -->|Push 代码| GPUInstance
```

### 2. 安全与职责边界

| 功能维度 | 远程 MCP Server 职责 | 本地 AI Agent 职责 |
| :--- | :--- | :--- |
| **凭证管理** | 从 `.env` 读取 AutoDL 开发者 Token；使用独立的 `MCP_AUTH_TOKEN` 拦截未授权访问。 | 持有本地 SSH 私钥；持有 Git 提交与 Push 权限。 |
| **敏感信息保护** | **自动剥离 AutoDL 返回的 `root_password`**，仅输出主机、端口、用户名等安全字段。 | SSH 私钥永不上传远端；私有仓库使用只读 Token 或 Deploy Key。 |
| **生命周期调度** | 负责实例开机、GPU 资源不足后台持续重试、关机操作及竞态消除。 | 发起开机/关机指令，查询实例状态与任务进度。 |
| **实验与代码执行** | 提供标准化的后台命令模板（防 SSH 中断）与实验元数据持久化。 | **实际 SSH 连接、代码拉取、依赖安装和训练运行全部由本地 Agent 执行**。 |

---

## 核心特性

1. **协议现代化（Streamable HTTP）**：
   - 采用官方 `@modelcontextprotocol/sdk` 的 `StreamableHTTPServerTransport`，支持 Direct HTTP 与 SSE 双向流式响应。
   - 独立的 HTTP Bearer Token 保护，防止远程暴露未授权接口。
2. **智能持续开机与退避算法（Smart Retry Engine）**：
   - **即时响应**：首次开机立即向 Agent 返回结果。
   - **自动降级重试**：因 GPU 资源紧张开机失败时，自动创建后台重试任务，不阻塞 MCP 连接。
   - **指数退避与 Jitter**：配置初始间隔、退避倍数、最大间隔及 ±10% 随机扰动，保护 AutoDL 平台接口。
   - **错误精准分类**：鉴权失败、实例不存在、账户欠费等不可重试错误立即终止并告警；资源不足和网络抖动自动重试。
3. **SQLite 状态持久化与重启恢复（Crash-Proof）**：
   - 所有开机任务与实验记录持久化到 SQLite（启用 WAL 模式）。
   - 服务崩溃或重启后自动扫描未完成任务，比对远端真实状态无缝恢复重试循环。
4. **关机竞态消除（Race Condition Prevention）**：
   - 实例级互斥锁保证同一实例不发生并发开机冲突。
   - Agent 发起关机操作时，**强制同步取消该实例所有后台重试任务并打断执行**，彻底避免关机后又被后台任务唤醒扣费。
5. **完整运行就绪检测**：
   - 开机 API 成功并不代表系统完全就绪，调度器持续轮询直到实例进入 `running`。
   - 提供本地 SSH 端口探针脚本，等待 sshd 服务与公钥加载完毕后再执行实验。

---

## 项目目录结构

```text
AutodlPilot/
├── package.json                   # 项目依赖与编译配置
├── tsconfig.json                  # TypeScript 严格模式配置
├── .env.example                   # 环境变量模板
├── src/
│   ├── index.ts                   # 主入口：初始化 Express、MCP Transport 与优雅退出
│   ├── config/                    # 基于 Zod 的类型安全配置管理
│   │   └── index.ts
│   ├── logger/                    # Pino 高性能结构化日志
│   │   └── index.ts
│   ├── autodl/                    # AutoDL 官方 API Client 与错误分类
│   │   ├── client.ts              # 封装官方 REST API（带重试与脱敏）
│   │   ├── errors.ts              # 错误分类器（Retryable vs NonRetryable）
│   │   └── types.ts               # 数据模型定义
│   ├── storage/                   # SQLite 持久化层
│   │   ├── db.ts                  # SQLite 实例与 WAL 模式初始化
│   │   ├── task-store.ts          # 持续开机任务仓储
│   │   └── experiment-store.ts    # 实验元数据仓储
│   ├── scheduler/                 # 持续开机调度器
│   │   ├── mutex.ts               # 实例级互斥锁与 AbortController 管理
│   │   └── scheduler.ts           # 状态机流转、退避算法与任务恢复
│   ├── experiment/                # 实验管理器
│   │   └── manager.ts             # 实验注册、nohup 模板与自动关机
│   ├── mcp/                       # Model Context Protocol 服务实现
│   │   ├── middleware.ts          # MCP Bearer Token 鉴权中间件
│   │   └── server.ts              # 11 个 MCP Tools 注册与调用处理
│   └── client-workflow/           # 本地 Agent 执行的辅助工作流脚本
│       ├── ssh-init.sh            # 本地 Ed25519 密钥生成与 SSH Config 配置
│       ├── wait-for-ssh.sh        # SSH 端口与免密登录就绪探针
│       ├── git-sync-run.sh        # 本地提交校验、远端代码检出与后台运行
│       └── README.md              # 本地 Agent 操作指南
├── tests/                         # 自动化测试套件 (Vitest)
│   ├── autodl-client.test.ts      # 错误分类与敏感信息过滤测试
│   ├── scheduler.test.ts          # 状态机流转与持续开机重试测试
│   ├── race-condition.test.ts     # 关机竞态与互斥冲突测试
│   ├── recovery.test.ts           # 服务重启持久化任务恢复测试
│   └── mcp-integration.test.ts    # MCP 鉴权与工具集成测试
└── scripts/                       # 生产部署脚本
    ├── setup-remote.sh            # 远程服务器一键部署脚本
    ├── autodl-mcp.service         # systemd 服务管理配置
    └── mcp-client-config.json     # MCP Client 连接配置示例
```

---

## 快速开始

### 1. 安装环境与依赖

运行环境要求：Node.js >= 20.x，npm >= 9.x。

```bash
git clone <your-repo-url> AutodlPilot
cd AutodlPilot
npm install
```

### 2. 配置环境变量

复制 `.env.example` 并生成 `.env`：

```bash
cp .env.example .env
```

编辑 `.env` 文件，填入配置：

```ini
# [必填] AutoDL 开发者 Token (从 AutoDL 控制台 -> 设置 -> 开发者Token 获取)
AUTODL_TOKEN=your_autodl_developer_token_here

# [必填] 保护远程 MCP 服务的访问 Token (客户端调用时携带)
MCP_AUTH_TOKEN=your_secure_mcp_access_token_here

# [可选] 服务监听端口与地址
PORT=3000
HOST=0.0.0.0

# [可选] SQLite 数据库持久化路径
DATABASE_PATH=./data/autodl-pilot.db

# [可选] 重试调度参数
RETRY_INITIAL_INTERVAL_SEC=10
RETRY_MAX_INTERVAL_SEC=120
RETRY_BACKOFF_FACTOR=1.5
RETRY_MAX_DURATION_MINUTES=120
```

### 3. 构建与本地运行

```bash
# 编译 TypeScript
npm run build

# 运行全套测试
npm test

# 启动服务
npm start
```

---

## MCP Tools 工具接口定义

服务向 AI Agent 暴露以下 11 个标准化 MCP 工具：

| 工具名称 | 功能描述 | 核心输入参数 |
| :--- | :--- | :--- |
| `power_on_instance` | 请求开启实例。若 GPU 不足自动转入后台持久化重试。 | `instance_uuid`, `start_command?` |
| `power_off_instance` | 关闭实例。**自动强制取消所有挂起的开机重试，杜绝竞态**。 | `instance_uuid` |
| `get_instance_info` | 查询实例状态、GPU型号、已脱敏安全 SSH 信息（已过滤密码）。 | `instance_uuid` |
| `get_power_on_task_status` | 查询持续开机任务状态、重试次数、最近错误及下次重试时间。 | `task_id?`, `instance_uuid?` |
| `cancel_power_on_task` | 主动取消后台正在执行的开机重试任务。 | `task_id`, `reason?` |
| `list_instances` | 分页查看当前账户下所有的 AutoDL 实例。 | `page_index?`, `page_size?` |
| `get_account_balance` | 查询当前账户现金余额、累计消费及代金券可用余额。 | 无 |
| `register_experiment` | 注册实验元数据，生成防 SSH 断开的后台命令包装器。 | `instance_uuid`, `command`, `git_commit_sha?`, `auto_power_off?` |
| `update_experiment_status` | 记录实验运行 PID、退出码及完成状态。支持结束后自动关机。 | `exp_id`, `status`, `pid?`, `exit_code?` |
| `get_experiment_status` | 查询实验详情、日志路径、开始/结束时间与退出码。 | `exp_id?`, `instance_uuid?` |
| `get_ssh_setup_guide` | 获取本地 Ed25519 密钥生成、AutoDL 公钥配置与 SSH Config 指南。 | `instance_uuid?` |

---

## AI Agent 本地 SSH 与 Git 工作流

本地 AI Agent 按照以下标准序列控制实验环境：

### 步骤 1：本地执行免密登录初始化（一次性）

在本地执行：
```bash
bash src/client-workflow/ssh-init.sh
```
将打印出的 `~/.ssh/id_ed25519_autodl.pub` 添加到 AutoDL 控制台的「SSH公钥」中。

### 步骤 2：开机与状态获取

Agent 通过 MCP 调用：
1. `power_on_instance({ instance_uuid: "pro-xxxx" })`
2. 若转入后台重试，Agent 可定期调用 `get_power_on_task_status({ instance_uuid: "pro-xxxx" })` 查看进度。
3. 当状态变为 `running` 时，调用 `get_instance_info` 获取脱敏连接信息：
   - 返回示例：`{ ssh_host: "connect.westb.autodl.com", ssh_port: 34222, ssh_user: "root" }`

### 步骤 3：SSH 就绪探针

Agent 在本地运行探测脚本，确认远端 SSH 服务与公钥完全就绪：
```bash
bash src/client-workflow/wait-for-ssh.sh connect.westb.autodl.com 34222
```

### 步骤 4：本地 Git 提交与远程代码检出

1. 本地代码完成修改后，执行 `git commit` 和 `git push`。
2. Agent 执行代码同步脚本：
   ```bash
   bash src/client-workflow/git-sync-run.sh \
     connect.westb.autodl.com \
     34222 \
     https://github.com/my-org/my-project.git \
     /root/autodl-tmp/workspace \
     "python train.py --epochs 20"
   ```
   脚本将比对本地与远端的 Commit SHA，确保远程执行代码与本地提交版本绝对一致。

### 步骤 5：登记实验与后台无中断运行

1. Agent 调用 `register_experiment` 注册实验并获取包装命令：
   ```json
   {
     "instance_uuid": "pro-xxxx",
     "command": "python train.py --epochs 20",
     "git_commit_sha": "c1f7a39...",
     "auto_power_off": true
   }
   ```
2. Agent 通过 SSH 在远端后台拉起实验（使用 `setsid`/`nohup` 自动重定向日志，并记录 PID）。
3. 训练完成后，若启用了 `auto_power_off`，系统自动关闭机器以节省成本。

---

## 远程服务器生产部署方案

### 方式 1：使用自动化脚本一键部署

在远程 Linux 服务器（Ubuntu / Debian）上执行：

```bash
sudo bash scripts/setup-remote.sh
```

脚本将自动完成：
- 安装 Node.js 22 LTS 运行环境；
- 同步代码到 `/opt/autodl-pilot`；
- 安装依赖并完成 TypeScript 编译；
- 配置并启动 `systemd` 服务守护进程（支持奔溃自愈与开机自启）。

### 方式 2：手动 systemd 服务配置

将 `scripts/autodl-mcp.service` 安装到系统：

```bash
sudo cp scripts/autodl-mcp.service /etc/systemd/system/autodl-mcp.service
sudo systemctl daemon-reload
sudo systemctl enable autodl-mcp
sudo systemctl start autodl-mcp
```

### MCP 客户端配置示例（Claude Desktop / Cursor）

在客户端的 MCP 配置文件中添加：

```json
{
  "mcpServers": {
    "autodl-pilot": {
      "url": "http://your-remote-server-ip:3000/mcp",
      "headers": {
        "Authorization": "Bearer your_secure_mcp_access_token_here"
      }
    }
  }
}
```

---

## 测试套件说明

项目包含了完整的自动化测试套件，全面覆盖核心场景：

```bash
npm test
```

测试覆盖场景包括：
- `tests/autodl-client.test.ts`: 错误分类（区分可重试/不可重试错误）、密码及敏感信息严格脱敏；
- `tests/scheduler.test.ts`: 状态机流转、首次开机成功、GPU 资源不足自动转入退避重试、主动取消任务；
- `tests/race-condition.test.ts`: **关机竞态测试**（关机强制打断重试循环并清除活跃任务）、多任务并发幂等互斥；
- `tests/recovery.test.ts`: **服务重启恢复测试**（从 SQLite 重建未完成任务并与远端状态同步）；
- `tests/mcp-integration.test.ts`: MCP 访问 Token 认证中间件拦截与放行、MCP Tools 注册与调用。
