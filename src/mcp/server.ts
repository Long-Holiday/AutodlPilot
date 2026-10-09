import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ListToolsRequestSchema, CallToolRequestSchema, ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { AutoDLClient } from '../autodl/client.js';
import { PowerOnScheduler } from '../scheduler/scheduler.js';
import { taskView } from '../storage/task-store.js';
import { errorDetails } from '../autodl/errors.js';
import { logger } from '../logger/index.js';

export interface CreateMcpServerOptions {
  client: AutoDLClient;
  scheduler: PowerOnScheduler;
}

const instanceId = z.string().regex(/^pro-[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/, '需要 pro- 开头的实例 ID');
const taskId = z.string().regex(/^task_[A-Za-z0-9_-]+$/).max(128);
const instanceArgs = z.object({ instance_uuid: instanceId }).strict();
const schemas = {
  power_on_instance: instanceArgs,
  retry_power_on_instance: instanceArgs,
  power_off_instance: instanceArgs,
  get_instance_info: instanceArgs.extend({ include_connection: z.boolean().default(false) }),
  get_power_on_task_status: z.object({
    task_id: taskId.optional(), instance_uuid: instanceId.optional(),
  }).strict().refine((args) => Boolean(args.task_id) !== Boolean(args.instance_uuid), '请只提供 task_id 或 instance_uuid 其中一个'),
  cancel_power_on_task: z.object({ task_id: taskId }).strict(),
};
const descriptions: Record<keyof typeof schemas, string> = {
  power_on_instance: '按实例 ID 只发送一次 GPU 开机请求，立即返回接受或失败；不自动重试。接受不代表 running 或 SSH 就绪。',
  retry_power_on_instance: '显式创建持久化的后台持续开机任务，快速返回 task_id 和截止时间。同实例幂等，默认最多 120 分钟（部署配置可调整）。用于初次开机 GPU 资源不足后继续请求。',
  power_off_instance: '先取消持续开机并等待在途操作清理，再发送一次关机。返回接受结果，实际状态需查询；无法撤回平台已收到的请求。',
  get_instance_info: '查询实例原始状态。include_connection=true 时另查安全 SSH host/port/user，不返回密码。running 后仍需本机检查 SSH。',
  get_power_on_task_status: '按 task_id 或 instance_uuid 查询持续任务；按实例返回最近任务，包括终态、尝试次数、最后错误和截止时间。',
  cancel_power_on_task: '取消指定持续开机任务，不关闭实例，不覆盖已完成任务。',
};

function parseArgs<T extends z.ZodType>(schema: T, args: unknown): z.output<T> {
  const result = schema.safeParse(args);
  if (!result.success) {
    throw new McpError(ErrorCode.InvalidParams, result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '));
  }
  return result.data;
}

export function createMcpServer({ client, scheduler }: CreateMcpServerOptions): Server {
  const server = new Server({ name: 'autodl-pilot-mcp', version: '2.0.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: Object.entries(schemas).map(([name, schema]) => ({
      name,
      description: descriptions[name as keyof typeof schemas],
      inputSchema: {
        ...z.toJSONSchema(schema, { io: 'input' }),
        type: 'object' as const,
        ...(name === 'get_power_on_task_status' ? {
          oneOf: [{ required: ['task_id'] }, { required: ['instance_uuid'] }],
        } : {}),
      },
      annotations: {
        readOnlyHint: name.startsWith('get_'),
        destructiveHint: name === 'power_off_instance',
        openWorldHint: true,
      },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const { name, arguments: args = {} } = request.params;
    logger.debug({ tool: name }, '收到 MCP 工具调用');
    try {
      let result: Record<string, unknown>;
      switch (name) {
        case 'power_on_instance': {
          const { instance_uuid } = parseArgs(schemas.power_on_instance, args);
          result = await scheduler.requestPowerOn(instance_uuid);
          break;
        }
        case 'retry_power_on_instance': {
          const { instance_uuid } = parseArgs(schemas.retry_power_on_instance, args);
          result = scheduler.requestPowerOnRetry(instance_uuid);
          break;
        }
        case 'power_off_instance': {
          const { instance_uuid } = parseArgs(schemas.power_off_instance, args);
          result = await scheduler.powerOff(instance_uuid) as Record<string, unknown>;
          break;
        }
        case 'get_instance_info': {
          const { instance_uuid, include_connection } = parseArgs(schemas.get_instance_info, args);
          result = { ...await client.getSafeSnapshot(instance_uuid, include_connection, extra.signal) };
          break;
        }
        case 'get_power_on_task_status': {
          const { task_id, instance_uuid } = parseArgs(schemas.get_power_on_task_status, args);
          const task = task_id ? scheduler.getTaskStatus(task_id) : scheduler.getLatestTaskByInstance(instance_uuid!);
          result = task ? { task: taskView(task) } : { status: 'not_found', message: '未找到持续开机任务' };
          break;
        }
        case 'cancel_power_on_task': {
          const { task_id } = parseArgs(schemas.cancel_power_on_task, args);
          result = { task_id, cancelled: scheduler.cancelTask(task_id), message: '取消持续请求不等于实例关机' };
          break;
        }
        default:
          throw new McpError(ErrorCode.MethodNotFound, `未知工具: ${name}`);
      }
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        structuredContent: result,
        isError: ['failed', 'gpu_unavailable', 'busy', 'not_found'].includes(String(result.status)),
      };
    } catch (error) {
      if (error instanceof McpError) throw error;
      const result = errorDetails(error);
      logger.warn({ tool: name, kind: result.kind }, 'MCP 工具执行失败');
      return { isError: true, content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
    }
  });
  return server;
}
