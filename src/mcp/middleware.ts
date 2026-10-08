import { Request, Response, NextFunction } from 'express';
import { config } from '../config/index.js';
import { logger } from '../logger/index.js';

/**
 * 校验请求的 MCP 访问 Token
 * 支持 Header: "Authorization: Bearer <token>" 或 URL Query: "?token=<token>"
 */
export function mcpAuthMiddleware(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  let clientToken: string | undefined;

  if (authHeader && authHeader.startsWith('Bearer ')) {
    clientToken = authHeader.substring(7).trim();
  } else if (typeof req.query.token === 'string') {
    clientToken = req.query.token.trim();
  }

  if (!clientToken || clientToken !== config.MCP_AUTH_TOKEN) {
    logger.warn(
      { ip: req.ip, path: req.path, method: req.method },
      '拒绝未授权的 MCP 访问请求（Token 不匹配或未提供）'
    );
    res.status(401).json({
      error: 'Unauthorized',
      message: 'MCP 访问鉴权失败：请在 Authorization 请求头中携带有效的 Bearer Token',
    });
    return;
  }

  next();
}
