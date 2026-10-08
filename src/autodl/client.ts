import { logger } from '../logger/index.js';
import {
  AutoDLApiResponse,
  RawInstanceSnapshot,
  SafeInstanceSnapshot,
  InstanceListItem,
  InstanceListResult,
  WalletBalance,
} from './types.js';
import {
  AutoDLError,
  AutoDLNonRetryableError,
  AutoDLRetryableError,
  classifyAutoDLError,
} from './errors.js';

export interface AutoDLClientOptions {
  baseUrl: string;
  token: string;
  timeoutMs?: number;
}

export class AutoDLClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly timeoutMs: number;

  constructor(options: AutoDLClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.token = options.token;
    this.timeoutMs = options.timeoutMs ?? 15000;
  }

  /**
   * 通用底层请求处理
   */
  private async request<T>(
    endpoint: string,
    method: 'GET' | 'POST',
    body?: Record<string, unknown>
  ): Promise<T> {
    const url = `${this.baseUrl}${endpoint}`;
    const controller = new AbortController();
    const timeoutTimer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const headers: Record<string, string> = {
        Authorization: this.token,
        'Content-Type': 'application/json',
      };

      const requestInit: RequestInit = {
        method,
        headers,
        signal: controller.signal,
      };

      if (body) {
        requestInit.body = JSON.stringify(body);
      }

      logger.debug({ endpoint, method, body }, '发起 AutoDL API 请求');
      const response = await fetch(url, requestInit);

      // 处理 HTTP 层错误
      if (response.status === 401 || response.status === 403) {
        throw new AutoDLNonRetryableError(`AutoDL 开发者 Token 无效或未授权 (HTTP ${response.status})`, {
          statusCode: response.status,
        });
      }
      if (response.status === 404) {
        throw new AutoDLNonRetryableError(`请求的资源不存在 (HTTP 404)`, {
          statusCode: response.status,
        });
      }
      if (response.status >= 500) {
        throw new AutoDLRetryableError(`AutoDL 服务端内部异常 (HTTP ${response.status})`, {
          statusCode: response.status,
        });
      }

      let resData: AutoDLApiResponse<T>;
      try {
        resData = (await response.json()) as AutoDLApiResponse<T>;
      } catch (err) {
        throw new AutoDLRetryableError(`无法解析 AutoDL 响应为 JSON: ${String(err)}`);
      }

      logger.debug({ endpoint, code: resData.code, msg: resData.msg }, '收到 AutoDL API 响应');

      // 业务层判定：code 必须为 "Success"
      if (resData.code !== 'Success') {
        const errorMsg = resData.msg || `AutoDL API 返回错误代码: ${resData.code}`;
        // 使用分类器自动判断是可重试还是不可重试
        const { classifiedError } = classifyAutoDLError(new Error(errorMsg));
        throw classifiedError;
      }

      return resData.data;
    } catch (err: unknown) {
      if (err instanceof AutoDLError) {
        throw err;
      }
      if (err instanceof Error && err.name === 'AbortError') {
        throw new AutoDLRetryableError(`AutoDL API 请求超时 (${this.timeoutMs}ms)`, { cause: err });
      }
      // 兜底错误分类
      const { classifiedError } = classifyAutoDLError(err);
      throw classifiedError;
    } finally {
      clearTimeout(timeoutTimer);
    }
  }

  /**
   * 实例开机
   * POST /api/v1/dev/instance/pro/power_on
   */
  async powerOn(instanceUuid: string, payload: 'gpu' = 'gpu', startCommand?: string): Promise<void> {
    await this.request('/api/v1/dev/instance/pro/power_on', 'POST', {
      instance_uuid: instanceUuid,
      payload,
      start_command: startCommand,
    });
  }

  /**
   * 实例关机
   * POST /api/v1/dev/instance/pro/power_off
   */
  async powerOff(instanceUuid: string): Promise<void> {
    await this.request('/api/v1/dev/instance/pro/power_off', 'POST', {
      instance_uuid: instanceUuid,
    });
  }

  /**
   * 获取实例状态
   * 官方文档标为 GET /api/v1/dev/instance/pro/status，请求体含 instance_uuid
   */
  async getStatus(instanceUuid: string): Promise<string> {
    try {
      const status = await this.request<string>(
        '/api/v1/dev/instance/pro/status',
        'POST',
        { instance_uuid: instanceUuid }
      );
      return status;
    } catch (err) {
      // 降级使用 GET 尝试
      try {
        return await this.request<string>(
          `/api/v1/dev/instance/pro/status?instance_uuid=${encodeURIComponent(instanceUuid)}`,
          'GET'
        );
      } catch {
        throw err;
      }
    }
  }

  /**
   * 获取实例原始详情（包含敏感字段，供内部调用）
   * /api/v1/dev/instance/pro/snapshot
   */
  async getRawSnapshot(instanceUuid: string): Promise<RawInstanceSnapshot> {
    try {
      return await this.request<RawInstanceSnapshot>(
        '/api/v1/dev/instance/pro/snapshot',
        'POST',
        { instance_uuid: instanceUuid }
      );
    } catch (err) {
      // 降级使用 GET 尝试
      try {
        return await this.request<RawInstanceSnapshot>(
          `/api/v1/dev/instance/pro/snapshot?instance_uuid=${encodeURIComponent(instanceUuid)}`,
          'GET'
        );
      } catch {
        throw err;
      }
    }
  }

  /**
   * 获取安全脱敏的实例详情（已剔除 root_password 和内部私密 token，面向 AI Agent）
   */
  async getSafeSnapshot(instanceUuid: string): Promise<SafeInstanceSnapshot> {
    const raw = await this.getRawSnapshot(instanceUuid);
    const status = await this.getStatus(instanceUuid).catch(() => 'unknown');

    const safe: SafeInstanceSnapshot = {
      instance_uuid: instanceUuid,
      status,
      region: raw.region_sign || 'unknown',
      gpu_name: raw.snapshot_gpu_alias_name || 'unknown',
      payg_price_per_hour_cny: (raw.payg_price ?? 0) / 1000,
      ssh_host: raw.proxy_host,
      ssh_port: raw.ssh_port,
      ssh_user: 'root',
      ssh_connect_command: `ssh -p ${raw.ssh_port} root@${raw.proxy_host}`,
      jupyter_url: raw.jupyter_domain ? `https://${raw.jupyter_domain}` : undefined,
      service_6006_url: raw.service_6006_domain
        ? `${raw.service_6006_port_protocol || 'http'}://${raw.service_6006_domain}`
        : undefined,
      service_6008_url: raw.service_6008_domain
        ? `${raw.service_6008_port_protocol || 'http'}://${raw.service_6008_domain}`
        : undefined,
      usage: raw.usage_info
        ? {
            cpu_usage_percent: raw.usage_info.cpu_usage_percent,
            mem_usage_percent: raw.usage_info.mem_usage_percent,
            root_fs_used_gb: raw.usage_info.root_fs_used_size
              ? +(raw.usage_info.root_fs_used_size / (1024 * 1024 * 1024)).toFixed(2)
              : undefined,
            root_fs_total_gb: raw.usage_info.root_fs_total_size
              ? +(raw.usage_info.root_fs_total_size / (1024 * 1024 * 1024)).toFixed(2)
              : undefined,
          }
        : undefined,
    };

    return safe;
  }

  /**
   * 获取实例列表
   * POST /api/v1/dev/instance/pro/list
   */
  async listInstances(pageIndex = 1, pageSize = 20): Promise<InstanceListResult> {
    return await this.request<InstanceListResult>(
      '/api/v1/dev/instance/pro/list',
      'POST',
      {
        page_index: pageIndex,
        page_size: pageSize,
      }
    );
  }

  /**
   * 查询账户余额
   * POST /api/v1/dev/wallet/balance
   */
  async getBalance(): Promise<WalletBalance> {
    const data = await this.request<{ assets: number; accumulate: number; voucher_balance: number }>(
      '/api/v1/dev/wallet/balance',
      'POST'
    );
    return {
      assets: data.assets,
      assets_cny: +(data.assets / 1000).toFixed(2),
      accumulate: data.accumulate,
      voucher_balance: data.voucher_balance,
      voucher_balance_cny: +(data.voucher_balance / 1000).toFixed(2),
    };
  }
}
