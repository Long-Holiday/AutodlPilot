import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { initializeDatabase } from '../src/storage/db.js';
import { PowerOnScheduler } from '../src/scheduler/scheduler.js';
import { TaskStore } from '../src/storage/task-store.js';
import { createHarness, flushWork, taskRecord } from './helpers.js';

describe('恢复持久化任务', () => {
  let harness: ReturnType<typeof createHarness>;
  beforeEach(() => { vi.useFakeTimers(); harness = createHarness(); });
  afterEach(async () => { await harness.close(); vi.useRealTimers(); vi.restoreAllMocks(); });

  it('恢复 running 实例为终态，实例查询仍能获取最终结果', async () => {
    const task = taskRecord();
    harness.store.createTask(task);
    vi.mocked(harness.client.getStatus).mockResolvedValue('running');
    await harness.scheduler.recoverTasks();
    await flushWork();
    expect(harness.scheduler.getLatestTaskByInstance(task.instance_uuid)).toMatchObject({ status: 'SUCCESS', deadline_at: task.deadline_at });
    expect(harness.client.powerOn).not.toHaveBeenCalled();
  });

  it('已过截止时间的任务不请求 API，不重置预算', async () => {
    harness.store.createTask(taskRecord({ deadline_at: Date.now() - 1 }));
    await harness.scheduler.recoverTasks();
    await flushWork();
    expect(harness.store.getTaskById('task_recovered')?.status).toBe('TIMEOUT');
    expect(harness.client.getStatus).not.toHaveBeenCalled();
    expect(harness.client.powerOn).not.toHaveBeenCalled();
  });

  it('恢复 OBSERVE/VERIFY 阶段不重复发送开机', async () => {
    for (const phase of ['OBSERVE', 'VERIFY'] as const) {
      const task = taskRecord({ task_id: `task_${phase}`, instance_uuid: `pro-${phase}`, phase, observe_until: Date.now() + 5000 });
      harness.store.createTask(task);
    }
    await harness.scheduler.recoverTasks();
    await vi.advanceTimersByTimeAsync(6000);
    expect(harness.client.powerOn).not.toHaveBeenCalled();
    expect(harness.store.getTaskById('task_OBSERVE')?.status).toBe('FAILED');
    expect(harness.store.getTaskById('task_VERIFY')?.status).toBe('FAILED');
  });

  it('服务停机不把显式任务改为用户取消，重启可按原截止时间恢复', async () => {
    const { task } = harness.scheduler.requestPowerOnRetry('pro-restart');
    await flushWork();
    await harness.scheduler.shutdown();
    const pending = harness.store.getTaskById(task.task_id)!;
    expect(pending.status).toBe('RUNNING');
    const restarted = new PowerOnScheduler(harness.client, harness.store, {
      initialIntervalSec: 1, maxIntervalSec: 5, backoffFactor: 2, maxDurationMinutes: 999,
      pollStatusIntervalSec: 1, pollStatusTimeoutSec: 5,
    });
    vi.mocked(harness.client.getStatus).mockResolvedValue('running');
    await restarted.recoverTasks();
    await vi.advanceTimersByTimeAsync(1000);
    expect(harness.store.getTaskById(task.task_id)).toMatchObject({ status: 'SUCCESS', deadline_at: pending.deadline_at });
    await restarted.shutdown();
  });

  it('owner 条件更新保护终态和新一代所有者', () => {
    harness.store.createTask(taskRecord());
    harness.store.claimTask('task_recovered', 'old');
    harness.store.claimTask('task_recovered', 'new');
    expect(harness.store.updateActive('task_recovered', { status: 'SUCCESS' }, 'old')).toBe(false);
    expect(harness.store.cancelTask('task_recovered', 'cancel')).toBe(true);
    expect(harness.store.updateActive('task_recovered', { status: 'SUCCESS' }, 'new')).toBe(false);
    expect(harness.store.getTaskById('task_recovered')?.status).toBe('CANCELLED');
  });
});

it('增量迁移保留旧任务、实验记录和命令，但不恢复旧自动重试', () => {
  const db = new Database(':memory:');
  try {
    db.exec(`
      CREATE TABLE power_on_tasks (
        task_id TEXT PRIMARY KEY, instance_uuid TEXT NOT NULL, status TEXT NOT NULL,
        payload TEXT NOT NULL DEFAULT 'gpu', start_command TEXT, retry_count INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        next_retry_at INTEGER, last_error TEXT, stop_reason TEXT
      );
      INSERT INTO power_on_tasks (task_id, instance_uuid, status, start_command, created_at, updated_at)
        VALUES ('task_legacy', 'pro-legacy', 'RETRYING', 'legacy-sensitive-command', 1, 1);
      CREATE TABLE experiments (exp_id TEXT PRIMARY KEY, command TEXT);
      INSERT INTO experiments VALUES ('exp_old', 'old-command');
    `);
    initializeDatabase(db);
    const store = new TaskStore(db);
    expect(store.getTaskById('task_legacy')).toMatchObject({ status: 'FAILED', explicit_retry: 0 });
    expect(JSON.stringify(store.getTaskById('task_legacy'))).not.toContain('legacy-sensitive-command');
    expect(db.prepare('SELECT start_command FROM power_on_tasks').get()).toEqual({ start_command: 'legacy-sensitive-command' });
    expect(db.prepare('SELECT * FROM experiments').get()).toEqual({ exp_id: 'exp_old', command: 'old-command' });
    initializeDatabase(db);
    expect(store.getTaskById('task_legacy')?.status).toBe('FAILED');
  } finally { db.close(); }
});
