import { describe, it, expect, vi } from 'vitest';
import Database from 'better-sqlite3';
import { TaskStore, PowerOnTaskRecord } from '../src/storage/task-store.js';
import { PowerOnScheduler } from '../src/scheduler/scheduler.js';
import { AutoDLClient } from '../src/autodl/client.js';

describe('服务重启与持久化任务恢复测试 (Task Recovery)', () => {
  it('服务重启后应自动从 SQLite 恢复未完成任务并根据远端实际状态同步', async () => {
    // 1. 初始化持久化数据库
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
    const taskStore = new TaskStore(db);

    // 2. 模拟系统崩溃前留在数据库中的未完成任务
    const interruptedTask: PowerOnTaskRecord = {
      task_id: 'task_before_crash',
      instance_uuid: 'pro-crash-recovery',
      status: 'RETRYING',
      payload: 'gpu',
      retry_count: 3,
      created_at: Date.now() - 60000,
      updated_at: Date.now() - 10000,
      next_retry_at: Date.now() + 5000,
      last_error: '资源暂未就绪',
    };
    taskStore.createTask(interruptedTask);

    const mockClient = new AutoDLClient({
      baseUrl: 'https://api.autodl.com',
      token: 'fake_token',
    });

    // 假设在服务重启期间，实例已经在 AutoDL 平台启动成功变为 running
    vi.spyOn(mockClient, 'getStatus').mockResolvedValue('running');

    // 3. 模拟新进程启动并执行 recoverTasks
    const newScheduler = new PowerOnScheduler(mockClient, taskStore, {
      initialIntervalSec: 2,
      maxIntervalSec: 10,
      backoffFactor: 2,
      maxDurationMinutes: 10,
      pollStatusIntervalSec: 1,
      pollStatusTimeoutSec: 5,
    });

    await newScheduler.recoverTasks();

    // 4. 验证任务已被成功恢复并判定为 SUCCESS
    const recovered = taskStore.getTaskById('task_before_crash');
    expect(recovered).not.toBeNull();
    expect(recovered?.status).toBe('SUCCESS');
    expect(recovered?.stop_reason).toContain('running');
  });
});
