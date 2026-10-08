import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { config } from '../config/index.js';
import { logger } from '../logger/index.js';

let dbInstance: Database.Database | null = null;

export function getDatabase(dbPath = config.DATABASE_PATH): Database.Database {
  if (dbInstance) {
    return dbInstance;
  }

  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  logger.info({ dbPath }, '初始化 SQLite 数据库');
  const db = new Database(dbPath);

  // 优化并发读写性能与可靠性
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('busy_timeout = 5000');

  // 初始化数据表架构
  db.exec(`
    -- 持续开机重试任务表
    CREATE TABLE IF NOT EXISTS power_on_tasks (
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

    CREATE INDEX IF NOT EXISTS idx_tasks_instance_uuid ON power_on_tasks (instance_uuid);
    CREATE INDEX IF NOT EXISTS idx_tasks_status ON power_on_tasks (status);

    -- 实验任务记录表
    CREATE TABLE IF NOT EXISTS experiments (
      exp_id TEXT PRIMARY KEY,
      instance_uuid TEXT NOT NULL,
      git_commit_sha TEXT,
      command TEXT NOT NULL,
      pid INTEGER,
      log_path TEXT NOT NULL,
      status TEXT NOT NULL,
      exit_code INTEGER,
      auto_power_off INTEGER NOT NULL DEFAULT 0,
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      error_message TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_experiments_instance ON experiments (instance_uuid);
    CREATE INDEX IF NOT EXISTS idx_experiments_status ON experiments (status);
  `);

  dbInstance = db;
  return db;
}

export function closeDatabase(): void {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
    logger.info('SQLite 数据库已安全关闭');
  }
}
