import dotenv from 'dotenv';
import { z } from 'zod';
import path from 'path';

// 加载环境变量
dotenv.config();

const configSchema = z.object({
  // AutoDL 官方 API 配置
  AUTODL_TOKEN: z.string().min(1, 'AUTODL_TOKEN 必须配置（请在 .env 文件中设置）'),
  AUTODL_BASE_URL: z.string().url().default('https://api.autodl.com'),

  // MCP 鉴权与 HTTP 服务配置
  MCP_AUTH_TOKEN: z.string().min(6, 'MCP_AUTH_TOKEN 必须配置且长度不少于6位'),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default('0.0.0.0'),

  // SQLite 数据库路径
  DATABASE_PATH: z.string().default('./data/autodl-pilot.db'),

  // 持续开机调度器配置（支持最长 2 小时持续重试与退避配合）
  RETRY_INITIAL_INTERVAL_SEC: z.coerce.number().positive().default(10),
  RETRY_MAX_INTERVAL_SEC: z.coerce.number().positive().default(120),
  RETRY_BACKOFF_FACTOR: z.coerce.number().min(1.0).default(1.5),
  RETRY_MAX_DURATION_MINUTES: z.coerce.number().positive().default(120),

  // 开机后实例运行状态轮询配置
  POLL_STATUS_INTERVAL_SEC: z.coerce.number().positive().default(5),
  POLL_STATUS_TIMEOUT_SEC: z.coerce.number().positive().default(180),

  // 日志配置
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
});

export type Config = z.infer<typeof configSchema>;

function loadConfig(): Config {
  const parsed = configSchema.safeParse(process.env);
  if (!parsed.success) {
    console.error('❌ 配置校验失败:');
    for (const issue of parsed.error.issues) {
      console.error(`  - [${issue.path.join('.')}] ${issue.message}`);
    }
    process.exit(1);
  }

  // 确保数据库路径的绝对路径计算正确
  const config = parsed.data;
  if (!path.isAbsolute(config.DATABASE_PATH)) {
    config.DATABASE_PATH = path.resolve(process.cwd(), config.DATABASE_PATH);
  }

  return config;
}

export const config = loadConfig();
