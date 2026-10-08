import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { TaskStore } from '../src/storage/task-store.js';
import { PowerOnScheduler } from '../src/scheduler/scheduler.js';
import { AutoDLClient } from '../src/autodl/client.js';
import { AutoDLRetryableError, AutoDLNonRetryableError } from '../src/autodl/errors.js';

function createInMemoryTaskStore(): TaskStore {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE power_on_tasks (
      task_id TEXT PRIMARY KEY,
      instance_uuid TEXT NOT NULL,
      status TEXT NOT NULL,
      payload TEXT NOT NULL DEFAULT 'gpu',
      start_command TEXT,
      retry_count INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      next_retry_at INTEGER,
      last_error TEXT,
      stop_reason TEXT
    );
  `);
  return new TaskStore(db);
}

describe('PowerOnScheduler 状态机与重试调度测试', () => {
  let taskStore: TaskStore;
  let mockClient: AutoDLClient;
  let scheduler: PowerOnScheduler;

  beforeEach(() => {
    taskStore = createInMemoryTaskStore();
    mockClient = new AutoDLClient({
      baseUrl: 'https://api.autodl.com',
      token: 'fake_token',
    });
    scheduler = new PowerOnScheduler(mockClient, taskStore, {
      initialIntervalSec: 1,
      maxIntervalSec: 5,
      backoffFactor: 2,
      maxDurationMinutes: 10,
      pollStatusIntervalSec: 1,
      pollStatusTimeoutSec: 5,
    });
  });

  it('场景 1: 首次开机立即成功，正确返回即时结果并完成状态流转', async () => {
    vi.spyOn(mockClient, 'getStatus')
      .mockResolvedValueOnce('stopped') // 初始状态
      .mockResolvedValueOnce('running'); // 开机后轮询就绪
    vi.spyOn(mockClient, 'powerOn').mockResolvedValue(undefined);

    const result = await scheduler.requestPowerOn('pro-test-success');

    expect(result.isImmediateSuccess).toBe(true);
    expect(result.task.status).toBe('RUNNING');

    // 等待后台轮询进入 running
    await new Promise((r) => setTimeout(r, 200));

    const updatedTask = taskStore.getTaskById(result.task.task_id);
    expect(updatedTask?.status).toBe('SUCCESS');
    expect(updatedTask?.stop_reason).toContain('running');
  });

  it('场景 2: 首次开机因 GPU 资源不足失败，自动创建后台重试任务持久化到 SQLite', async () => {
    vi.spyOn(mockClient, 'getStatus').mockResolvedValue('stopped');
    vi.spyOn(mockClient, 'powerOn').mockRejectedValue(
      new AutoDLRetryableError('当前机房 GPU 资源已满，请稍后重试')
    );

    const result = await scheduler.requestPowerOn('pro-test-retry');

    // 立即向 Agent 返回结果，表明已建立后台任务
    expect(result.isImmediateSuccess).toBe(false);
    expect(result.message).toContain('后台持续开机任务');
    expect(result.task.status).toBe('RETRYING');
    expect(result.task.last_error).toContain('GPU 资源已满');

    // 验证数据库持久化记录
    const storedTask = taskStore.getTaskById(result.task.task_id);
    expect(storedTask).not.toBeNull();
    expect(storedTask?.status).toBe('RETRYING');
    expect(storedTask?.next_retry_at).toBeGreaterThan(Date.now());
  });

  it('场景 3: 首次开机遇到鉴权失败或不可重试错误，立即抛出异常且不创建重试任务', async () => {
    vi.spyOn(mockClient, 'getStatus').mockResolvedValue('stopped');
    vi.spyOn(mockClient, 'powerOn').mockRejectedValue(
      new AutoDLNonRetryableError('Token 鉴权失败，无权开机')
    );

    await expect(scheduler.requestPowerOn('pro-test-unauth')).rejects.toThrow(
      'Token 鉴权失败'
    );

    // 确认数据库中没有留下残留任务
    const activeTask = taskStore.getActiveTaskByInstance('pro-test-unauth');
    expect(activeTask).toBeNull();
  });

  it('场景 4: 取消进行中的重试任务', async () => {
    vi.spyOn(mockClient, 'getStatus').mockResolvedValue('stopped');
    vi.spyOn(mockClient, 'powerOn').mockRejectedValue(
      new AutoDLRetryableError('GPU 资源紧张')
    );

    const result = await scheduler.requestPowerOn('pro-test-cancel');
    const taskId = result.task.task_id;

    // 用户主动取消
    const cancelled = scheduler.cancelTask(taskId, '用户不再需要该机器');
    expect(cancelled).toBe(true);

    const taskInDb = taskStore.getTaskById(taskId);
    expect(taskInDb?.status).toBe('CANCELLED');
    expect(taskInDb?.stop_reason).toBe('用户不再需要该机器');
  });
});
