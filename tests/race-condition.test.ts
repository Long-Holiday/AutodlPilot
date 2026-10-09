import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { businessError } from '../src/autodl/errors.js';
import { InstanceMutex } from '../src/scheduler/mutex.js';
import { createHarness, deferred, flushWork, success } from './helpers.js';

describe('真正的并发与迟到响应', () => {
  let harness: ReturnType<typeof createHarness>;
  beforeEach(() => { vi.useFakeTimers(); harness = createHarness(); });
  afterEach(async () => { await harness.close(); vi.useRealTimers(); vi.restoreAllMocks(); });

  it('同时发起两次初次开机，只能有一次 API 请求', async () => {
    const gate = deferred<typeof success>();
    vi.mocked(harness.client.powerOn).mockReturnValue(gate.promise);
    const first = harness.scheduler.requestPowerOn('pro-concurrent');
    const second = harness.scheduler.requestPowerOn('pro-concurrent');
    expect(await second).toMatchObject({ status: 'busy' });
    expect(harness.client.powerOn).toHaveBeenCalledOnce();
    gate.resolve(success);
    expect(await first).toMatchObject({ status: 'accepted' });
  });

  it('持续请求同步保留唯一任务，重复调用不创建新 worker', async () => {
    const results = await Promise.all(Array.from({ length: 10 }, () => Promise.resolve(harness.scheduler.requestPowerOnRetry('pro-idempotent'))));
    expect(new Set(results.map((result) => result.task.task_id)).size).toBe(1);
    await flushWork();
    expect(harness.client.powerOn).toHaveBeenCalledOnce();
    expect(await harness.scheduler.requestPowerOn('pro-idempotent')).toMatchObject({ status: 'retrying' });
    expect(harness.client.powerOn).toHaveBeenCalledOnce();
  });

  it('取消时迟到 running 响应不能把 CANCELLED 覆盖成 SUCCESS', async () => {
    const gate = deferred<string>();
    vi.mocked(harness.client.getStatus).mockReturnValue(gate.promise);
    const { task } = harness.scheduler.requestPowerOnRetry('pro-late-status');
    await flushWork();
    const signal = vi.mocked(harness.client.getStatus).mock.calls[0][1]!;
    expect(harness.scheduler.cancelTask(task.task_id)).toBe(true);
    expect(signal.aborted).toBe(true);
    expect(() => harness.scheduler.requestPowerOnRetry('pro-late-status')).toThrow('在途操作');
    gate.resolve('running');
    await flushWork();
    expect(harness.store.getTaskById(task.task_id)?.status).toBe('CANCELLED');
    const next = harness.scheduler.requestPowerOnRetry('pro-late-status');
    await flushWork();
    expect(next.task.task_id).not.toBe(task.task_id);
    expect(harness.store.getTaskById(next.task.task_id)?.status).toBe('SUCCESS');
  });

  it('取消后迟到资源不足错误不能把 CANCELLED 覆盖成 RETRYING', async () => {
    const gate = deferred<typeof success>();
    vi.mocked(harness.client.powerOn).mockReturnValue(gate.promise);
    const { task } = harness.scheduler.requestPowerOnRetry('pro-late-failure');
    await flushWork();
    expect(harness.scheduler.cancelTask(task.task_id)).toBe(true);
    gate.reject(businessError('Resource', 'GPU资源不足'));
    await flushWork();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(harness.store.getTaskById(task.task_id)?.status).toBe('CANCELLED');
    expect(harness.client.powerOn).toHaveBeenCalledOnce();
  });

  it('关机等待在途初次开机结束，并阻止等待期间的新开机', async () => {
    const gate = deferred<typeof success>();
    vi.mocked(harness.client.powerOn).mockReturnValue(gate.promise);
    const on = harness.scheduler.requestPowerOn('pro-race');
    const off = harness.scheduler.powerOff('pro-race');
    await flushWork();
    expect(harness.client.powerOff).not.toHaveBeenCalled();
    expect(vi.mocked(harness.client.powerOn).mock.calls[0][1]?.aborted).toBe(true);
    await expect(harness.scheduler.requestPowerOn('pro-race')).rejects.toThrow('关机');
    gate.resolve(success);
    expect(await on).toMatchObject({ status: 'failed', outcome_uncertain: true });
    expect(await off).toMatchObject({ status: 'accepted', cancelled_retry_tasks_count: 0 });
    expect(harness.client.powerOff).toHaveBeenCalledOnce();
    expect(harness.store.getLatestTaskByInstance('pro-race')).toBeNull();
  });

  it('关机取消在途持续开机，迟到成功不产生下一次开机', async () => {
    const gate = deferred<typeof success>();
    vi.mocked(harness.client.powerOn).mockReturnValue(gate.promise);
    const { task } = harness.scheduler.requestPowerOnRetry('pro-retry-race');
    await flushWork();
    const off = harness.scheduler.powerOff('pro-retry-race');
    expect(harness.store.getTaskById(task.task_id)?.status).toBe('CANCELLED');
    await flushWork();
    expect(harness.client.powerOff).not.toHaveBeenCalled();
    gate.resolve(success);
    expect(await off).toMatchObject({ cancelled_retry_tasks_count: 1 });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(harness.store.getTaskById(task.task_id)?.status).toBe('CANCELLED');
    expect(harness.client.powerOn).toHaveBeenCalledOnce();
  });

  it('并发关机调用共用一个请求', async () => {
    const gate = deferred<typeof success>();
    vi.mocked(harness.client.powerOff).mockReturnValue(gate.promise);
    const first = harness.scheduler.powerOff('pro-off');
    const second = harness.scheduler.powerOff('pro-off');
    expect(first).toBe(second);
    await flushWork();
    expect(harness.client.powerOff).toHaveBeenCalledOnce();
    gate.resolve(success);
    await first;
  });

  it('服务关闭排空在途工作，然后才允许关闭数据库', async () => {
    const gate = deferred<typeof success>();
    vi.mocked(harness.client.powerOn).mockReturnValue(gate.promise);
    const request = harness.scheduler.requestPowerOn('pro-drain');
    let drained = false;
    const shutdown = harness.scheduler.shutdown().then(() => { drained = true; });
    await flushWork();
    expect(drained).toBe(false);
    await expect(harness.scheduler.requestPowerOn('pro-no-new')).rejects.toThrow('停止');
    gate.resolve(success);
    await request;
    await shutdown;
    expect(drained).toBe(true);
  });
});

describe('锁所有权', () => {
  it('abort 不释放；旧 owner 无权释放新锁', () => {
    const mutex = new InstanceMutex();
    const old = mutex.acquire('pro-lock')!;
    mutex.abort('pro-lock', 'cancel');
    expect(mutex.acquire('pro-lock')).toBeUndefined();
    expect(mutex.release('pro-lock', old)).toBe(true);
    const next = mutex.acquire('pro-lock')!;
    expect(mutex.release('pro-lock', old)).toBe(false);
    expect(mutex.getLease('pro-lock')).toBe(next);
    expect(mutex.release('pro-lock', next)).toBe(true);
  });
});
