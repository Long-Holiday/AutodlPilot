import crypto from 'crypto';
import { ExperimentStore, ExperimentRecord, ExperimentStatus } from '../storage/experiment-store.js';
import { AutoDLClient } from '../autodl/client.js';
import { logger } from '../logger/index.js';

export interface RegisterExperimentParams {
  instance_uuid: string;
  command: string;
  git_commit_sha?: string;
  log_path?: string;
  auto_power_off?: boolean;
}

export interface RegisterExperimentResult {
  exp_id: string;
  instance_uuid: string;
  log_path: string;
  pid_path: string;
  exit_code_path: string;
  suggested_remote_bash_command: string;
  note: string;
}

export class ExperimentManager {
  private store: ExperimentStore;
  private client: AutoDLClient;

  constructor(store: ExperimentStore, client: AutoDLClient) {
    this.store = store;
    this.client = client;
  }

  /**
   * 注册新实验，生成实验 ID 并构造安全的后台无挂断远程执行脚本模板
   */
  registerExperiment(params: RegisterExperimentParams): RegisterExperimentResult {
    const expId = `exp_${crypto.randomUUID().slice(0, 8)}`;
    const logPath = params.log_path || `/root/autodl-tmp/logs/${expId}.log`;
    const pidPath = `/root/autodl-tmp/logs/${expId}.pid`;
    const exitCodePath = `/root/autodl-tmp/logs/${expId}.exit`;

    const record: ExperimentRecord = {
      exp_id: expId,
      instance_uuid: params.instance_uuid,
      git_commit_sha: params.git_commit_sha ?? null,
      command: params.command,
      log_path: logPath,
      status: 'INITIALIZING',
      auto_power_off: params.auto_power_off ? 1 : 0,
      started_at: Date.now(),
    };

    this.store.createExperiment(record);

    // 构造防 SSH 断开的 nohup 后台执行命令包装器
    // 自动创建日志目录，使用 setsid/nohup 执行，并将 PID 和退出码保存到文件
    const safeCommand = `
mkdir -p /root/autodl-tmp/logs && \
setsid bash -c '${params.command.replace(/'/g, "'\\''")} > ${logPath} 2>&1; echo $? > ${exitCodePath}' > /dev/null 2>&1 & \
echo $! > ${pidPath} && \
echo "Experiment started with PID $(cat ${pidPath})"
    `.trim().replace(/\n\s*/g, ' ');

    logger.info({ expId, instanceUuid: params.instance_uuid }, '已注册实验元数据');

    return {
      exp_id: expId,
      instance_uuid: params.instance_uuid,
      log_path: logPath,
      pid_path: pidPath,
      exit_code_path: exitCodePath,
      suggested_remote_bash_command: safeCommand,
      note: '请本地 Agent 通过 SSH 运行上述命令以在 AutoDL 远程后台执行实验。执行后请调用 update_experiment 记录实际 PID。',
    };
  }

  /**
   * 更新实验运行状态及进程信息
   */
  async updateExperiment(params: {
    exp_id: string;
    status: ExperimentStatus;
    pid?: number;
    exit_code?: number;
    error_message?: string;
  }): Promise<ExperimentRecord | null> {
    const existing = this.store.getExperimentById(params.exp_id);
    if (!existing) {
      return null;
    }

    const updates: Partial<ExperimentRecord> & { exp_id: string } = {
      exp_id: params.exp_id,
      status: params.status,
      pid: params.pid,
      exit_code: params.exit_code,
      error_message: params.error_message,
    };

    if (['COMPLETED', 'FAILED', 'TERMINATED'].includes(params.status)) {
      updates.ended_at = Date.now();
    }

    this.store.updateExperiment(updates);
    const updated = this.store.getExperimentById(params.exp_id);

    // 如果配置了自动关机且实验结束，触发关机
    if (
      existing.auto_power_off === 1 &&
      ['COMPLETED', 'FAILED'].includes(params.status)
    ) {
      logger.info({ expId: params.exp_id, instanceUuid: existing.instance_uuid }, '实验结束触发自动关机');
      try {
        await this.client.powerOff(existing.instance_uuid);
      } catch (err) {
        logger.error({ err, instanceUuid: existing.instance_uuid }, '自动关机请求失败');
      }
    }

    return updated;
  }

  getExperiment(expId: string): ExperimentRecord | null {
    return this.store.getExperimentById(expId);
  }

  listExperiments(instanceUuid: string): ExperimentRecord[] {
    return this.store.listExperimentsByInstance(instanceUuid);
  }
}
