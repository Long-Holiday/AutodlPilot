import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ErrorCode,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { AutoDLClient } from '../autodl/client.js';
import { PowerOnScheduler } from '../scheduler/scheduler.js';
import { ExperimentManager } from '../experiment/manager.js';
import { logger } from '../logger/index.js';

export interface CreateMcpServerOptions {
  client: AutoDLClient;
  scheduler: PowerOnScheduler;
  experimentManager: ExperimentManager;
}

export function createMcpServer(options: CreateMcpServerOptions): Server {
  const { client, scheduler, experimentManager } = options;

  const server = new Server(
    {
      name: 'autodl-pilot-mcp',
      version: '1.0.0',
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // 1. 注册工具列表
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        {
          name: 'power_on_instance',
          description:
            '请求开启 AutoDL GPU 实例。如果成功开机立即返回；如果因 GPU 资源不足导致开机失败，将自动创建后台持续开机任务并在后台按退避算法持续重试，直到开机成功并进入 running 状态或达到最大重试时长。',
          inputSchema: {
            type: 'object',
            properties: {
              instance_uuid: {
                type: 'string',
                description: 'AutoDL 实例的 UUID，例如 pro-76576c61fdf1',
              },
              start_command: {
                type: 'string',
                description: '可选：开机后在实例中执行的初始命令',
              },
            },
            required: ['instance_uuid'],
          },
        },
        {
          name: 'power_off_instance',
          description:
            '关闭 AutoDL 实例。重要特性：执行此操作会自动立即取消该实例所有后台持续开机任务，避免关机后被后台重试任务再次开机的竞态问题。',
          inputSchema: {
            type: 'object',
            properties: {
              instance_uuid: {
                type: 'string',
                description: '要关闭的 AutoDL 实例 UUID',
              },
            },
            required: ['instance_uuid'],
          },
        },
        {
          name: 'get_instance_info',
          description:
            '获取实例状态、硬件规格、计费情况以及面向本地 Agent 的安全 SSH 连接信息（已过滤敏感密码）。在实例进入 running 状态后，本地 Agent 可使用返回的 host 和 port 建立 SSH 连接。',
          inputSchema: {
            type: 'object',
            properties: {
              instance_uuid: {
                type: 'string',
                description: 'AutoDL 实例 UUID',
              },
            },
            required: ['instance_uuid'],
          },
        },
        {
          name: 'get_power_on_task_status',
          description:
            '查询持续开机任务的状态、当前重试次数、最近一次错误信息及下次重试时间。',
          inputSchema: {
            type: 'object',
            properties: {
              task_id: {
                type: 'string',
                description: '可选：具体的开机任务 ID',
              },
              instance_uuid: {
                type: 'string',
                description: '可选：实例 UUID（若未提供 task_id，查询该实例最近的任务）',
              },
            },
          },
        },
        {
          name: 'cancel_power_on_task',
          description: '主动取消正在后台重试的开机任务。',
          inputSchema: {
            type: 'object',
            properties: {
              task_id: {
                type: 'string',
                description: '要取消的任务 ID',
              },
              reason: {
                type: 'string',
                description: '取消原因',
              },
            },
            required: ['task_id'],
          },
        },
        {
          name: 'list_instances',
          description: '分页获取当前 AutoDL 账户下的实例列表和运行状态。',
          inputSchema: {
            type: 'object',
            properties: {
              page_index: {
                type: 'number',
                description: '页码，默认 1',
              },
              page_size: {
                type: 'number',
                description: '每页条数，默认 20',
              },
            },
          },
        },
        {
          name: 'get_account_balance',
          description: '查询当前 AutoDL 账户的现金余额、累计消费以及代金券余额。',
          inputSchema: {
            type: 'object',
            properties: {},
          },
        },
        {
          name: 'register_experiment',
          description:
            '在远程执行实验前注册实验任务元数据，返回标准化且防 SSH 断开的后台执行脚本（使用 nohup/setsid、日志重定向、PID 记录与退出码追踪）。',
          inputSchema: {
            type: 'object',
            properties: {
              instance_uuid: {
                type: 'string',
                description: '实例 UUID',
              },
              command: {
                type: 'string',
                description: '要执行的实验 Bash 命令，例如: python train.py --epochs 10',
              },
              git_commit_sha: {
                type: 'string',
                description: '当前实验对应的 Git 提交 SHA 标识',
              },
              log_path: {
                type: 'string',
                description: '自定义日志输出路径，默认 /root/autodl-tmp/logs/<exp_id>.log',
              },
              auto_power_off: {
                type: 'boolean',
                description: '实验完成或失败后是否自动关闭 AutoDL 实例以节省费用，默认 false',
              },
            },
            required: ['instance_uuid', 'command'],
          },
        },
        {
          name: 'update_experiment_status',
          description:
            '更新实验任务的实际执行状态（如填入远端进程 PID、标记完成状态及退出码）。若注册时勾选了 auto_power_off 且实验进入终止状态，将自动触发关机。',
          inputSchema: {
            type: 'object',
            properties: {
              exp_id: {
                type: 'string',
                description: '实验任务 ID',
              },
              status: {
                type: 'string',
                enum: ['RUNNING', 'COMPLETED', 'FAILED', 'TERMINATED'],
                description: '实验状态',
              },
              pid: {
                type: 'number',
                description: '远端后台进程 PID',
              },
              exit_code: {
                type: 'number',
                description: '实验进程退出码（0 表示成功）',
              },
              error_message: {
                type: 'string',
                description: '错误信息（如果有）',
              },
            },
            required: ['exp_id', 'status'],
          },
        },
        {
          name: 'get_experiment_status',
          description: '查询实验的元数据、日志路径、开始结束时间、退出码以及进程状态。',
          inputSchema: {
            type: 'object',
            properties: {
              exp_id: {
                type: 'string',
                description: '实验 ID',
              },
              instance_uuid: {
                type: 'string',
                description: '或查询指定实例关联的所有实验记录',
              },
            },
          },
        },
        {
          name: 'get_ssh_setup_guide',
          description:
            '获取本地 Agent 执行免密 SSH 连接的详细指引、本机生成 Ed25519 密钥命令、AutoDL 公钥配置方法及 SSH Config 最佳配置。',
          inputSchema: {
            type: 'object',
            properties: {
              instance_uuid: {
                type: 'string',
                description: '可选：指定实例 UUID，用于自动填充具体的 SSH 主机和端口',
              },
            },
          },
        },
      ],
    };
  });

  // 2. 处理工具调用
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;
    logger.info({ name, args }, '收到 MCP 工具调用请求');

    try {
      let result: unknown;

      switch (name) {
        case 'power_on_instance': {
          const { instance_uuid, start_command } = args as {
            instance_uuid: string;
            start_command?: string;
          };
          if (!instance_uuid) {
            throw new McpError(ErrorCode.InvalidParams, 'instance_uuid 不能为空');
          }
          result = await scheduler.requestPowerOn(instance_uuid, 'gpu', start_command);
          break;
        }

        case 'power_off_instance': {
          const { instance_uuid } = args as { instance_uuid: string };
          if (!instance_uuid) {
            throw new McpError(ErrorCode.InvalidParams, 'instance_uuid 不能为空');
          }
          // 竞态消除：关机前自动强制取消所有挂起的开机重试任务
          const cancelledCount = scheduler.cancelActiveTasksForInstance(
            instance_uuid,
            '用户发起关机操作，已取消关联的开机任务'
          );
          await client.powerOff(instance_uuid);
          result = {
            instance_uuid,
            status: 'shutting_down',
            cancelled_retry_tasks_count: cancelledCount,
            message: `实例 ${instanceUuidMessage(instance_uuid)} 关机请求已发送成功，已自动终止 ${cancelledCount} 个后台开机任务以防竞态复活。`,
          };
          break;
        }

        case 'get_instance_info': {
          const { instance_uuid } = args as { instance_uuid: string };
          if (!instance_uuid) {
            throw new McpError(ErrorCode.InvalidParams, 'instance_uuid 不能为空');
          }
          result = await client.getSafeSnapshot(instance_uuid);
          break;
        }

        case 'get_power_on_task_status': {
          const { task_id, instance_uuid } = args as {
            task_id?: string;
            instance_uuid?: string;
          };
          if (task_id) {
            const task = scheduler.getTaskStatus(task_id);
            result = task || { error: '未找到指定任务', task_id };
          } else if (instance_uuid) {
            const task = scheduler.getActiveTaskByInstance(instance_uuid);
            result = task || { message: '该实例当前没有活跃的开机任务', instance_uuid };
          } else {
            throw new McpError(ErrorCode.InvalidParams, '必须提供 task_id 或 instance_uuid 之一');
          }
          break;
        }

        case 'cancel_power_on_task': {
          const { task_id, reason } = args as { task_id: string; reason?: string };
          if (!task_id) {
            throw new McpError(ErrorCode.InvalidParams, 'task_id 不能为空');
          }
          const success = scheduler.cancelTask(task_id, reason);
          result = {
            task_id,
            cancelled: success,
            message: success ? '任务已成功取消' : '任务不存在或已处于完成/终止状态',
          };
          break;
        }

        case 'list_instances': {
          const { page_index = 1, page_size = 20 } = args as {
            page_index?: number;
            page_size?: number;
          };
          result = await client.listInstances(page_index, page_size);
          break;
        }

        case 'get_account_balance': {
          result = await client.getBalance();
          break;
        }

        case 'register_experiment': {
          const { instance_uuid, command, git_commit_sha, log_path, auto_power_off } = args as {
            instance_uuid: string;
            command: string;
            git_commit_sha?: string;
            log_path?: string;
            auto_power_off?: boolean;
          };
          if (!instance_uuid || !command) {
            throw new McpError(ErrorCode.InvalidParams, 'instance_uuid 和 command 均为必填字段');
          }
          result = experimentManager.registerExperiment({
            instance_uuid,
            command,
            git_commit_sha,
            log_path,
            auto_power_off,
          });
          break;
        }

        case 'update_experiment_status': {
          const { exp_id, status, pid, exit_code, error_message } = args as {
            exp_id: string;
            status: 'RUNNING' | 'COMPLETED' | 'FAILED' | 'TERMINATED';
            pid?: number;
            exit_code?: number;
            error_message?: string;
          };
          if (!exp_id || !status) {
            throw new McpError(ErrorCode.InvalidParams, 'exp_id 和 status 为必填');
          }
          result = await experimentManager.updateExperiment({
            exp_id,
            status,
            pid,
            exit_code,
            error_message,
          });
          break;
        }

        case 'get_experiment_status': {
          const { exp_id, instance_uuid } = args as {
            exp_id?: string;
            instance_uuid?: string;
          };
          if (exp_id) {
            result = experimentManager.getExperiment(exp_id) || { error: '未找到指定实验', exp_id };
          } else if (instance_uuid) {
            result = experimentManager.listExperiments(instance_uuid);
          } else {
            throw new McpError(ErrorCode.InvalidParams, '必须提供 exp_id 或 instance_uuid');
          }
          break;
        }

        case 'get_ssh_setup_guide': {
          const { instance_uuid } = args as { instance_uuid?: string };
          let host = '<proxy_host>';
          let port = '<ssh_port>';

          if (instance_uuid) {
            try {
              const snapshot = await client.getSafeSnapshot(instance_uuid);
              host = snapshot.ssh_host;
              port = String(snapshot.ssh_port);
            } catch {
              // 降级使用占位符
            }
          }

          result = {
            guide: {
              step1_key_generation: {
                title: '1. 本机生成独立的 Ed25519 密钥对（不覆盖现有默认密钥）',
                command: 'ssh-keygen -t ed25519 -C "autodl-agent-key" -f ~/.ssh/id_ed25519_autodl -N ""',
              },
              step2_upload_public_key: {
                title: '2. 配置公钥到 AutoDL 控制台',
                instruction:
                  '查看公钥内容: cat ~/.ssh/id_ed25519_autodl.pub ，登录 AutoDL 网页控制台 -> 控制台中心 -> 设置 -> SSH公钥，将公钥内容添加进去。AutoDL 会自动在所有新开机的实例中注入该公钥。',
              },
              step3_ssh_config: {
                title: '3. 本机配置 ~/.ssh/config 自动匹配连接',
                config_snippet: `
Host autodl-instance
    HostName ${host}
    Port ${port}
    User root
    IdentityFile ~/.ssh/id_ed25519_autodl
    StrictHostKeyChecking accept-new
    ServerAliveInterval 30
    ServerAliveCountMax 3
                `.trim(),
              },
              step4_readiness_probe: {
                title: '4. 本机 SSH 就绪探针脚本示例',
                bash_snippet: `
until nc -z -w 3 ${host} ${port} 2>/dev/null; do
    echo "等待 AutoDL 实例 SSH 端口就绪 (${host}:${port})..."
    sleep 2
done
echo "SSH 端口已就绪，正在测试免密登录..."
ssh -i ~/.ssh/id_ed25519_autodl -p ${port} -o BatchMode=yes -o ConnectTimeout=5 root@${host} "echo SSH Ready"
                `.trim(),
              },
            },
          };
          break;
        }

        default:
          throw new McpError(ErrorCode.MethodNotFound, `未知工具: ${name}`);
      }

      return {
        content: [
          {
            type: 'text',
            text: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error: unknown) {
      logger.error({ tool: name, error }, 'MCP 工具执行失败');
      if (error instanceof McpError) {
        throw error;
      }
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: `执行失败: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  });

  return server;
}

function instanceUuidMessage(uuid: string): string {
  return uuid;
}
