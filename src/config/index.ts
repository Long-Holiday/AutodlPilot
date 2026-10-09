import dotenv from 'dotenv';
import { z } from 'zod';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const projectRoot = fileURLToPath(new URL('../../', import.meta.url));

const configSchema = z.object({
  AUTODL_TOKEN: z.string().trim().min(1, '请在项目 .env 设置 AUTODL_TOKEN'),
  AUTODL_BASE_URL: z.string().url().default('https://api.autodl.com'),
  AUTODL_TIMEOUT_MS: z.coerce.number().int().positive().max(300000).default(15000),
  MCP_AUTH_TOKEN: z.string().trim().min(6, 'MCP_AUTH_TOKEN 至少为 6 位'),
  MCP_ALLOWED_ORIGINS: z.string().default('').transform((value) =>
    value.split(',').map((origin) => origin.trim()).filter(Boolean)
  ).pipe(z.array(z.string().url().refine((origin) => new URL(origin).origin === origin, '必须是不带路径的 Origin'))),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().default('127.0.0.1'),
  DATABASE_PATH: z.string().default('./data/autodl-pilot.db'),
  RETRY_INITIAL_INTERVAL_SEC: z.coerce.number().positive().default(10),
  RETRY_MAX_INTERVAL_SEC: z.coerce.number().positive().default(120),
  RETRY_BACKOFF_FACTOR: z.coerce.number().min(1).default(1.5),
  RETRY_MAX_DURATION_MINUTES: z.coerce.number().positive().max(1440).default(120),
  POLL_STATUS_INTERVAL_SEC: z.coerce.number().positive().default(5),
  POLL_STATUS_TIMEOUT_SEC: z.coerce.number().positive().default(180),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
}).refine((value) => value.RETRY_MAX_INTERVAL_SEC >= value.RETRY_INITIAL_INTERVAL_SEC, {
  message: '最大重试间隔不能小于初始间隔', path: ['RETRY_MAX_INTERVAL_SEC'],
}).refine((value) => value.AUTODL_TOKEN !== value.MCP_AUTH_TOKEN, {
  message: 'MCP_AUTH_TOKEN 不得复用 AutoDL 开发者 token', path: ['MCP_AUTH_TOKEN'],
});

export type Config = z.infer<typeof configSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env, root = projectRoot): Config {
  dotenv.config({ path: path.join(root, '.env'), processEnv: env, quiet: true });
  const parsed = configSchema.safeParse(env);
  if (!parsed.success) {
    // 不序列化输入，配置错误也不能打印实际密钥。
    throw new Error(parsed.error.issues.map((issue) => `[${issue.path.join('.')}] ${issue.message}`).join('\n'));
  }
  return {
    ...parsed.data,
    DATABASE_PATH: path.resolve(root, parsed.data.DATABASE_PATH),
  };
}
