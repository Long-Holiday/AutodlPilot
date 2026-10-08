/**
 * 实例级别互斥控制器，维护运行中任务的 AbortController 与定时器引用
 */
export class InstanceMutex {
  private activeControllers = new Map<string, AbortController>();

  /**
   * 尝试获取实例锁并绑定 AbortController
   */
  acquire(instanceUuid: string): AbortController {
    if (this.activeControllers.has(instanceUuid)) {
      throw new Error(`实例 ${instanceUuid} 当前已有活跃的开机任务正在执行`);
    }
    const controller = new AbortController();
    this.activeControllers.set(instanceUuid, controller);
    return controller;
  }

  /**
   * 检查实例是否被占用
   */
  isLocked(instanceUuid: string): boolean {
    return this.activeControllers.has(instanceUuid);
  }

  /**
   * 获取指定实例的当前 AbortController
   */
  getController(instanceUuid: string): AbortController | undefined {
    return this.activeControllers.get(instanceUuid);
  }

  /**
   * 释放实例锁
   */
  release(instanceUuid: string): void {
    this.activeControllers.delete(instanceUuid);
  }

  /**
   * 取消指定实例正在执行的任务并释放锁
   */
  abort(instanceUuid: string, reason = '任务被中断'): boolean {
    const controller = this.activeControllers.get(instanceUuid);
    if (controller) {
      controller.abort(new Error(reason));
      this.activeControllers.delete(instanceUuid);
      return true;
    }
    return false;
  }
}
