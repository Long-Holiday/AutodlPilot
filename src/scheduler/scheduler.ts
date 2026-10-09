import { randomUUID } from 'node:crypto';
import { InstanceApi } from '../autodl/types.js';
import { AutoDLNonRetryableError, classifyAutoDLError, errorDetails } from '../autodl/errors.js';
import { TaskStore, PowerOnTaskRecord, isActiveTask, taskView } from '../storage/task-store.js';
import { InstanceLease, InstanceMutex } from './mutex.js';
import { logger } from '../logger/index.js';

export interface SchedulerOptions {
  initialIntervalSec: number;
  maxIntervalSec: number;
  backoffFactor: number;
  maxDurationMinutes: number;
  pollStatusIntervalSec: number;
  pollStatusTimeoutSec: number;
}

// 文档只示例了 running；这两个停止态为集中维护的兼容约定，其余状态只查询、不发开机。
const stoppedStates = new Set(['stopped', 'shutdown']);

export class PowerOnScheduler {
  private readonly mutex = new InstanceMutex();
  private readonly workers = new Map<string, InstanceLease>();
  private readonly powerOffRequests = new Map<string, Promise<unknown>>();
  private readonly work = new Set<Promise<unknown>>();
  private isShuttingDown = false;

  constructor(
    private readonly client: InstanceApi,
    private readonly taskStore: TaskStore,
    private readonly options: SchedulerOptions
  ) {}

  private track<T>(promise: Promise<T>): Promise<T> {
    this.work.add(promise);
    void promise.then(() => this.work.delete(promise), () => this.work.delete(promise));
    return promise;
  }

  private ensureAvailable(instanceUuid: string): void {
    if (this.isShuttingDown) throw new Error('服务正在停止，不接受新操作');
    if (this.powerOffRequests.has(instanceUuid)) throw new Error('该实例正在执行关机，请等待结果后再操作');
  }

  async requestPowerOn(instanceUuid: string) {
    this.ensureAvailable(instanceUuid);
    const active = this.taskStore.getActiveTaskByInstance(instanceUuid);
    if (active) return { instance_uuid: instanceUuid, status: 'retrying', task: taskView(active) };
    const lease = this.mutex.acquire(instanceUuid);
    if (!lease) return { instance_uuid: instanceUuid, status: 'busy', message: '该实例已有在途操作，请稍后查询状态' };
    return this.track(this.performPowerOn(instanceUuid, lease));
  }

  private async performPowerOn(instanceUuid: string, lease: InstanceLease) {
    try {
      const response = await this.client.powerOn(instanceUuid, lease.controller.signal);
      if (lease.controller.signal.aborted) {
        throw new AutoDLNonRetryableError('开机操作已取消；请查询实例实际状态', {
          kind: 'cancelled', uncertain: true,
        });
      }
      return {
        instance_uuid: instanceUuid, status: 'accepted', code: response.code,
        request_id: response.request_id, retryable: false,
        message: '开机指令已接受；请查询实例状态，running 不代表 SSH 已就绪',
      };
    } catch (error) {
      const details = errorDetails(error);
      return {
        instance_uuid: instanceUuid,
        status: details.kind === 'gpu_unavailable' ? 'gpu_unavailable' : 'failed',
        ...details,
        next_action: details.outcome_uncertain ? '先查询实例状态，不要盲目再次开机'
          : details.retryable ? '需要持续请求时显式调用 retry_power_on_instance' : '处理错误后再请求',
      };
    } finally {
      this.mutex.release(instanceUuid, lease);
    }
  }

  requestPowerOnRetry(instanceUuid: string) {
    this.ensureAvailable(instanceUuid);
    const active = this.taskStore.getActiveTaskByInstance(instanceUuid);
    if (active) return { instance_uuid: instanceUuid, status: 'retrying', task: taskView(active), existing: true };
    if (this.mutex.getLease(instanceUuid)) throw new Error('该实例仍有在途操作，稍后再发起持续开机');
    const now = Date.now();
    const task: PowerOnTaskRecord = {
      task_id: `task_${randomUUID()}`, instance_uuid: instanceUuid,
      status: 'PENDING', retry_count: 0, created_at: now, updated_at: now,
      deadline_at: now + this.options.maxDurationMinutes * 60_000,
      phase: 'CHECK', explicit_retry: 1, owner_id: null, observe_until: null,
      next_retry_at: now, last_error: null, last_error_code: null, last_error_kind: null,
      last_request_id: null, stop_reason: null,
    };
    this.taskStore.createTask(task);
    this.launchWorker(task);
    return { instance_uuid: instanceUuid, status: 'retrying', task: taskView(task), existing: false };
  }

  private launchWorker(task: PowerOnTaskRecord): void {
    const lease = this.mutex.acquire(task.instance_uuid);
    if (!lease) return;
    let claimed: boolean;
    try {
      claimed = this.taskStore.claimTask(task.task_id, lease.id);
    } catch (error) {
      this.mutex.release(task.instance_uuid, lease);
      throw error;
    }
    if (!claimed) {
      this.mutex.release(task.instance_uuid, lease);
      return;
    }
    this.workers.set(task.task_id, lease);
    // 注册所有权后再启动异步工作，工具调用不等待 AutoDL 或完整启动。
    const worker = Promise.resolve().then(() => this.runBackgroundRetryLoop(task, lease)).finally(() => {
      if (this.workers.get(task.task_id) === lease) this.workers.delete(task.task_id);
      this.mutex.release(task.instance_uuid, lease);
    });
    this.track(worker);
  }

  private currentTask(task: PowerOnTaskRecord, lease: InstanceLease): PowerOnTaskRecord | null {
    if (lease.controller.signal.aborted || this.mutex.getLease(task.instance_uuid) !== lease) return null;
    const current = this.taskStore.getTaskById(task.task_id);
    return current && isActiveTask(current) && current.owner_id === lease.id ? current : null;
  }

  private finish(task: PowerOnTaskRecord, lease: InstanceLease, status: 'SUCCESS' | 'FAILED' | 'TIMEOUT', reason: string): void {
    this.taskStore.updateActive(task.task_id, {
      status, stop_reason: reason, next_retry_at: null,
      ...(status === 'SUCCESS' ? { last_error: null, last_error_code: null, last_error_kind: null } : {}),
    }, lease.id);
  }

  private calculateNextBackoffMs(attempts: number): number {
    const raw = this.options.initialIntervalSec * 1000 * Math.pow(this.options.backoffFactor, Math.max(0, attempts - 1));
    const maximum = this.options.maxIntervalSec * 1000;
    const clamped = Math.min(raw, maximum);
    return Math.max(1, Math.min(maximum, Math.round(clamped * (0.9 + Math.random() * 0.2))));
  }

  private sleepWithAbort(ms: number, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        reject(signal.reason);
      };
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  private async runBackgroundRetryLoop(task: PowerOnTaskRecord, lease: InstanceLease): Promise<void> {
    try {
      while (true) {
        const current = this.currentTask(task, lease);
        if (!current) return;
        const deadline = current.deadline_at;
        if (deadline === null) {
          this.finish(task, lease, 'FAILED', '任务缺少截止时间，请显式重新发起');
          return;
        }
        if (Date.now() >= deadline) {
          this.finish(task, lease, 'TIMEOUT', '达到持续开机截止时间，不再发起请求');
          return;
        }
        const wakeAt = Math.min(current.next_retry_at ?? Date.now(), deadline);
        if (wakeAt > Date.now()) await this.sleepWithAbort(wakeAt - Date.now(), lease.controller.signal);
        if (!this.currentTask(task, lease)) return;
        if (Date.now() >= deadline) continue;
        const signal = AbortSignal.any([
          lease.controller.signal,
          AbortSignal.timeout(Math.max(1, Math.ceil(deadline - Date.now()))),
        ]);
        this.taskStore.updateActive(task.task_id, { status: 'RUNNING', next_retry_at: null }, lease.id);

        try {
          const status = await this.client.getStatus(task.instance_uuid, signal);
          if (!this.currentTask(task, lease)) return;
          if (Date.now() >= deadline) continue;
          if (status === 'running') {
            this.finish(task, lease, 'SUCCESS', '实例已进入 running 状态；SSH 就绪由本机检查');
            return;
          }
          if (current.phase !== 'CHECK') {
            if (Date.now() >= (current.observe_until ?? deadline)) {
              this.finish(task, lease, 'FAILED', '开机已接受或结果不确定，但未确认 running；请查询状态，不自动重复开机');
              return;
            }
            this.taskStore.updateActive(task.task_id, {
              next_retry_at: Date.now() + this.options.pollStatusIntervalSec * 1000,
            }, lease.id);
            continue;
          }
          if (!stoppedStates.has(status)) {
            this.taskStore.updateActive(task.task_id, {
              next_retry_at: Date.now() + this.options.pollStatusIntervalSec * 1000,
              last_error: `当前状态 ${status} 不是已知停止态，仅继续查询`, last_error_kind: 'unknown_status',
            }, lease.id);
            continue;
          }

          // 在发送前持久化不确定阶段：进程崩溃也不能在恢复后盲目重发开机。
          const observeUntil = Math.min(deadline, Date.now() + this.options.pollStatusTimeoutSec * 1000);
          this.taskStore.updateActive(task.task_id, {
            phase: 'VERIFY', observe_until: observeUntil, retry_count: current.retry_count + 1,
          }, lease.id);
          try {
            const response = await this.client.powerOn(task.instance_uuid, signal);
            if (!this.currentTask(task, lease)) return;
            this.taskStore.updateActive(task.task_id, {
              phase: 'OBSERVE', last_request_id: response.request_id ?? null,
              last_error: null, last_error_code: null, last_error_kind: null,
              next_retry_at: Date.now() + this.options.pollStatusIntervalSec * 1000,
            }, lease.id);
          } catch (error) {
            if (!this.currentTask(task, lease)) return;
            const details = errorDetails(error);
            this.taskStore.updateActive(task.task_id, {
              last_error: details.message, last_error_code: details.code ?? null,
              last_error_kind: details.kind, last_request_id: details.request_id ?? null,
            }, lease.id);
            if (Date.now() >= deadline) continue;
            if (details.outcome_uncertain) {
              this.taskStore.updateActive(task.task_id, {
                phase: 'VERIFY', next_retry_at: Date.now() + this.options.pollStatusIntervalSec * 1000,
              }, lease.id);
            } else if (details.retryable) {
              this.taskStore.updateActive(task.task_id, {
                status: 'RETRYING', phase: 'CHECK', observe_until: null,
                next_retry_at: Date.now() + this.calculateNextBackoffMs(current.retry_count + 1),
              }, lease.id);
            } else {
              this.finish(task, lease, 'FAILED', '不可重试或未知业务错误，已停止持续开机');
              return;
            }
          }
        } catch (error) {
          if (!this.currentTask(task, lease)) return;
          if (Date.now() >= deadline) continue;
          const { classifiedError } = classifyAutoDLError(error);
          const details = errorDetails(classifiedError);
          this.taskStore.updateActive(task.task_id, {
            last_error: details.message, last_error_code: details.code ?? null,
            last_error_kind: details.kind, last_request_id: details.request_id ?? null,
          }, lease.id);
          if (!classifiedError.isRetryable) {
            this.finish(task, lease, 'FAILED', '状态查询遇到不可重试错误，已停止任务');
            return;
          }
          this.taskStore.updateActive(task.task_id, {
            status: 'RETRYING', next_retry_at: Date.now() + this.calculateNextBackoffMs(current.retry_count),
          }, lease.id);
        }
      }
    } catch (error) {
      if (this.currentTask(task, lease)) {
        logger.error({ task_id: task.task_id }, '后台任务异常停止');
        this.finish(task, lease, 'FAILED', error instanceof Error ? error.message : '后台任务异常');
      }
    }
  }

  cancelTask(taskId: string, reason = '用户主动取消持续请求，不影响实例实际状态'): boolean {
    const cancelled = this.taskStore.cancelTask(taskId, reason);
    if (cancelled) this.workers.get(taskId)?.controller.abort(new Error(reason));
    return cancelled;
  }

  powerOff(instanceUuid: string): Promise<unknown> {
    const existing = this.powerOffRequests.get(instanceUuid);
    if (existing) return existing;
    this.ensureAvailable(instanceUuid);
    const active = this.taskStore.getActiveTaskByInstance(instanceUuid);
    const cancelledCount = active && this.cancelTask(active.task_id, '关机前取消持续开机') ? 1 : 0;
    const previousLease = this.mutex.getLease(instanceUuid);
    this.mutex.abort(instanceUuid, '关机前等待在途开机清理');
    const promise = this.track(Promise.resolve().then(async () => {
      if (previousLease) await previousLease.released;
      if (this.isShuttingDown) throw new Error('服务正在停止，关机未发送，请稍后查询实例');
      const lease = this.mutex.acquire(instanceUuid);
      if (!lease) throw new Error('该实例仍有在途操作');
      try {
        const response = await this.client.powerOff(instanceUuid, lease.controller.signal);
        return {
          instance_uuid: instanceUuid, status: 'accepted', code: response.code,
          request_id: response.request_id, cancelled_retry_tasks_count: cancelledCount,
          message: '关机请求已接受，请查询实际状态；网络取消无法撤回已送达平台的开机指令',
        };
      } finally {
        this.mutex.release(instanceUuid, lease);
      }
    }));
    this.powerOffRequests.set(instanceUuid, promise);
    void promise.then(
      () => this.powerOffRequests.delete(instanceUuid),
      () => this.powerOffRequests.delete(instanceUuid)
    );
    return promise;
  }

  async recoverTasks(): Promise<void> {
    if (this.isShuttingDown) return;
    for (const task of this.taskStore.getPendingOrRetryingTasks()) {
      if (!task.deadline_at || task.explicit_retry !== 1) {
        this.taskStore.updateActive(task.task_id, { status: 'FAILED', next_retry_at: null, stop_reason: '请显式重新发起持续请求' });
      } else if (Date.now() >= task.deadline_at) {
        this.taskStore.updateActive(task.task_id, { status: 'TIMEOUT', next_retry_at: null, stop_reason: '恢复时任务已过截止时间' });
      } else {
        this.launchWorker(task);
      }
    }
  }

  getTaskStatus(taskId: string): PowerOnTaskRecord | null {
    return this.taskStore.getTaskById(taskId);
  }

  getLatestTaskByInstance(instanceUuid: string): PowerOnTaskRecord | null {
    return this.taskStore.getLatestTaskByInstance(instanceUuid);
  }

  async shutdown(): Promise<void> {
    this.isShuttingDown = true;
    this.mutex.abortAll('服务停止，显式持续任务在重启后按原截止时间恢复');
    await Promise.allSettled([...this.work]);
  }
}
