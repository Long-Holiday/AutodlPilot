import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import http, { IncomingMessage, ServerResponse } from 'node:http';
import { AutoDLClient } from '../src/autodl/client.js';
import { businessError, classifyAutoDLError } from '../src/autodl/errors.js';
import { closeServer, listen, success } from './helpers.js';

describe('AutoDL 官方 HTTP 契约', () => {
  let server: http.Server;
  let client: AutoDLClient;
  let respond: (res: ServerResponse, path: string) => void;
  let calls: { method?: string; path?: string; authorization?: string; body: unknown }[];

  beforeEach(async () => {
    calls = [];
    respond = (res) => res.end(JSON.stringify(success));
    server = http.createServer(async (req: IncomingMessage, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      calls.push({ method: req.method, path: req.url, authorization: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString()) });
      respond(res, req.url!);
    });
    client = new AutoDLClient({ baseUrl: await listen(server), token: 'fake-raw-token', timeoutMs: 100 });
  });
  afterEach(async () => { await closeServer(server); });

  it('开机/关机使用 POST JSON 和原始 Authorization，保留 request_id', async () => {
    expect(await client.powerOn('pro-example')).toEqual(success);
    await client.powerOff('pro-example');
    expect(calls).toEqual([
      { method: 'POST', path: '/api/v1/dev/instance/pro/power_on', authorization: 'fake-raw-token', body: { instance_uuid: 'pro-example', payload: 'gpu' } },
      { method: 'POST', path: '/api/v1/dev/instance/pro/power_off', authorization: 'fake-raw-token', body: { instance_uuid: 'pro-example' } },
    ]);
  });

  it('状态使用 GET JSON body，不发送 query 或 fallback，保留未知状态', async () => {
    respond = (res) => res.end(JSON.stringify({ ...success, data: 'future_provider_status' }));
    expect(await client.getStatus('pro-example')).toBe('future_provider_status');
    expect(calls).toEqual([{ method: 'GET', path: '/api/v1/dev/instance/pro/status', authorization: 'fake-raw-token', body: { instance_uuid: 'pro-example' } }]);
  });

  it('SSH 详情仅白名单投影，忽略所有密码和其他 token', async () => {
    respond = (res, path) => res.end(JSON.stringify({ ...success, data: path.endsWith('/status') ? 'running' : {
      proxy_host: 'connect.example.autodl.com', ssh_port: 34222,
      root_password: 'password-secret', jupyter_token: 'jupyter-secret', future_secret: 'future-secret',
      ssh_command: 'arbitrary-untrusted-shell',
    } }));
    const info = await client.getSafeSnapshot('pro-example', true);
    expect(info).toEqual({ instance_uuid: 'pro-example', status: 'running', ssh_host: 'connect.example.autodl.com', ssh_port: 34222, ssh_user: 'root' });
    expect(calls[1].method).toBe('GET');
    expect(calls[1].body).toEqual({ instance_uuid: 'pro-example' });
    expect(JSON.stringify(info)).not.toMatch(/secret|password|shell/);
  });

  it('默认仅查状态，详情失败不会掩盖成功的状态', async () => {
    respond = (res, path) => {
      if (path.endsWith('/snapshot')) { res.statusCode = 503; res.end('unavailable'); }
      else res.end(JSON.stringify({ ...success, data: 'running' }));
    };
    expect(await client.getSafeSnapshot('pro-example')).toEqual({ instance_uuid: 'pro-example', status: 'running' });
    expect(calls).toHaveLength(1);
    expect(await client.getSafeSnapshot('pro-example', true)).toMatchObject({ status: 'running', connection_warning: expect.any(String) });
  });

  it('拒绝无效 SSH 字段而不是拼接服务器返回的命令', async () => {
    respond = (res, path) => res.end(JSON.stringify({ ...success, data: path.endsWith('/status') ? 'running' : { proxy_host: '-oProxyCommand=bad', ssh_port: '34222' } }));
    const info = await client.getSafeSnapshot('pro-example', true);
    expect(info.ssh_host).toBeUndefined();
    expect(info.connection_warning).toBeDefined();
  });

  it('GPU 不足保留真实 code/msg/request_id，并且只请求一次', async () => {
    respond = (res) => res.end(JSON.stringify({ code: 'ProviderResourceCode', data: null, msg: '当前 GPU 资源不足', request_id: 'r-original' }));
    await expect(client.powerOn('pro-example')).rejects.toMatchObject({ code: 'ProviderResourceCode', requestId: 'r-original', kind: 'gpu_unavailable', isRetryable: true, uncertain: false });
    expect(calls).toHaveLength(1);
  });

  it.each([400, 401, 403, 404, 405])('HTTP %i 不重试且不 fallback', async (status) => {
    respond = (res) => { res.statusCode = status; res.end('error'); };
    await expect(client.getStatus('pro-example')).rejects.toMatchObject({ statusCode: status, isRetryable: false });
    expect(calls).toHaveLength(1);
  });

  it.each([429, 500, 503])('HTTP %i 为暂时故障，但不能当作 GPU 不足', async (status) => {
    respond = (res) => { res.statusCode = status; res.end('temporary'); };
    await expect(client.powerOn('pro-example')).rejects.toMatchObject({ statusCode: status, kind: 'transient', isRetryable: true, uncertain: status >= 500 });
    expect(calls).toHaveLength(1);
  });

  it.each(['not-json', '{}', '{"code":"Success","msg":""}', '{"code":0,"data":null,"msg":""}'])('拒绝非法响应 %s', async (body) => {
    respond = (res) => res.end(body);
    await expect(client.powerOn('pro-example')).rejects.toMatchObject({ kind: 'invalid_response', isRetryable: false, uncertain: true });
  });

  it('状态 data 必须是非空字符串', async () => {
    await expect(client.getStatus('pro-example')).rejects.toMatchObject({ kind: 'invalid_response' });
  });

  it('超时有界并标记开机结果不确定，不隐式重发', async () => {
    respond = () => {};
    await expect(client.powerOn('pro-example')).rejects.toMatchObject({ kind: 'transient', isRetryable: true, uncertain: true });
    expect(calls).toHaveLength(1);
  });

  it('外部取消中断在途请求', async () => {
    respond = () => {};
    const controller = new AbortController();
    const request = client.powerOn('pro-example', controller.signal);
    const rejection = expect(request).rejects.toMatchObject({ kind: 'cancelled', uncertain: true });
    controller.abort();
    await rejection;
  });

  it('发送前已取消的请求不发出任何 API 操作', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(client.powerOn('pro-example', controller.signal)).rejects.toMatchObject({ kind: 'cancelled', uncertain: false });
    expect(calls).toHaveLength(0);
  });

  it('限制响应大小，不输出原始响应或 token', async () => {
    respond = (res) => res.end('x'.repeat(1024 * 1024 + 1));
    await expect(client.getStatus('pro-example')).rejects.toMatchObject({ kind: 'invalid_response' });
  });
});

describe('保守错误分类', () => {
  it.each(['GPU 驱动参数错误', 'GPU driver crashed', 'custom opaque failure', 'authorization service temporary issue'])('不因宽泛关键词将 %s 判为资源不足', (message) => {
    const error = businessError('UnpublishedCode', message, 'r1');
    expect(error.isRetryable).toBe(false);
    expect(error.code).toBe('UnpublishedCode');
    expect(error.requestId).toBe('r1');
  });
  it.each(['GPU资源不足', 'No GPU available, please retry later', '当前容量已满', '没有空闲的 GPU'])('明确资源不足文案 %s 可重试', (message) => {
    expect(businessError('UnknownResourceCode', message)).toMatchObject({ kind: 'gpu_unavailable', isRetryable: true });
  });
  it('未知 JS 异常不默认重试', () => {
    expect(classifyAutoDLError(new Error('opaque failure')).isRetryable).toBe(false);
  });
});
