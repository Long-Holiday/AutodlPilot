import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

export function initializeDatabase(db: Database.Database): void {
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('busy_timeout = 5000');
  db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS power_on_tasks (
        task_id TEXT PRIMARY KEY,
        instance_uuid TEXT NOT NULL,
        status TEXT NOT NULL,
        retry_count INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        next_retry_at INTEGER,
        last_error TEXT,
        stop_reason TEXT
      );
    `);
    const columns = new Set((db.pragma('table_info(power_on_tasks)') as { name: string }[]).map((col) => col.name));
    const additions = {
      deadline_at: 'INTEGER',
      phase: "TEXT NOT NULL DEFAULT 'CHECK'",
      explicit_retry: 'INTEGER NOT NULL DEFAULT 0',
      owner_id: 'TEXT',
      observe_until: 'INTEGER',
      last_error_code: 'TEXT',
      last_error_kind: 'TEXT',
      last_request_id: 'TEXT',
    };
    for (const [name, definition] of Object.entries(additions)) {
      if (!columns.has(name)) db.exec(`ALTER TABLE power_on_tasks ADD COLUMN ${name} ${definition}`);
    }
    // 旧版本自动创建的任务没有显式重试授权；保留记录但不恢复计费操作。
    db.prepare(`
      UPDATE power_on_tasks SET status = 'FAILED', next_retry_at = NULL,
        stop_reason = '升级后请显式调用 retry_power_on_instance 重新发起持续开机', updated_at = ?
      WHERE explicit_retry = 0 AND status IN ('PENDING', 'RUNNING', 'RETRYING')
    `).run(Date.now());
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_tasks_instance_uuid ON power_on_tasks (instance_uuid);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_active_instance ON power_on_tasks (instance_uuid)
        WHERE status IN ('PENDING', 'RUNNING', 'RETRYING');
    `);
    // 不创建新的 experiments 表，也不删除已有表和历史数据。
  })();
}

export function openDatabase(dbPath: string): Database.Database {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  try {
    initializeDatabase(db);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
