import Database from 'better-sqlite3';

export type TaskStatus = 'PENDING' | 'RUNNING' | 'RETRYING' | 'SUCCESS' | 'FAILED' | 'CANCELLED' | 'TIMEOUT';
export type TaskPhase = 'CHECK' | 'OBSERVE' | 'VERIFY';

export interface PowerOnTaskRecord {
  task_id: string;
  instance_uuid: string;
  status: TaskStatus;
  retry_count: number;
  created_at: number;
  updated_at: number;
  deadline_at: number | null;
  phase: TaskPhase;
  explicit_retry: number;
  owner_id: string | null;
  observe_until: number | null;
  next_retry_at: number | null;
  last_error: string | null;
  last_error_code: string | null;
  last_error_kind: string | null;
  last_request_id: string | null;
  stop_reason: string | null;
}

export function isActiveTask(task: PowerOnTaskRecord): boolean {
  return ['PENDING', 'RUNNING', 'RETRYING'].includes(task.status);
}

export function taskView(task: PowerOnTaskRecord) {
  const { owner_id: _owner, explicit_retry: _explicit, ...view } = task;
  return view;
}

const fields = [
  'task_id', 'instance_uuid', 'status', 'retry_count', 'created_at', 'updated_at',
  'deadline_at', 'phase', 'explicit_retry', 'owner_id', 'observe_until', 'next_retry_at',
  'last_error', 'last_error_code', 'last_error_kind', 'last_request_id', 'stop_reason',
] as const;
const projection = fields.join(', ');
const activeCondition = "status IN ('PENDING', 'RUNNING', 'RETRYING')";
type TaskUpdates = Partial<Pick<PowerOnTaskRecord,
  'status' | 'phase' | 'retry_count' | 'observe_until' | 'next_retry_at' | 'last_error' |
  'last_error_code' | 'last_error_kind' | 'last_request_id' | 'stop_reason'
>>;

export class TaskStore {
  constructor(private readonly db: Database.Database) {}

  createTask(task: PowerOnTaskRecord): void {
    this.db.prepare(`INSERT INTO power_on_tasks (${projection}) VALUES (${fields.map((key) => `@${key}`).join(', ')})`).run(task);
  }

  claimTask(taskId: string, ownerId: string): boolean {
    return this.db.prepare(`
      UPDATE power_on_tasks SET owner_id = ?, updated_at = ?
      WHERE task_id = ? AND explicit_retry = 1 AND ${activeCondition}
    `).run(ownerId, Date.now(), taskId).changes === 1;
  }

  // worker 只能更新自己拥有的活动任务；任何迟到响应都不能覆盖终态。
  updateActive(taskId: string, updates: TaskUpdates, ownerId?: string): boolean {
    const entries = Object.entries(updates).filter(([, value]) => value !== undefined);
    const values: Record<string, unknown> = { task_id: taskId, updated_at: Date.now() };
    for (const [key, value] of entries) {
      if (!fields.includes(key as typeof fields[number])) throw new Error('无效任务字段');
      values[key] = value;
    }
    if (ownerId !== undefined) values.owner_id = ownerId;
    return this.db.prepare(`
      UPDATE power_on_tasks SET ${entries.map(([key]) => `${key} = @${key}`).concat('updated_at = @updated_at').join(', ')}
      WHERE task_id = @task_id AND ${activeCondition}${ownerId !== undefined ? ' AND owner_id = @owner_id' : ''}
    `).run(values).changes === 1;
  }

  getTaskById(taskId: string): PowerOnTaskRecord | null {
    return this.db.prepare(`SELECT ${projection} FROM power_on_tasks WHERE task_id = ?`).get(taskId) as PowerOnTaskRecord ?? null;
  }

  getLatestTaskByInstance(instanceUuid: string): PowerOnTaskRecord | null {
    return this.db.prepare(`
      SELECT ${projection} FROM power_on_tasks WHERE instance_uuid = ? ORDER BY created_at DESC, rowid DESC LIMIT 1
    `).get(instanceUuid) as PowerOnTaskRecord ?? null;
  }

  getActiveTaskByInstance(instanceUuid: string): PowerOnTaskRecord | null {
    return this.db.prepare(`
      SELECT ${projection} FROM power_on_tasks WHERE instance_uuid = ? AND ${activeCondition} LIMIT 1
    `).get(instanceUuid) as PowerOnTaskRecord ?? null;
  }

  getPendingOrRetryingTasks(): PowerOnTaskRecord[] {
    return this.db.prepare(`SELECT ${projection} FROM power_on_tasks WHERE ${activeCondition} ORDER BY created_at`).all() as PowerOnTaskRecord[];
  }

  cancelTask(taskId: string, reason: string): boolean {
    return this.updateActive(taskId, { status: 'CANCELLED', next_retry_at: null, stop_reason: reason });
  }
}
