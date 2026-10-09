import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig, projectRoot } from '../src/config/index.js';

describe('项目根 .env 与配置校验（只使用测试凭据）', () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(path.join(tmpdir(), 'autodl-config-test-')); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });
  const credentials = { AUTODL_TOKEN: 'fake-developer-token', MCP_AUTH_TOKEN: 'fake-mcp-token' };

  it('从指定项目根 .env 读取，不依赖进程 cwd；数据库路径也相对根目录', () => {
    writeFileSync(path.join(root, '.env'), 'AUTODL_TOKEN=fake-developer-token\nMCP_AUTH_TOKEN=fake-mcp-token\nDATABASE_PATH=state/tasks.db\n');
    const config = loadConfig({}, root);
    expect(config.AUTODL_TOKEN).toBe(credentials.AUTODL_TOKEN);
    expect(config.DATABASE_PATH).toBe(path.join(root, 'state/tasks.db'));
    expect(config.HOST).toBe('127.0.0.1');
    expect(config.RETRY_MAX_DURATION_MINUTES).toBe(120);
    expect(projectRoot).toBe(path.resolve(import.meta.dirname, '..') + path.sep);
  });

  it('部署环境已显式设置的凭据优先于 .env', () => {
    writeFileSync(path.join(root, '.env'), 'AUTODL_TOKEN=file-fake-token\nMCP_AUTH_TOKEN=file-fake-mcp\n');
    expect(loadConfig({ ...credentials }, root).AUTODL_TOKEN).toBe(credentials.AUTODL_TOKEN);
  });

  it('缺少凭据报错但不打印另一项真实值，不在导入时退出进程', () => {
    expect(() => loadConfig({ AUTODL_TOKEN: 'do-not-print-this-token' }, root)).toThrow('MCP_AUTH_TOKEN');
    try { loadConfig({ AUTODL_TOKEN: 'do-not-print-this-token' }, root); }
    catch (error) { expect(String(error)).not.toContain('do-not-print-this-token'); }
  });

  it.each([
    { MCP_AUTH_TOKEN: 'fake-developer-token' },
    { PORT: '65536' },
    { AUTODL_TIMEOUT_MS: '999999999' },
    { RETRY_MAX_DURATION_MINUTES: '999999999' },
    { RETRY_INITIAL_INTERVAL_SEC: '121', RETRY_MAX_INTERVAL_SEC: '120' },
    { MCP_ALLOWED_ORIGINS: 'https://trusted.example/path' },
  ])('拒绝不合理配置 %j', (values) => {
    expect(() => loadConfig({ ...credentials, ...values }, root)).toThrow();
  });

  it('允许可信 Origin 的精确列表', () => {
    expect(loadConfig({ ...credentials, MCP_ALLOWED_ORIGINS: 'https://one.example, http://localhost:3001' }, root).MCP_ALLOWED_ORIGINS)
      .toEqual(['https://one.example', 'http://localhost:3001']);
  });
});
