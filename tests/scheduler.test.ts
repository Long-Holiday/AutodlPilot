import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AutoDLRetryableError, AutoDLNonRetryableError, businessError } from '../src/autodl/errors.js';
import { createHarness, deferred, flushWork, success } from './helpers.js';

describe('单次开机与显式持续请求', () => {
  let harness: ReturnType<typeof createHarness>;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    harness = createHarness();
  });
  afterEach(async () => { await harness.close(); vi.useRealTimers(); vi.restoreAllMocks(); });

  it('单次成功只发一个开机请求，不查询状态、不创建后台任务', async () => {
    const result = await harness.scheduler.requestPowerOn('pro-once');
    expect(result).toMatchObject({ status: 'accepted', request_id: 'request-test' });
    expect(harness.client.powerOn).toHaveBeenCalledOnce();
    expect(harness.client.getStatus).not.toHaveBeenCalled();
    expect(harness.store.getLatestTaskByInstance('pro-once')).toBeNull();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(harness.client.powerOn).toHaveBeenCalledOnce();
  });

  it('单次资源不足返回真实失败，不自动持续开机', async () => {
    vi.mocked(harness.client.powerOn).mockRejectedValue(businessError('ResourceUnavailable', 'GPU资源不足', 'r2'));
    const result = await harness.scheduler.requestPowerOn('pro-scarce');
    expect(result).toMatchObject({ status: 'gpu_unavailable', retryable: true, code: 'ResourceUnavailable', request_id: 'r2' });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(harness.client.powerOn).toHaveBeenCalledOnce();
    expect(harness.store.getLatestTaskByInstance('pro-scarce')).toBeNull();
  });

  it('显式持续请求经历资源不足后成功；接受开机后只轮询', async () => {
    vi.mocked(harness.client.powerOn)
      .mockRejectedValueOnce(businessError('NoResource', 'GPU资源不足'))
      .mockResolvedValue(success);
    const result = harness.scheduler.requestPowerOnRetry('pro-retry');
    expect(result.task.status).toBe('PENDING');
    await flushWork();
    expect(harness.store.getTaskById(result.task.task_id)).toMatchObject({ status: 'RETRYING', retry_count: 1 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(harness.store.getTaskById(result.task.task_id)).toMatchObject({ phase: 'OBSERVE', retry_count: 2 });
    vi.mocked(harness.client.getStatus).mockResolvedValue('running');
    await vi.advanceTimersByTimeAsync(1000);
    expect(harness.scheduler.getLatestTaskByInstance('pro-retry')).toMatchObject({ status: 'SUCCESS', retry_count: 2, next_retry_at: null, last_error: null });
    expect(harness.client.powerOn).toHaveBeenCalledTimes(2);
  });

  it('已 running 的持续任务直接完成，不发开机', async () => {
    vi.mocked(harness.client.getStatus).mockResolvedValue('running');
    const { task } = harness.scheduler.requestPowerOnRetry('pro-running');
    await flushWork();
    expect(harness.store.getTaskById(task.task_id)?.status).toBe('SUCCESS');
    expect(harness.client.powerOn).not.toHaveBeenCalled();
  });

  it('永久错误立即停止，终态不能再被取消覆盖', async () => {
    vi.mocked(harness.client.powerOn).mockRejectedValue(new AutoDLNonRetryableError('无权限'));
    const { task } = harness.scheduler.requestPowerOnRetry('pro-denied');
    await flushWork();
    expect(harness.store.getTaskById(task.task_id)?.status).toBe('FAILED');
    expect(harness.scheduler.cancelTask(task.task_id)).toBe(false);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(harness.client.powerOn).toHaveBeenCalledOnce();
  });

  it('状态查询临时失败只能重查状态；永久错误不无限吞掉', async () => {
    vi.mocked(harness.client.getStatus)
      .mockRejectedValueOnce(new AutoDLRetryableError('HTTP 503'))
      .mockRejectedValue(new AutoDLNonRetryableError('token 无效'));
    const { task } = harness.scheduler.requestPowerOnRetry('pro-status');
    await flushWork();
    expect(harness.client.powerOn).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(harness.store.getTaskById(task.task_id)?.status).toBe('FAILED');
  });

  it('开机网络结果不确定时仅核实状态，不在 stopped 上盲目重发', async () => {
    vi.mocked(harness.client.powerOn).mockRejectedValue(new AutoDLRetryableError('timeout', { uncertain: true }));
    const { task } = harness.scheduler.requestPowerOnRetry('pro-uncertain');
    await flushWork();
    expect(harness.store.getTaskById(task.task_id)?.phase).toBe('VERIFY');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(harness.client.powerOn).toHaveBeenCalledOnce();
    expect(harness.store.getTaskById(task.task_id)?.status).toBe('FAILED');
  });

  it('未知或启动中的状态仅轮询，不把它猜成已停止', async () => {
    vi.mocked(harness.client.getStatus).mockResolvedValue('provider_future_starting');
    const { task } = harness.scheduler.requestPowerOnRetry('pro-unknown');
    await vi.advanceTimersByTimeAsync(3000);
    expect(harness.client.powerOn).not.toHaveBeenCalled();
    expect(harness.store.getTaskById(task.task_id)?.last_error).toContain('provider_future_starting');
    vi.mocked(harness.client.getStatus).mockResolvedValue('running');
    await vi.advanceTimersByTimeAsync(1000);
    expect(harness.store.getTaskById(task.task_id)?.status).toBe('SUCCESS');
  });

  it('退避等待跨越截止时间也不会再发一次请求', async () => {
    await harness.close();
    harness = createHarness({ maxDurationMinutes: 0.005, initialIntervalSec: 1 });
    vi.mocked(harness.client.powerOn).mockRejectedValue(businessError('Resource', 'GPU资源不足'));
    const { task } = harness.scheduler.requestPowerOnRetry('pro-deadline');
    await flushWork();
    await vi.advanceTimersByTimeAsync(5000);
    expect(harness.client.powerOn).toHaveBeenCalledOnce();
    expect(harness.store.getTaskById(task.task_id)).toMatchObject({ status: 'TIMEOUT', next_retry_at: null });
  });

  it('状态请求过截止时间才返回 running 也不能成功或发开机', async () => {
    await harness.close();
    harness = createHarness({ maxDurationMinutes: 0.005 });
    const gate = deferred<string>();
    vi.mocked(harness.client.getStatus).mockReturnValue(gate.promise);
    const { task } = harness.scheduler.requestPowerOnRetry('pro-late-deadline');
    await flushWork();
    await vi.advanceTimersByTimeAsync(500);
    gate.resolve('running');
    await flushWork();
    expect(harness.store.getTaskById(task.task_id)?.status).toBe('TIMEOUT');
    expect(harness.client.powerOn).not.toHaveBeenCalled();
  });

  it('退避增加但不超过配置最大间隔，计数包含每次实际开机尝试', async () => {
    vi.mocked(harness.client.powerOn).mockRejectedValue(businessError('Resource', 'GPU资源不足'));
    const { task } = harness.scheduler.requestPowerOnRetry('pro-backoff');
    await flushWork();
    for (const delay of [1000, 2000, 4000, 5000]) {
      expect(harness.store.getTaskById(task.task_id)!.next_retry_at! - Date.now()).toBe(delay);
      await vi.advanceTimersByTimeAsync(delay);
    }
    expect(harness.store.getTaskById(task.task_id)?.retry_count).toBe(5);
  });

  it('取消只取消持续请求，不自动关机', async () => {
    const { task } = harness.scheduler.requestPowerOnRetry('pro-cancel');
    expect(harness.scheduler.cancelTask(task.task_id)).toBe(true);
    await flushWork();
    expect(harness.store.getTaskById(task.task_id)?.status).toBe('CANCELLED');
    expect(harness.client.powerOn).not.toHaveBeenCalled();
    expect(harness.client.powerOff).not.toHaveBeenCalled();
  });
});
