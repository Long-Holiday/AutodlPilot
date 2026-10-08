import { describe, it, expect, vi } from 'vitest';
import Database from 'better-sqlite3';
import express, { Request, Response } from 'express';
import { mcpAuthMiddleware } from '../src/mcp/middleware.js';
import { createMcpServer } from '../src/mcp/server.js';
import { AutoDLClient } from '../src/autodl/client.js';
import { TaskStore } from '../src/storage/task-store.js';
import { ExperimentStore } from '../src/storage/experiment-store.js';
import { PowerOnScheduler } from '../src/scheduler/scheduler.js';
import { ExperimentManager } from '../src/experiment/manager.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

describe('MCP 鉴权中间件测试 (mcpAuthMiddleware)', () => {
  it('未提供 Authorization Header 时应拦截并返回 401', () => {
    const req = {
      headers: {},
      query: {},
      ip: '127.0.0.1',
      path: '/mcp',
      method: 'POST',
    } as unknown as Request;

    let statusCode = 0;
    let jsonResponse: unknown = null;
    const res = {
      status: (code: number) => {
        statusCode = code;
        return res;
      },
      json: (data: unknown) => {
        jsonResponse = data;
        return res;
      },
    } as unknown as Response;

    const next = vi.fn();

    mcpAuthMiddleware(req, res, next);

    expect(statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
    expect((jsonResponse as any).error).toBe('Unauthorized');
  });

  it('提供错误的 Bearer Token 时应拦截并返回 401', () => {
    const req = {
      headers: { authorization: 'Bearer invalid_secret_token' },
      query: {},
      ip: '127.0.0.1',
      path: '/mcp',
      method: 'POST',
    } as unknown as Request;

    let statusCode = 0;
    const res = {
      status: (code: number) => {
        statusCode = code;
        return res;
      },
      json: () => res,
    } as unknown as Response;

    const next = vi.fn();

    mcpAuthMiddleware(req, res, next);

    expect(statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });
});

describe('MCP Tools 工具注册与调用测试', () => {
  it('应正确注册所有管理工具并可正常处理调用', async () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE power_on_tasks (
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
      CREATE TABLE experiments (
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
    `);

    const taskStore = new TaskStore(db);
    const experimentStore = new ExperimentStore(db);
    const client = new AutoDLClient({
      baseUrl: 'https://api.autodl.com',
      token: 'test_token',
    });
    const scheduler = new PowerOnScheduler(client, taskStore, {
      initialIntervalSec: 1,
      maxIntervalSec: 5,
      backoffFactor: 2,
      maxDurationMinutes: 5,
      pollStatusIntervalSec: 1,
      pollStatusTimeoutSec: 5,
    });
    const experimentManager = new ExperimentManager(experimentStore, client);

    const mcpServer = createMcpServer({
      client,
      scheduler,
      experimentManager,
    });

    // 验证实验注册工具
    const registerResult = experimentManager.registerExperiment({
      instance_uuid: 'pro-test-mcp',
      command: 'python train.py --batch 32',
      git_commit_sha: 'a1b2c3d4e5f6',
      auto_power_off: true,
    });

    expect(registerResult.exp_id).toMatch(/^exp_/);
    expect(registerResult.suggested_remote_bash_command).toContain('setsid bash -c');
    expect(registerResult.suggested_remote_bash_command).toContain('train.py');

    // 验证实验状态更新
    const updated = await experimentManager.updateExperiment({
      exp_id: registerResult.exp_id,
      status: 'RUNNING',
      pid: 12345,
    });

    expect(updated?.status).toBe('RUNNING');
    expect(updated?.pid).toBe(12345);
  });
});
