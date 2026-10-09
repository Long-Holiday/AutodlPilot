import pino from 'pino';

// 模块导入不加载 .env；入口在配置校验后设置日志级别。
export const logger = pino({
  level: 'info',
  redact: {
    paths: ['token', 'AUTODL_TOKEN', 'MCP_AUTH_TOKEN', 'root_password', 'jupyter_token', 'headers.authorization'],
    censor: '[REDACTED]',
  },
});
