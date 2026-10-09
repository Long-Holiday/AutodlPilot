import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createHttpApp } from '../src/mcp/app.js';
import { businessError } from '../src/autodl/errors.js';
import { createHarness, closeServer, flushWork, listen } from './helpers.js';

describe('真实 MCP Streamable HTTP 协议', () => {
  let harness: ReturnType<typeof createHarness>;
  let server: http.Server;
  let origin: string;
  let httpApp: ReturnType<typeof createHttpApp>;
  let clients: Client[];

  beforeEach(async () => {
    harness = createHarness();
    httpApp = createHttpApp({ client: harness.client, scheduler: harness.scheduler, authToken: 'fake-mcp-token', allowedOrigins: ['https://agent.example.com'] });
    server = http.createServer(httpApp.app);
    origin = await listen(server);
    clients = [];
  });
  afterEach(async () => {
    await Promise.all(clients.map((client) => client.close()));
    await harness.close();
    await httpApp.close();
    await closeServer(server);
    vi.restoreAllMocks();
  });

  async function connect() {
    const client = new Client({ name: 'test-local-agent', version: '1.0.0' });
    clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
      requestInit: { headers: { Authorization: 'Bearer fake-mcp-token' } },
    }));
    return client;
  }

  it('initialize/listTools 只公开六个目标工具，并正确标注参数 schema', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      'cancel_power_on_task', 'get_instance_info', 'get_power_on_task_status',
      'power_off_instance', 'power_on_instance', 'retry_power_on_instance',
    ]);
    expect(tools.every((tool) => tool.inputSchema.additionalProperties === false)).toBe(true);
    expect(JSON.stringify(tools)).not.toContain('start_command');
    expect(tools.find((tool) => tool.name === 'get_power_on_task_status')?.inputSchema.oneOf).toHaveLength(2);
  });

  it('callTool 单次资源不足是明确工具失败，不自动生成任务', async () => {
    vi.mocked(harness.client.powerOn).mockRejectedValue(businessError('NoGPU', 'GPU资源不足', 'r-mcp'));
    const client = await connect();
    const result = await client.callTool({ name: 'power_on_instance', arguments: { instance_uuid: 'pro-protocol' } });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ status: 'gpu_unavailable', code: 'NoGPU', request_id: 'r-mcp', retryable: true });
    expect(harness.store.getLatestTaskByInstance('pro-protocol')).toBeNull();
  });

  it('客户端断开不取消任务，新客户端可查询及取消', async () => {
    const first = await connect();
    const result = await first.callTool({ name: 'retry_power_on_instance', arguments: { instance_uuid: 'pro-disconnect' } });
    const task = (result.structuredContent as { task: { task_id: string } }).task;
    await first.close();
    await flushWork();
    const second = await connect();
    const query = await second.callTool({ name: 'get_power_on_task_status', arguments: { instance_uuid: 'pro-disconnect' } });
    expect(query.structuredContent).toMatchObject({ task: { task_id: task.task_id } });
    const cancel = await second.callTool({ name: 'cancel_power_on_task', arguments: { task_id: task.task_id } });
    expect(cancel.structuredContent).toMatchObject({ cancelled: true });
    expect(harness.store.getTaskById(task.task_id)?.status).toBe('CANCELLED');
  });

  it('两个客户端并发调用、重连后仍可初始化，不共享损坏的会话', async () => {
    const [first, second] = await Promise.all([connect(), connect()]);
    const results = await Promise.all([first, second].map((client) => client.callTool({ name: 'get_instance_info', arguments: { instance_uuid: 'pro-query' } })));
    expect(results.every((result) => !result.isError)).toBe(true);
    await first.close();
    const third = await connect();
    expect((await third.listTools()).tools).toHaveLength(6);
  });

  it.each([
    { name: 'power_on_instance', arguments: { instance_uuid: 123 } },
    { name: 'power_on_instance', arguments: { instance_uuid: '' } },
    { name: 'power_on_instance', arguments: { instance_uuid: 'pro-okay', start_command: 'must-not-run' } },
    { name: 'get_instance_info', arguments: { instance_uuid: 'pro-okay', include_connection: 'yes' } },
    { name: 'get_power_on_task_status', arguments: {} },
    { name: 'get_power_on_task_status', arguments: { task_id: 'task_one', instance_uuid: 'pro-one' } },
  ])('拒绝非法参数 $name/$arguments', async (request) => {
    const client = await connect();
    await expect(client.callTool(request)).rejects.toThrow();
    expect(harness.client.powerOn).not.toHaveBeenCalled();
  });

  it('移除的工具不能调用，关机通过协调器执行', async () => {
    const client = await connect();
    await expect(client.callTool({ name: 'register_experiment', arguments: {} })).rejects.toThrow('未知工具');
    const result = await client.callTool({ name: 'power_off_instance', arguments: { instance_uuid: 'pro-off' } });
    expect(result.structuredContent).toMatchObject({ status: 'accepted' });
    expect(harness.client.powerOff).toHaveBeenCalledOnce();
  });

  it('无鉴权、错误 token 和 query token 均拒绝，不暴露 API 状态', async () => {
    for (const [path, headers] of [
      ['/mcp', {}], ['/mcp', { Authorization: 'Bearer wrong' }],
      ['/mcp?token=fake-mcp-token', {}],
    ] as [string, Record<string, string>][]) {
      const response = await fetch(`${origin}${path}`, { method: 'POST', headers });
      expect(response.status).toBe(401);
      expect(response.headers.get('www-authenticate')).toBe('Bearer');
    }
    expect((await fetch(`${origin}/api/status`)).status).toBe(404);
    expect((await fetch(`${origin}/health`)).status).toBe(200);
  });

  it('有 Origin 时必须在白名单，合法非浏览器调用无需 Origin', async () => {
    for (const value of ['https://evil.example', 'null']) {
      const response = await fetch(`${origin}/mcp`, { headers: { Authorization: 'Bearer fake-mcp-token', Origin: value } });
      expect(response.status).toBe(403);
    }
    const response = await fetch(`${origin}/mcp`, { headers: { Authorization: 'Bearer fake-mcp-token', Origin: 'https://agent.example.com' } });
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('POST');
  });

  it('GET/DELETE 为无状态模式返回 405；非法 JSON 不回显请求内容', async () => {
    for (const method of ['GET', 'DELETE']) {
      expect((await fetch(`${origin}/mcp`, { method, headers: { Authorization: 'Bearer fake-mcp-token' } })).status).toBe(405);
    }
    const response = await fetch(`${origin}/mcp`, { method: 'POST', headers: { Authorization: 'Bearer fake-mcp-token', 'Content-Type': 'application/json' }, body: 'secret-invalid-json' });
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain('secret-invalid-json');
  });
});
