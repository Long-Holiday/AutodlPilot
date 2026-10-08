import Database from 'better-sqlite3';
import { getDatabase } from './db.js';

export type ExperimentStatus = 'INITIALIZING' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'TERMINATED';

export interface ExperimentRecord {
  exp_id: string;
  instance_uuid: string;
  git_commit_sha?: string | null;
  command: string;
  pid?: number | null;
  log_path: string;
  status: ExperimentStatus;
  exit_code?: number | null;
  auto_power_off: number; // 0 or 1
  started_at: number;
  ended_at?: number | null;
  error_message?: string | null;
}

export class ExperimentStore {
  private db: Database.Database;

  constructor(database?: Database.Database) {
    this.db = database || getDatabase();
  }

  createExperiment(exp: ExperimentRecord): void {
    const stmt = this.db.prepare(`
      INSERT INTO experiments (
        exp_id, instance_uuid, git_commit_sha, command, pid,
        log_path, status, exit_code, auto_power_off, started_at, ended_at, error_message
      ) VALUES (
        @exp_id, @instance_uuid, @git_commit_sha, @command, @pid,
        @log_path, @status, @exit_code, @auto_power_off, @started_at, @ended_at, @error_message
      )
    `);

    stmt.run({
      exp_id: exp.exp_id,
      instance_uuid: exp.instance_uuid,
      git_commit_sha: exp.git_commit_sha ?? null,
      command: exp.command,
      pid: exp.pid ?? null,
      log_path: exp.log_path,
      status: exp.status,
      exit_code: exp.exit_code ?? null,
      auto_power_off: exp.auto_power_off,
      started_at: exp.started_at,
      ended_at: exp.ended_at ?? null,
      error_message: exp.error_message ?? null,
    });
  }

  updateExperiment(updates: Partial<ExperimentRecord> & { exp_id: string }): void {
    const fields: string[] = [];
    const values: Record<string, unknown> = {
      exp_id: updates.exp_id,
    };

    if (updates.status !== undefined) {
      fields.push('status = @status');
      values.status = updates.status;
    }
    if (updates.pid !== undefined) {
      fields.push('pid = @pid');
      values.pid = updates.pid;
    }
    if (updates.exit_code !== undefined) {
      fields.push('exit_code = @exit_code');
      values.exit_code = updates.exit_code;
    }
    if (updates.ended_at !== undefined) {
      fields.push('ended_at = @ended_at');
      values.ended_at = updates.ended_at;
    }
    if (updates.error_message !== undefined) {
      fields.push('error_message = @error_message');
      values.error_message = updates.error_message;
    }

    if (fields.length === 0) return;

    const sql = `UPDATE experiments SET ${fields.join(', ')} WHERE exp_id = @exp_id`;
    this.db.prepare(sql).run(values);
  }

  getExperimentById(expId: string): ExperimentRecord | null {
    const stmt = this.db.prepare('SELECT * FROM experiments WHERE exp_id = ?');
    const row = stmt.get(expId) as ExperimentRecord | undefined;
    return row || null;
  }

  listExperimentsByInstance(instanceUuid: string): ExperimentRecord[] {
    const stmt = this.db.prepare(`
      SELECT * FROM experiments 
      WHERE instance_uuid = ? 
      ORDER BY started_at DESC
    `);
    return stmt.all(instanceUuid) as ExperimentRecord[];
  }
}
