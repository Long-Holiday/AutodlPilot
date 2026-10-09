import express from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpServer, CreateMcpServerOptions } from './server.js';
import { mcpAuthMiddleware, originMiddleware } from './middleware.js';
import { logger } from '../logger/index.js';

interface HttpAppOptions extends CreateMcpServerOptions {
  authToken: string;
  allowedOrigins?: string[];
}

export function createHttpApp(options: HttpAppOptions) {
  const app = express();
  const connections = new Set<() => Promise<void>>();
  app.disable('x-powered-by');
  app.get('/health', (_req, res) => res.json({ status: 'healthy', service: 'autodl-pilot-mcp', version: '2.0.0' }));
  app.use('/mcp', originMiddleware(options.allowedOrigins), mcpAuthMiddleware(options.authToken), express.json({ limit: '64kb' }));
  app.post('/mcp', async (req, res) => {
    const server = createMcpServer(options);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    let disposed = false;
    const dispose = async () => {
      if (disposed) return;
      disposed = true;
      connections.delete(dispose);
      await server.close();
      await transport.close();
    };
    connections.add(dispose);
    res.on('close', () => {
      void dispose().catch(() => logger.warn('MCP 请求资源清理失败'));
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch {
      logger.warn('MCP HTTP 请求处理失败');
      if (!res.headersSent) res.status(500).json({ error: 'Internal Server Error' });
      await dispose();
    }
  });
  app.all('/mcp', (_req, res) => {
    res.setHeader('Allow', 'POST');
    res.status(405).json({ error: 'Method Not Allowed', message: '无状态 MCP 仅接受 POST' });
  });
  // 解析错误不返回原始 body（可能包含凭据）。
  app.use(((error, _req, res, _next) => {
    res.status(error?.status === 413 ? 413 : 400).json({ error: 'Invalid request body' });
  }) as express.ErrorRequestHandler);
  return {
    app,
    close: async () => { await Promise.all([...connections].map((dispose) => dispose())); },
  };
}
