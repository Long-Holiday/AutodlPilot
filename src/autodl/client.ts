import http from 'node:http';
import https from 'node:https';
import { z } from 'zod';
import { AutoDLApiResponse, InstanceApi, SafeInstanceSnapshot } from './types.js';
import { AutoDLError, AutoDLNonRetryableError, AutoDLRetryableError, businessError } from './errors.js';

export interface AutoDLClientOptions {
  baseUrl: string;
  token: string;
  timeoutMs?: number;
}

const envelopeSchema = z.object({
  code: z.string().min(1),
  msg: z.string(),
  data: z.unknown(),
  request_id: z.string().optional(),
});
const connectionSchema = z.object({
  proxy_host: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9.-]*$/).max(253),
  ssh_port: z.number().int().min(1).max(65535),
});
const networkCodes = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND', 'EPIPE']);

export class AutoDLClient implements InstanceApi {
  private readonly baseUrl: URL;
  private readonly token: string;
  private readonly timeoutMs: number;

  constructor(options: AutoDLClientOptions) {
    this.baseUrl = new URL(options.baseUrl);
    if (!['https:', 'http:'].includes(this.baseUrl.protocol) || this.baseUrl.username || this.baseUrl.password) {
      throw new Error('AUTODL_BASE_URL 必须是无凭据的 HTTP(S) 地址');
    }
    this.token = options.token;
    this.timeoutMs = options.timeoutMs ?? 15000;
  }

  // AutoDL 文档的 GET 需要 JSON body，不能使用原生 fetch 的 GET。
  private async request<T>(
    endpoint: string,
    method: 'GET' | 'POST',
    body: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<AutoDLApiResponse<T>> {
    if (signal?.aborted) {
      throw new AutoDLNonRetryableError('AutoDL 请求在发送前已取消', { kind: 'cancelled' });
    }
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const mutating = method === 'POST';
    const data = JSON.stringify(body);
    const url = new URL(`/api/v1/dev/instance/pro/${endpoint}`, this.baseUrl);

    try {
      const response = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const transport = url.protocol === 'https:' ? https : http;
        const req = transport.request(url, {
          method,
          signal: requestSignal,
          headers: {
            Authorization: this.token,
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(data),
            Accept: 'application/json',
          },
        }, (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          res.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > 1024 * 1024) {
              const error = new AutoDLNonRetryableError('AutoDL 响应超过 1 MiB', {
                kind: 'invalid_response', uncertain: mutating,
              });
              res.destroy(error);
              req.destroy(error);
              reject(error);
              return;
            }
            chunks.push(chunk);
          });
          res.on('end', () => resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
          }));
          res.on('error', reject);
        });
        req.on('error', reject);
        req.end(data);
      });

      let json: unknown;
      try { json = JSON.parse(response.body); } catch { /* HTTP 错误可能不是 JSON。 */ }
      const parsed = envelopeSchema.safeParse(json);
      if (response.status < 200 || response.status >= 300) {
        const options = {
          statusCode: response.status,
          code: parsed.success ? parsed.data.code : undefined,
          requestId: parsed.success ? parsed.data.request_id : undefined,
          uncertain: mutating && (response.status >= 500 || response.status === 408),
        };
        const message = parsed.success && parsed.data.msg
          ? parsed.data.msg : `AutoDL HTTP ${response.status}`;
        if (response.status === 429 || response.status === 408 || response.status >= 500) {
          throw new AutoDLRetryableError(message, options);
        }
        throw new AutoDLNonRetryableError(message, options);
      }
      if (!parsed.success || !Object.prototype.hasOwnProperty.call(json, 'data')) {
        throw new AutoDLNonRetryableError('AutoDL 响应不符合 API 信封格式', {
          kind: 'invalid_response', uncertain: mutating,
        });
      }
      if (parsed.data.code !== 'Success') {
        throw businessError(parsed.data.code, parsed.data.msg, parsed.data.request_id);
      }
      return parsed.data as AutoDLApiResponse<T>;
    } catch (error) {
      if (signal?.aborted) {
        throw new AutoDLNonRetryableError('AutoDL 请求已取消；已送达的指令无法撤回', {
          kind: 'cancelled', uncertain: mutating,
        });
      }
      if (error instanceof AutoDLError) throw error;
      if (timeout.aborted) {
        throw new AutoDLRetryableError(`AutoDL 请求超时 (${this.timeoutMs}ms)`, {
          uncertain: mutating,
        });
      }
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code && networkCodes.has(code)) {
        throw new AutoDLRetryableError(`AutoDL 网络连接失败 (${code})`, {
          uncertain: mutating,
        });
      }
      // 不传递底层请求对象，避免其 headers 将 token 带入日志或工具结果。
      throw new AutoDLNonRetryableError('AutoDL 请求失败', { kind: 'unknown', uncertain: mutating });
    }
  }

  async powerOn(instanceUuid: string, signal?: AbortSignal): Promise<AutoDLApiResponse<null>> {
    return this.request('power_on', 'POST', { instance_uuid: instanceUuid, payload: 'gpu' }, signal);
  }

  async powerOff(instanceUuid: string, signal?: AbortSignal): Promise<AutoDLApiResponse<null>> {
    return this.request('power_off', 'POST', { instance_uuid: instanceUuid }, signal);
  }

  async getStatus(instanceUuid: string, signal?: AbortSignal): Promise<string> {
    const response = await this.request<unknown>('status', 'GET', { instance_uuid: instanceUuid }, signal);
    if (typeof response.data !== 'string' || !response.data.trim()) {
      throw new AutoDLNonRetryableError('AutoDL 状态不是非空字符串', {
        kind: 'invalid_response', code: response.code, requestId: response.request_id,
      });
    }
    return response.data;
  }

  async getSafeSnapshot(instanceUuid: string, includeConnection = false, signal?: AbortSignal): Promise<SafeInstanceSnapshot> {
    const status = await this.getStatus(instanceUuid, signal);
    const safe: SafeInstanceSnapshot = { instance_uuid: instanceUuid, status };
    if (!includeConnection) return safe;
    try {
      const response = await this.request<unknown>('snapshot', 'GET', { instance_uuid: instanceUuid }, signal);
      const connection = connectionSchema.safeParse(response.data);
      if (!connection.success) {
        safe.connection_warning = '实例详情暂未提供有效的 SSH host/port';
      } else {
        safe.ssh_host = connection.data.proxy_host;
        safe.ssh_port = connection.data.ssh_port;
        safe.ssh_user = 'root';
      }
    } catch (error) {
      if (signal?.aborted) throw error;
      safe.connection_warning = '状态查询成功，但 SSH 连接详情暂不可用';
    }
    return safe;
  }
}
