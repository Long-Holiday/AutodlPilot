import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { TaskStore } from '../src/storage/task-store.js';
import { PowerOnScheduler } from '../src/scheduler/scheduler.js';
import { AutoDLClient } from '../src/autodl/client.js';
import { AutoDLRetryableError } from '../src/autodl/errors.js';

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

describe('关机竞态与互斥安全性测试 (Race Condition Prevention)', () => {
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
      initialIntervalSec: 2,
      maxIntervalSec: 10,
      backoffFactor: 2,
      maxDurationMinutes: 5,
      pollStatusIntervalSec: 1,
      pollStatusTimeoutSec: 5,
    });
  });

  it('关机操作必须立即终止并取消该实例所有的后台开机任务，防止关机后被重新唤醒', async () => {
    const instanceUuid = 'pro-race-condition-1';

    // 模拟持续开机失败导致进入等待
    vi.spyOn(mockClient, 'getStatus').mockResolvedValue('stopped');
    vi.spyOn(mockClient, 'powerOn').mockRejectedValue(
      new AutoDLRetryableError('资源暂时不可用')
    );

    // 1. 触发开机请求并转入后台重试
    const { task } = await scheduler.requestPowerOn(instanceUuid);
    expect(task.status).toBe('RETRYING');

    // 2. 模拟用户此时调用关机：调度器必须强制清理关联任务
    const cancelledCount = scheduler.cancelActiveTasksForInstance(
      instanceUuid,
      '用户关机操作强制取消'
    );
    expect(cancelledCount).toBe(1);

    // 3. 校验数据库中的任务状态已被彻底置为 CANCELLED
    const currentTask = taskStore.getTaskById(task.task_id);
    expect(currentTask?.status).toBe('CANCELLED');
    expect(currentTask?.stop_reason).toContain('用户关机');

    // 4. 校验活动任务已被彻底清除
    const active = taskStore.getActiveTaskByInstance(instanceUuid);
    expect(active).toBeNull();
  });

  it('多任务并发冲突测试：同一实例重复请求开机应实现幂等保护，不可产生并发竞争', async () => {
    const instanceUuid = 'pro-concurrency-test';

    vi.spyOn(mockClient, 'getStatus').mockResolvedValue('stopped');
    vi.spyOn(mockClient, 'powerOn').mockRejectedValue(
      new AutoDLRetryableError('GPU 资源不足')
    );

    // 第一次请求
    const res1 = await scheduler.requestPowerOn(instanceUuid);
    expect(res1.task.status).toBe('RETRYING');

    // 紧接着再次请求开机同一个实例
    const res2 = await scheduler.requestPowerOn(instanceUuid);

    // 验证第二次请求直接返回已存在的任务，未重复生成新任务
    expect(res2.task.task_id).toBe(res1.task.task_id);
    expect(res2.message).toContain('请勿重复开机');
  });
});
