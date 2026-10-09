import { loadConfig } from './config/index.js';
import { logger } from './logger/index.js';
import { openDatabase } from './storage/db.js';
import { TaskStore } from './storage/task-store.js';
import { AutoDLClient } from './autodl/client.js';
import { PowerOnScheduler } from './scheduler/scheduler.js';
import { createHttpApp } from './mcp/app.js';

async function bootstrap() {
  const config = loadConfig();
  logger.level = config.LOG_LEVEL;
  const db = openDatabase(config.DATABASE_PATH);
  const client = new AutoDLClient({
    baseUrl: config.AUTODL_BASE_URL, token: config.AUTODL_TOKEN, timeoutMs: config.AUTODL_TIMEOUT_MS,
  });
  const scheduler = new PowerOnScheduler(client, new TaskStore(db), {
    initialIntervalSec: config.RETRY_INITIAL_INTERVAL_SEC,
    maxIntervalSec: config.RETRY_MAX_INTERVAL_SEC,
    backoffFactor: config.RETRY_BACKOFF_FACTOR,
    maxDurationMinutes: config.RETRY_MAX_DURATION_MINUTES,
    pollStatusIntervalSec: config.POLL_STATUS_INTERVAL_SEC,
    pollStatusTimeoutSec: config.POLL_STATUS_TIMEOUT_SEC,
  });
  const httpApp = createHttpApp({ client, scheduler, authToken: config.MCP_AUTH_TOKEN, allowedOrigins: config.MCP_ALLOWED_ORIGINS });
  const server = httpApp.app.listen(config.PORT, config.HOST);
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  await scheduler.recoverTasks();
  logger.info({ host: config.HOST, port: config.PORT }, 'AutoDL Pilot MCP 已启动；公网访问请使用 HTTPS 或私有隧道');

  let stopping = false;
  const gracefulShutdown = async () => {
    if (stopping) return;
    stopping = true;
    const timeout = setTimeout(() => {
      logger.error('停止超时；请核实平台实际状态');
      process.exit(1);
    }, 30000).unref();
    const httpClosed = new Promise<void>((resolve) => server.close(() => resolve()));
    try {
      await scheduler.shutdown();
      await httpApp.close();
      server.closeIdleConnections();
      await httpClosed;
      db.close();
      clearTimeout(timeout);
      logger.info('任务已排空，服务已停止');
    } catch {
      logger.error('服务停止失败');
      process.exitCode = 1;
    }
  };
  process.once('SIGINT', () => { void gracefulShutdown(); });
  process.once('SIGTERM', () => { void gracefulShutdown(); });
}

bootstrap().catch((error) => {
  logger.fatal({ message: error instanceof Error ? error.message : '未知错误' }, 'AutoDL Pilot 启动失败');
  process.exit(1);
});
