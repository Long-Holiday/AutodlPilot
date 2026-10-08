import crypto from 'crypto';
import { AutoDLClient } from '../autodl/client.js';
import { AutoDLError, AutoDLNonRetryableError } from '../autodl/errors.js';
import { TaskStore, PowerOnTaskRecord, TaskStatus } from '../storage/task-store.js';
import { InstanceMutex } from './mutex.js';
import { logger } from '../logger/index.js';

export interface SchedulerOptions {
  initialIntervalSec: number;
  maxIntervalSec: number;
  backoffFactor: number;
  maxDurationMinutes: number;
  pollStatusIntervalSec: number;
  pollStatusTimeoutSec: number;
}

export class PowerOnScheduler {
  private client: AutoDLClient;
  private taskStore: TaskStore;
  private mutex: InstanceMutex;
  private options: SchedulerOptions;
  private isShuttingDown = false;

  constructor(
    client: AutoDLClient,
    taskStore: TaskStore,
    options: SchedulerOptions
  ) {
    this.client = client;
    this.taskStore = taskStore;
    this.mutex = new InstanceMutex();
    this.options = options;
  }

  /**
   * 中断式异步延迟（支持在等待重试时立即取消）
   */
  private async sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      throw new Error('操作已被取消');
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (signal) {
          signal.removeEventListener('abort', onAbort);
        }
        resolve();
      }, ms);

      const onAbort = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        reject(new Error(signal?.reason?.message || '等待已被中断取消'));
      };

      if (signal) {
        signal.addEventListener('abort', onAbort);
      }
    });
  }

  /**
   * 计算下一次重试等待毫秒数（指数退避算法）
   */
  private calculateNextBackoffMs(retryCount: number): number {
    const rawSec = this.options.initialIntervalSec * Math.pow(this.options.backoffFactor, retryCount);
    const clampedSec = Math.min(rawSec, this.options.maxIntervalSec);
    // 增加 ±10% 随机抖动（Jitter），避免惊群效应
    const jitter = (Math.random() * 0.2 - 0.1) * clampedSec;
    return Math.max(1, Math.round(clampedSec + jitter)) * 1000;
  }

  /**
   * 轮询实例状态直到变为 running
   */
  private async pollUntilRunning(
    instanceUuid: string,
    signal?: AbortSignal
  ): Promise<boolean> {
    const startTime = Date.now();
    const timeoutMs = this.options.pollStatusTimeoutSec * 1000;
    const intervalMs = this.options.pollStatusIntervalSec * 1000;

    while (Date.now() - startTime < timeoutMs) {
      if (signal?.aborted) {
        throw new Error('轮询已被取消');
      }

      try {
        const status = await this.client.getStatus(instanceUuid);
        logger.info({ instanceUuid, status }, '轮询实例运行状态');
        if (status === 'running') {
          return true;
        }
      } catch (err) {
        logger.warn({ instanceUuid, err }, '轮询实例状态单次请求异常，继续重试');
      }

      await this.sleepWithAbort(intervalMs, signal);
    }

    logger.warn({ instanceUuid }, '开机后轮询进入 running 状态超时');
    return false;
  }

  /**
   * 核心方法：首次开机与后台持续开机触发
   * @returns 返回即时尝试结果及任务记录
   */
  async requestPowerOn(
    instanceUuid: string,
    payload = 'gpu',
    startCommand?: string
  ): Promise<{
    task: PowerOnTaskRecord;
    isImmediateSuccess: boolean;
    message: string;
  }> {
    // 1. 幂等性与互斥检查：如果已有活动开机任务，直接返回现有任务
    const activeTask = this.taskStore.getActiveTaskByInstance(instanceUuid);
    if (activeTask) {
      return {
        task: activeTask,
        isImmediateSuccess: false,
        message: `实例 ${instanceUuid} 当前已在后台持续开机中（任务ID: ${activeTask.task_id}，重试次数: ${activeTask.retry_count}），请勿重复开机。`,
      };
    }

    // 2. 检查当前实例是否已经处于 running 状态
    try {
      const currentStatus = await this.client.getStatus(instanceUuid);
      if (currentStatus === 'running') {
        const taskId = `task_${crypto.randomUUID().slice(0, 8)}`;
        const successTask: PowerOnTaskRecord = {
          task_id: taskId,
          instance_uuid: instanceUuid,
          status: 'SUCCESS',
          payload,
          start_command: startCommand,
          retry_count: 0,
          created_at: Date.now(),
          updated_at: Date.now(),
          stop_reason: '实例当前已处于 running 状态',
        };
        this.taskStore.createTask(successTask);
        return {
          task: successTask,
          isImmediateSuccess: true,
          message: `实例 ${instanceUuid} 当前已经处于运行状态 (running)，无需重复开机。`,
        };
      }
    } catch {
      // 若获取状态暂时失败，继续执行开机尝试
    }

    // 3. 尝试首次同步开机
    const taskId = `task_${crypto.randomUUID().slice(0, 8)}`;
    logger.info({ instanceUuid, taskId }, '尝试首次调用 power_on 开机');

    try {
      await this.client.powerOn(instanceUuid, 'gpu', startCommand);
      logger.info({ instanceUuid, taskId }, '首次 power_on 调用成功，启动后台就绪状态检测');

      // 创建成功/进行中任务记录
      const task: PowerOnTaskRecord = {
        task_id: taskId,
        instance_uuid: instanceUuid,
        status: 'RUNNING',
        payload,
        start_command: startCommand,
        retry_count: 0,
        created_at: Date.now(),
        updated_at: Date.now(),
      };
      this.taskStore.createTask(task);

      // 后台异步轮询直到完全进入 running
      this.runBackgroundPoll(task);

      return {
        task,
        isImmediateSuccess: true,
        message: `实例首次开机指令已成功提交！后台已开启状态追踪，正在等待 GPU 实例完全进入 running 状态。`,
      };
    } catch (err: unknown) {
      logger.warn({ instanceUuid, err }, '首次开机请求失败，评估是否进入持续重试模式');

      // 如果是不可重试错误（鉴权失败、实例不存在、欠费等），立即抛出终止
      if (err instanceof AutoDLNonRetryableError || (err instanceof AutoDLError && !err.isRetryable)) {
        logger.error({ instanceUuid, err }, '遭遇不可重试错误，放弃开机');
        throw err;
      }

      // 可重试错误（如 GPU 资源不足、网络暂时超时等）：转入后台持续开机
      const errorMessage = err instanceof Error ? err.message : String(err);
      const nextDelayMs = this.calculateNextBackoffMs(0);
      const nextRetryAt = Date.now() + nextDelayMs;

      const task: PowerOnTaskRecord = {
        task_id: taskId,
        instance_uuid: instanceUuid,
        status: 'RETRYING',
        payload,
        start_command: startCommand,
        retry_count: 0,
        created_at: Date.now(),
        updated_at: Date.now(),
        next_retry_at: nextRetryAt,
        last_error: errorMessage,
      };

      this.taskStore.createTask(task);
      logger.info({ instanceUuid, taskId, nextRetryAt }, '已持久化持续开机任务，启动后台异步重试循环');

      // 异步后台重试，不阻塞当前的 MCP 请求返回
      this.runBackgroundRetryLoop(task);

      return {
        task,
        isImmediateSuccess: false,
        message: `首次开机遇到资源限制或临时故障 (${errorMessage})。已自动创建后台持续开机任务 (Task ID: ${taskId})，将在后台持续排队重试，直至实例开机或达到最大重试时长。`,
      };
    }
  }

  /**
   * 后台异步轮询直到 running（用于首次或重试成功开机后）
   */
  private async runBackgroundPoll(task: PowerOnTaskRecord): Promise<void> {
    let controller: AbortController;
    try {
      controller = this.mutex.acquire(task.instance_uuid);
    } catch (err) {
      logger.warn({ err, instanceUuid: task.instance_uuid }, '无法获取实例锁进行轮询');
      return;
    }

    try {
      const isRunning = await this.pollUntilRunning(task.instance_uuid, controller.signal);
      if (isRunning) {
        this.taskStore.updateTask({
          task_id: task.task_id,
          status: 'SUCCESS',
          stop_reason: '实例已成功启动并就绪 (running)',
        });
        logger.info({ instanceUuid: task.instance_uuid, taskId: task.task_id }, '实例已完全进入 running 状态');
      } else {
        this.taskStore.updateTask({
          task_id: task.task_id,
          status: 'FAILED',
          stop_reason: '开机指令发送成功，但在指定超时时间内未检测到 running 状态',
        });
      }
    } catch (err) {
      if (controller.signal.aborted) {
        logger.info({ taskId: task.task_id }, '开机轮询任务已被主动取消');
      } else {
        logger.error({ err, taskId: task.task_id }, '后台轮询发生未捕获异常');
      }
    } finally {
      this.mutex.release(task.instance_uuid);
    }
  }

  /**
   * 独立后台重试主循环
   */
  private async runBackgroundRetryLoop(task: PowerOnTaskRecord): Promise<void> {
    let controller: AbortController;
    try {
      controller = this.mutex.acquire(task.instance_uuid);
    } catch (err) {
      logger.warn({ err, instanceUuid: task.instance_uuid }, '实例已被加锁，跳过重复执行');
      return;
    }

    const maxDurationMs = this.options.maxDurationMinutes * 60 * 1000;
    const taskStartTime = task.created_at;

    try {
      while (!this.isShuttingDown && !controller.signal.aborted) {
        // 检查数据库中当前任务状态是否已被取消
        const currentRecord = this.taskStore.getTaskById(task.task_id);
        if (!currentRecord || currentRecord.status === 'CANCELLED') {
          logger.info({ taskId: task.task_id }, '检测到任务已被取消，退出重试循环');
          break;
        }

        // 检查总超时
        if (Date.now() - taskStartTime > maxDurationMs) {
          const timeoutReason = `已达到最大重试时长 (${this.options.maxDurationMinutes}分钟)，自动停止持续开机`;
          logger.warn({ taskId: task.task_id }, timeoutReason);
          this.taskStore.updateTask({
            task_id: task.task_id,
            status: 'FAILED',
            stop_reason: timeoutReason,
          });
          break;
        }

        // 等待退避间隔
        const waitMs = currentRecord.next_retry_at ? Math.max(0, currentRecord.next_retry_at - Date.now()) : 5000;
        logger.debug({ taskId: task.task_id, waitMs }, '等待下次重试');
        await this.sleepWithAbort(waitMs, controller.signal);

        // 更新状态为 RUNNING 执行尝试
        this.taskStore.updateTask({
          task_id: task.task_id,
          status: 'RUNNING',
        });

        // 尝试开机
        try {
          logger.info({ taskId: task.task_id, retryCount: currentRecord.retry_count + 1 }, '执行后台重试开机');
          await this.client.powerOn(task.instance_uuid, 'gpu', task.start_command ?? undefined);
          
          logger.info({ taskId: task.task_id }, '后台重试开机请求成功，开始轮询 running 状态');
          
          // 开机 API 成功后轮询进入 running
          const isRunning = await this.pollUntilRunning(task.instance_uuid, controller.signal);
          if (isRunning) {
            this.taskStore.updateTask({
              task_id: task.task_id,
              status: 'SUCCESS',
              stop_reason: '后台重试开机成功，实例已就绪 (running)',
            });
            logger.info({ taskId: task.task_id }, '任务成功完成！');
            break;
          } else {
            throw new Error('开机指令成功但等待 running 超时');
          }
        } catch (retryErr: unknown) {
          // 不可重试错误立即放弃
          if (retryErr instanceof AutoDLNonRetryableError || (retryErr instanceof AutoDLError && !retryErr.isRetryable)) {
            const stopReason = `遇到不可重试错误立即终止: ${retryErr.message}`;
            logger.error({ taskId: task.task_id, stopReason }, '后台任务因严重错误终止');
            this.taskStore.updateTask({
              task_id: task.task_id,
              status: 'FAILED',
              last_error: retryErr.message,
              stop_reason: stopReason,
            });
            break;
          }

          // 可重试错误，计算下一次重试时间并更新
          const newRetryCount = currentRecord.retry_count + 1;
          const nextIntervalMs = this.calculateNextBackoffMs(newRetryCount);
          const nextRetryAt = Date.now() + nextIntervalMs;
          const errorMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);

          logger.warn({ taskId: task.task_id, newRetryCount, nextIntervalMs, errorMsg }, '本次开机重试未成功，安排下一次重试');

          this.taskStore.updateTask({
            task_id: task.task_id,
            status: 'RETRYING',
            retry_count: newRetryCount,
            last_error: errorMsg,
            next_retry_at: nextRetryAt,
          });
        }
      }
    } catch (err: unknown) {
      if (controller.signal.aborted) {
        logger.info({ taskId: task.task_id }, '重试循环被正常中止');
      } else {
        logger.error({ err, taskId: task.task_id }, '重试循环异常中断');
      }
    } finally {
      this.mutex.release(task.instance_uuid);
    }
  }

  /**
   * 取消指定的开机任务
   */
  cancelTask(taskId: string, reason = '用户主动取消'): boolean {
    const task = this.taskStore.getTaskById(taskId);
    if (!task) {
      return false;
    }
    if (['SUCCESS', 'FAILED', 'CANCELLED'].includes(task.status)) {
      return false;
    }

    this.mutex.abort(task.instance_uuid, reason);
    this.taskStore.updateTask({
      task_id: taskId,
      status: 'CANCELLED',
      stop_reason: reason,
    });
    return true;
  }

  /**
   * 竞态保障：关机操作调用，强制取消指定实例所有的活跃开机任务并打断执行！
   */
  cancelActiveTasksForInstance(instanceUuid: string, reason = '关机操作触发，已强制终止任何开机任务'): number {
    this.mutex.abort(instanceUuid, reason);
    const count = this.taskStore.cancelActiveTasksForInstance(instanceUuid, reason);
    if (count > 0) {
      logger.info({ instanceUuid, count, reason }, '已成功清理并取消该实例的所有活跃开机任务');
    }
    return count;
  }

  /**
   * 服务启动时恢复持久化中未完成的任务
   */
  async recoverTasks(): Promise<void> {
    logger.info('正在扫描 SQLite 中待恢复的未完成开机任务...');
    const pendingTasks = this.taskStore.getPendingOrRetryingTasks();
    if (pendingTasks.length === 0) {
      logger.info('没有需要恢复的后台任务');
      return;
    }

    logger.info({ count: pendingTasks.length }, `发现 ${pendingTasks.length} 个未完成的任务，开始逐个恢复`);

    for (const task of pendingTasks) {
      // 检查该实例当前实际状态
      try {
        const actualStatus = await this.client.getStatus(task.instance_uuid);
        if (actualStatus === 'running') {
          this.taskStore.updateTask({
            task_id: task.task_id,
            status: 'SUCCESS',
            stop_reason: '服务重启后检测到实例已在 running 状态',
          });
          logger.info({ taskId: task.task_id, instanceUuid: task.instance_uuid }, '恢复任务时检测到实例已处于运行中，标记为 SUCCESS');
          continue;
        }
      } catch (err) {
        logger.warn({ taskId: task.task_id, err }, '检查实例状态时出错，按原计划恢复重试');
      }

      // 重启后如果已经在 RUNNING，由于进程曾退出，重新标记为 RETRYING 准备立即尝试
      if (task.status === 'RUNNING') {
        this.taskStore.updateTask({
          task_id: task.task_id,
          status: 'RETRYING',
          next_retry_at: Date.now() + 1000,
        });
      }

      // 启动后台重试循环
      this.runBackgroundRetryLoop(task);
    }
  }

  /**
   * 获取当前任务详情
   */
  getTaskStatus(taskId: string): PowerOnTaskRecord | null {
    return this.taskStore.getTaskById(taskId);
  }

  /**
   * 获取实例最近的活跃任务
   */
  getActiveTaskByInstance(instanceUuid: string): PowerOnTaskRecord | null {
    return this.taskStore.getActiveTaskByInstance(instanceUuid);
  }

  /**
   * 优雅停机
   */
  shutdown(): void {
    this.isShuttingDown = true;
  }
}
