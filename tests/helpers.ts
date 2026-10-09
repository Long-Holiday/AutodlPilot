import { vi } from 'vitest';
import { Server } from 'node:http';
import { AutoDLClient } from '../src/autodl/client.js';
import { openDatabase } from '../src/storage/db.js';
import { TaskStore, PowerOnTaskRecord } from '../src/storage/task-store.js';
import { PowerOnScheduler, SchedulerOptions } from '../src/scheduler/scheduler.js';

export const success = { code: 'Success', data: null, msg: '', request_id: 'request-test' } as const;

export function createHarness(options: Partial<SchedulerOptions> = {}) {
  const db = openDatabase(':memory:');
  const store = new TaskStore(db);
  const client = new AutoDLClient({ baseUrl: 'http://127.0.0.1:1', token: 'fake-autodl-token' });
  vi.spyOn(client, 'getStatus').mockResolvedValue('stopped');
  vi.spyOn(client, 'powerOn').mockResolvedValue(success);
  vi.spyOn(client, 'powerOff').mockResolvedValue(success);
  const scheduler = new PowerOnScheduler(client, store, {
    initialIntervalSec: 1, maxIntervalSec: 5, backoffFactor: 2,
    maxDurationMinutes: 2, pollStatusIntervalSec: 1, pollStatusTimeoutSec: 5,
    ...options,
  });
  return {
    db, store, client, scheduler,
    close: async () => { await scheduler.shutdown(); db.close(); },
  };
}

export function taskRecord(overrides: Partial<PowerOnTaskRecord> = {}): PowerOnTaskRecord {
  return {
    task_id: 'task_recovered', instance_uuid: 'pro-recovered', status: 'RETRYING',
    retry_count: 1, created_at: Date.now() - 10_000, updated_at: Date.now(),
    deadline_at: Date.now() + 30_000, phase: 'CHECK', explicit_retry: 1,
    owner_id: null, observe_until: null, next_retry_at: Date.now(),
    last_error: null, last_error_code: null, last_error_kind: null,
    last_request_id: null, stop_reason: null, ...overrides,
  };
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

export async function flushWork() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

export async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('没有本地监听地址');
  return `http://127.0.0.1:${address.port}`;
}

export async function closeServer(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
