import { randomUUID } from 'node:crypto';

export interface InstanceLease {
  id: string;
  controller: AbortController;
  released: Promise<void>;
  resolveRelease: () => void;
}

export class InstanceMutex {
  private readonly leases = new Map<string, InstanceLease>();

  acquire(instanceUuid: string): InstanceLease | undefined {
    if (this.leases.has(instanceUuid)) return undefined;
    let resolveRelease!: () => void;
    const released = new Promise<void>((resolve) => { resolveRelease = resolve; });
    const lease = { id: randomUUID(), controller: new AbortController(), released, resolveRelease };
    this.leases.set(instanceUuid, lease);
    return lease;
  }

  getLease(instanceUuid: string): InstanceLease | undefined {
    return this.leases.get(instanceUuid);
  }

  release(instanceUuid: string, lease: InstanceLease): boolean {
    if (this.leases.get(instanceUuid) !== lease) return false;
    this.leases.delete(instanceUuid);
    lease.resolveRelease();
    return true;
  }

  abort(instanceUuid: string, reason: string): boolean {
    const lease = this.leases.get(instanceUuid);
    if (!lease) return false;
    // 取消仅发信号。必须等待 owner 清理完成后才能释放锁。
    lease.controller.abort(new Error(reason));
    return true;
  }

  abortAll(reason: string): void {
    for (const lease of this.leases.values()) lease.controller.abort(new Error(reason));
  }
}
