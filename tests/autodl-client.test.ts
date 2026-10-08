import { describe, it, expect, vi } from 'vitest';
import { AutoDLClient } from '../src/autodl/client.js';
import {
  classifyAutoDLError,
  AutoDLRetryableError,
  AutoDLNonRetryableError,
} from '../src/autodl/errors.js';

describe('AutoDL 错误分类器 (classifyAutoDLError)', () => {
  it('应准确将 GPU 资源不足识别为可重试错误', () => {
    const err = new Error('当前地区 GPU 资源不足，无法创建或启动机器');
    const { isRetryable, classifiedError } = classifyAutoDLError(err);
    expect(isRetryable).toBe(true);
    expect(classifiedError).toBeInstanceOf(AutoDLRetryableError);
  });

  it('应准确将无可用机器/排队中识别为可重试错误', () => {
    const err = new Error('No GPU available, please retry later');
    const { isRetryable } = classifyAutoDLError(err);
    expect(isRetryable).toBe(true);
  });

  it('应准确将网络超时/连接重置识别为可重试错误', () => {
    const err = new Error('fetch failed: connect ETIMEDOUT');
    const { isRetryable } = classifyAutoDLError(err);
    expect(isRetryable).toBe(true);
  });

  it('应准确将 Token 鉴权失败识别为不可重试错误 (Immediate Fail)', () => {
    const err = new Error('Token 无效或认证失败');
    const { isRetryable, classifiedError } = classifyAutoDLError(err);
    expect(isRetryable).toBe(false);
    expect(classifiedError).toBeInstanceOf(AutoDLNonRetryableError);
  });

  it('应准确将实例不存在识别为不可重试错误', () => {
    const err = new Error('Instance not found: pro-xxxx 不存在');
    const { isRetryable, classifiedError } = classifyAutoDLError(err);
    expect(isRetryable).toBe(false);
    expect(classifiedError).toBeInstanceOf(AutoDLNonRetryableError);
  });

  it('应准确将账户欠费/余额不足识别为不可重试错误', () => {
    const err = new Error('账户余额不足，请充值后重试');
    const { isRetryable, classifiedError } = classifyAutoDLError(err);
    expect(isRetryable).toBe(false);
    expect(classifiedError).toBeInstanceOf(AutoDLNonRetryableError);
  });
});

describe('AutoDLClient 安全脱敏 (getSafeSnapshot)', () => {
  it('必须过滤掉 root_password 等所有敏感凭证', async () => {
    const client = new AutoDLClient({
      baseUrl: 'https://api.autodl.com',
      token: 'fake_token',
    });

    // Mock 原始 snapshot 返回
    vi.spyOn(client, 'getRawSnapshot').mockResolvedValue({
      region_sign: 'neimeng-C',
      payg_price: 1800,
      origin_pay_price: 2500,
      snapshot_gpu_alias_name: 'RTX 4090',
      chip_corp: 'nvidia',
      cpu_arch: 'x86',
      proxy_host: 'connect.westb.autodl.com',
      ssh_port: 39999,
      root_password: 'SUPER_SECRET_PASSWORD_123456', // 敏感密码
      jupyter_domain: 'jupyter.autodl.com',
      jupyter_token: 'secret_jupyter_token',
    });

    vi.spyOn(client, 'getStatus').mockResolvedValue('running');

    const safe = await client.getSafeSnapshot('pro-123456');

    // 严密验证：safeSnapshot 对象中不应存在 root_password
    expect((safe as any).root_password).toBeUndefined();
    expect(JSON.stringify(safe)).not.toContain('SUPER_SECRET_PASSWORD_123456');

    // 验证安全连接信息正确生成
    expect(safe.ssh_host).toBe('connect.westb.autodl.com');
    expect(safe.ssh_port).toBe(39999);
    expect(safe.ssh_user).toBe('root');
    expect(safe.ssh_connect_command).toBe('ssh -p 39999 root@connect.westb.autodl.com');
    expect(safe.payg_price_per_hour_cny).toBe(1.8);
    expect(safe.status).toBe('running');
  });
});
