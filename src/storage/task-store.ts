import Database from 'better-sqlite3';
import { getDatabase } from './db.js';

export type TaskStatus = 'PENDING' | 'RUNNING' | 'RETRYING' | 'SUCCESS' | 'FAILED' | 'CANCELLED';

export interface PowerOnTaskRecord {
  task_id: string;
  instance_uuid: string;
  status: TaskStatus;
  payload: string;
  start_command?: string | null;
  retry_count: number;
  created_at: number;
  updated_at: number;
  next_retry_at?: number | null;
  last_error?: string | null;
  stop_reason?: string | null;
}

export class TaskStore {
  private db: Database.Database;

  constructor(database?: Database.Database) {
    this.db = database || getDatabase();
  }

  /**
   * 创建新任务
   */
  createTask(task: PowerOnTaskRecord): void {
    const stmt = this.db.prepare(`
      INSERT INTO power_on_tasks (
        task_id, instance_uuid, status, payload, start_command,
        retry_count, created_at, updated_at, next_retry_at, last_error, stop_reason
      ) VALUES (
        @task_id, @instance_uuid, @status, @payload, @start_command,
        @retry_count, @created_at, @updated_at, @next_retry_at, @last_error, @stop_reason
      )
    `);

    stmt.run({
      task_id: task.task_id,
      instance_uuid: task.instance_uuid,
      status: task.status,
      payload: task.payload,
      start_command: task.start_command ?? null,
      retry_count: task.retry_count,
      created_at: task.created_at,
      updated_at: task.updated_at,
      next_retry_at: task.next_retry_at ?? null,
      last_error: task.last_error ?? null,
      stop_reason: task.stop_reason ?? null,
    });
  }

  /**
   * 局部更新任务字段
   */
  updateTask(updates: Partial<PowerOnTaskRecord> & { task_id: string }): void {
    const fields: string[] = [];
    const values: Record<string, unknown> = {
      task_id: updates.task_id,
      updated_at: Date.now(),
    };

    if (updates.status !== undefined) {
      fields.push('status = @status');
      values.status = updates.status;
    }
    if (updates.retry_count !== undefined) {
      fields.push('retry_count = @retry_count');
      values.retry_count = updates.retry_count;
    }
    if (updates.next_retry_at !== undefined) {
      fields.push('next_retry_at = @next_retry_at');
      values.next_retry_at = updates.next_retry_at;
    }
    if (updates.last_error !== undefined) {
      fields.push('last_error = @last_error');
      values.last_error = updates.last_error;
    }
    if (updates.stop_reason !== undefined) {
      fields.push('stop_reason = @stop_reason');
      values.stop_reason = updates.stop_reason;
    }

    fields.push('updated_at = @updated_at');

    const sql = `UPDATE power_on_tasks SET ${fields.join(', ')} WHERE task_id = @task_id`;
    this.db.prepare(sql).run(values);
  }

  /**
   * 根据 ID 查询任务
   */
  getTaskById(taskId: string): PowerOnTaskRecord | null {
    const stmt = this.db.prepare('SELECT * FROM power_on_tasks WHERE task_id = ?');
    const row = stmt.get(taskId) as PowerOnTaskRecord | undefined;
    return row || null;
  }

  /**
   * 查询指定实例当前处于活动状态（未结束）的任务
   */
  getActiveTaskByInstance(instanceUuid: string): PowerOnTaskRecord | null {
    const stmt = this.db.prepare(`
      SELECT * FROM power_on_tasks 
      WHERE instance_uuid = ? AND status IN ('PENDING', 'RUNNING', 'RETRYING')
      ORDER BY created_at DESC LIMIT 1
    `);
    const row = stmt.get(instanceUuid) as PowerOnTaskRecord | undefined;
    return row || null;
  }

  /**
   * 查询所有待恢复的任务（服务重启时使用）
   */
  getPendingOrRetryingTasks(): PowerOnTaskRecord[] {
    const stmt = this.db.prepare(`
      SELECT * FROM power_on_tasks 
      WHERE status IN ('PENDING', 'RUNNING', 'RETRYING')
      ORDER BY created_at ASC
    `);
    return stmt.all() as PowerOnTaskRecord[];
  }

  /**
   * 取消指定实例的所有活跃开机任务（关机或手动取消时执行）
   */
  cancelActiveTasksForInstance(instanceUuid: string, reason: string): number {
    const stmt = this.db.prepare(`
      UPDATE power_on_tasks 
      SET status = 'CANCELLED', stop_reason = ?, updated_at = ?
      WHERE instance_uuid = ? AND status IN ('PENDING', 'RUNNING', 'RETRYING')
    `);
    const result = stmt.run(reason, Date.now(), instanceUuid);
    return result.changes;
  }
}
