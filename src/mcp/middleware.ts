import { timingSafeEqual, createHash } from 'node:crypto';
import { RequestHandler } from 'express';

export function mcpAuthMiddleware(token: string): RequestHandler {
  const expected = createHash('sha256').update(token).digest();
  return (req, res, next) => {
    const match = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '');
    const actual = createHash('sha256').update(match?.[1] ?? '').digest();
    if (!match || !timingSafeEqual(expected, actual)) {
      res.setHeader('WWW-Authenticate', 'Bearer');
      res.status(401).json({ error: 'Unauthorized', message: '请在 Authorization 请求头携带 MCP Bearer Token' });
      return;
    }
    next();
  };
}

export function originMiddleware(allowedOrigins: string[] = []): RequestHandler {
  const allowed = new Set(allowedOrigins);
  return (req, res, next) => {
    const origin = req.headers.origin;
    if (origin !== undefined && !allowed.has(origin)) {
      res.status(403).json({ error: 'Forbidden', message: 'Origin 不在允许列表' });
      return;
    }
    next();
  };
}
