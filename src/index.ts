import express, { Request, Response } from 'express';
import crypto from 'crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { config } from './config/index.js';
import { logger } from './logger/index.js';
import { getDatabase, closeDatabase } from './storage/db.js';
import { TaskStore } from './storage/task-store.js';
import { ExperimentStore } from './storage/experiment-store.js';
import { AutoDLClient } from './autodl/client.js';
import { PowerOnScheduler } from './scheduler/scheduler.js';
import { ExperimentManager } from './experiment/manager.js';
import { createMcpServer } from './mcp/server.js';
import { mcpAuthMiddleware } from './mcp/middleware.js';

async function bootstrap() {
  logger.info('🚀 正在启动 AutoDL Pilot MCP 服务...');

  // 1. 初始化持久化数据库
  const db = getDatabase();
  const taskStore = new TaskStore(db);
  const experimentStore = new ExperimentStore(db);

  // 2. 初始化 AutoDL API 客户端
  const autodlClient = new AutoDLClient({
    baseUrl: config.AUTODL_BASE_URL,
    token: config.AUTODL_TOKEN,
  });

  // 3. 初始化持续开机调度器
  const scheduler = new PowerOnScheduler(autodlClient, taskStore, {
    initialIntervalSec: config.RETRY_INITIAL_INTERVAL_SEC,
    maxIntervalSec: config.RETRY_MAX_INTERVAL_SEC,
    backoffFactor: config.RETRY_BACKOFF_FACTOR,
    maxDurationMinutes: config.RETRY_MAX_DURATION_MINUTES,
    pollStatusIntervalSec: config.POLL_STATUS_INTERVAL_SEC,
    pollStatusTimeoutSec: config.POLL_STATUS_TIMEOUT_SEC,
  });

  // 4. 服务启动时恢复数据库中未完成的任务
  await scheduler.recoverTasks();

  // 5. 初始化实验管理器
  const experimentManager = new ExperimentManager(experimentStore, autodlClient);

  // 6. 初始化 MCP Server 与 Streamable HTTP Transport
  const mcpServer = createMcpServer({
    client: autodlClient,
    scheduler,
    experimentManager,
  });

  const streamableTransport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
  });

  await mcpServer.connect(streamableTransport);
  logger.info('✅ MCP Server 已连接到 Streamable HTTP Transport');

  // 7. 构建 Express 服务
  const app = express();

  // 请求体解析
  app.use(express.json());

  // 健康检查与状态探针（无需鉴权，供负载均衡或运维探测）
  app.get('/health', (_req: Request, res: Response) => {
    res.json({
      status: 'healthy',
      service: 'autodl-pilot-mcp',
      timestamp: new Date().toISOString(),
      version: '1.0.0',
    });
  });

  // 基础信息与快速诊断接口（受 MCP Token 保护）
  app.get('/api/status', mcpAuthMiddleware, async (_req: Request, res: Response) => {
    try {
      const balance = await autodlClient.getBalance();
      res.json({
        service: 'autodl-pilot-mcp',
        autodl_connected: true,
        balance,
      });
    } catch (err: unknown) {
      res.status(500).json({
        service: 'autodl-pilot-mcp',
        autodl_connected: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // 挂载 MCP 认证中间件保护 /mcp 端点
  app.use('/mcp', mcpAuthMiddleware);

  // MCP Streamable HTTP 协议端点（处理 GET/POST/SSE 连接）
  app.all('/mcp', async (req: Request, res: Response) => {
    try {
      await streamableTransport.handleRequest(req, res, req.body);
    } catch (err) {
      logger.error({ err }, '处理 MCP 请求时发生异常');
      if (!res.headersSent) {
        res.status(500).json({ error: 'Internal Server Error' });
      }
    }
  });

  // 8. 启动 HTTP 监听
  const server = app.listen(config.PORT, config.HOST, () => {
    logger.info(
      `🌐 AutoDL Pilot MCP 远程服务已成功启动，正在监听 http://${config.HOST}:${config.PORT}/mcp`
    );
    logger.info(`🔒 MCP 服务受 Token 保护，请求时请附带 Authorization: Bearer <MCP_AUTH_TOKEN>`);
  });

  // 9. 优雅退出处理
  const gracefulShutdown = (signal: string) => {
    logger.info({ signal }, '收到关闭信号，正在安全关闭服务...');
    scheduler.shutdown();

    server.close(async () => {
      logger.info('HTTP 监听已关闭');
      try {
        await streamableTransport.close();
        await mcpServer.close();
      } catch (err) {
        logger.warn({ err }, '关闭 MCP 传输层时发生警告');
      }
      closeDatabase();
      logger.info('AutoDL Pilot 服务已完全停止');
      process.exit(0);
    });

    // 强制超时退出
    setTimeout(() => {
      logger.error('优雅关机超时，强制终止进程');
      process.exit(1);
    }, 10000).unref();
  };

  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
}

bootstrap().catch((err) => {
  logger.fatal({ err }, 'AutoDL Pilot 启动发生致命异常');
  process.exit(1);
});
