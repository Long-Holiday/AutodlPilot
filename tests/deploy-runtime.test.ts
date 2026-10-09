import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, copyFileSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const helper = fileURLToPath(new URL('../scripts/deploy-runtime.sh', import.meta.url));

describe('部署 runtime：个人 nvm 安装与服务用户隔离', () => {
  let root: string;
  let home: string;
  let prefix: string;
  let runtime: string;
  let npmRoot: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'autodl-runtime-test-'));
    home = path.join(root, 'private-home');
    prefix = path.join(home, '.nvm/versions/node/v24.21.0');
    runtime = path.join(root, 'runtime');
    npmRoot = path.join(prefix, 'lib/node_modules/npm');
    mkdirSync(path.join(prefix, 'bin'), { recursive: true });
    mkdirSync(path.join(npmRoot, 'bin'), { recursive: true });
    mkdirSync(path.join(npmRoot, 'lib'));
    chmodSync(home, 0o700);
    // 只读测试 fixture；不执行 npm 安装、不修改真正的 nvm 目录。
    try { linkSync(process.execPath, path.join(prefix, 'bin/node')); }
    catch { copyFileSync(process.execPath, path.join(prefix, 'bin/node')); }
    writeFileSync(path.join(npmRoot, 'package.json'), JSON.stringify({ name: 'npm', version: '11.19.0' }));
    writeFileSync(path.join(home, 'version.js'), 'module.exports = "11.19.0";');
    symlinkSync(path.join(home, 'version.js'), path.join(npmRoot, 'lib/version.js'));
    writeFileSync(path.join(npmRoot, 'bin/npm-cli.js'), '#!/usr/bin/env node\nconsole.log(require("../lib/version.js"));\n', { mode: 0o755 });
    writeFileSync(path.join(npmRoot, 'bin/npx-cli.js'), '#!/usr/bin/env node\nconsole.log("test-npx");\n', { mode: 0o755 });
    symlinkSync('../lib/node_modules/npm/bin/npm-cli.js', path.join(prefix, 'bin/npm'));
    env = { ...process.env, NODE_BIN: path.join(prefix, 'bin/node'), NPM_CLI: path.join(prefix, 'bin/npm'), SUDO_USER: '' };
  });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  function run(body = 'prepare_node_runtime "$2"') {
    return spawnSync('bash', ['-c', `set -euo pipefail\nsource "$1"\nresolve_node_runtime\n${body}`, '_', helper, runtime], {
      env, encoding: 'utf8', timeout: 10000,
    });
  }

  it('将 Node/npm 复制为独立 runtime，不改变个人目录权限', () => {
    const result = run();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe('11.19.0');
    expect(lstatSync(path.join(runtime, 'bin/node')).isSymbolicLink()).toBe(false);
    expect(lstatSync(path.join(runtime, 'lib/node_modules/npm/lib/version.js')).isSymbolicLink()).toBe(false);
    expect(readlinkSync(path.join(runtime, 'bin/npm'))).toBe('../lib/node_modules/npm/bin/npm-cli.js');
    expect(statSync(runtime).mode & 0o777).toBe(0o755);
    expect(statSync(path.join(runtime, 'bin/node')).mode & 0o777).toBe(0o755);
    expect(statSync(home).mode & 0o777).toBe(0o700);
  });

  it('原始安装目录移走后，复制的 node/npm/npx 仍可运行', () => {
    const prepared = run();
    expect(prepared.status, prepared.stderr).toBe(0);
    renameSync(home, `${home}-unavailable`);
    const options = { env: { ...process.env, PATH: `${runtime}/bin:/usr/bin:/bin` }, encoding: 'utf8' as const };
    expect(spawnSync(path.join(runtime, 'bin/node'), ['--version'], options).stdout).toMatch(/^v(?:24|[3-9]\d|2[5-9])\./);
    expect(spawnSync(path.join(runtime, 'bin/npm'), ['--version'], options).stdout.trim()).toBe('11.19.0');
    expect(spawnSync(path.join(runtime, 'bin/npx'), ['--version'], options).stdout.trim()).toBe('test-npx');
  });

  it('支持 /usr/bin 形式的链接，先解析再复制，不复制回家目录的链接', () => {
    const systemBin = path.join(root, 'system-bin');
    mkdirSync(systemBin);
    symlinkSync(path.join(prefix, 'bin/node'), path.join(systemBin, 'node'));
    symlinkSync(path.join(prefix, 'bin/npm'), path.join(systemBin, 'npm'));
    env.NODE_BIN = path.join(systemBin, 'node');
    env.NPM_CLI = path.join(systemBin, 'npm');
    const result = run();
    expect(result.status, result.stderr).toBe(0);
    expect(lstatSync(path.join(runtime, 'bin/node')).isSymbolicLink()).toBe(false);
    expect(existsSync(path.join(runtime, 'lib/node_modules/npm/bin/npm-cli.js'))).toBe(true);
  });

  it('sudo PATH 不含 nvm 时可从调用者的常规 nvm 目录发现 Node/npm，不读取 .bashrc', () => {
    const bin = path.join(root, 'tools');
    mkdirSync(bin);
    writeFileSync(path.join(bin, 'getent'), '#!/bin/sh\nprintf "fixture:x:1000:1000:fixture:%s:/bin/bash\\n" "$FIXTURE_HOME"\n', { mode: 0o755 });
    writeFileSync(path.join(home, '.bashrc'), 'exit 99\n');
    delete env.NODE_BIN; delete env.NPM_CLI;
    env.PATH = `${bin}:/usr/bin:/bin`;
    env.SUDO_USER = 'fixture'; env.FIXTURE_HOME = home;
    const result = run();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe('11.19.0');
  });

  it('拒绝不存在的显式 Node 路径，不隐式覆盖其他运行环境', () => {
    env.NODE_BIN = path.join(root, 'missing-node');
    const result = run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('未找到 Node');
    expect(existsSync(runtime)).toBe(false);
  });

  it('npm 非标准布局或包名不正确时明确失败', () => {
    const wrapper = path.join(prefix, 'bin/npm-wrapper');
    writeFileSync(wrapper, '#!/bin/sh\nexit 0\n');
    env.NPM_CLI = wrapper;
    expect(run().stderr).toContain('不是常规 npm-cli.js 布局');
    env.NPM_CLI = path.join(prefix, 'bin/npm');
    writeFileSync(path.join(npmRoot, 'package.json'), JSON.stringify({ name: 'not-npm' }));
    expect(run().stderr).toContain('不是 npm 包');
    expect(existsSync(runtime)).toBe(false);
  });

  it('拒绝覆盖已有 runtime，不修改已有 Node 文件', () => {
    mkdirSync(path.join(runtime, 'bin'), { recursive: true });
    writeFileSync(path.join(runtime, 'bin/node'), 'existing-runtime');
    const result = run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('拒绝覆盖');
    expect(readFileSync(path.join(runtime, 'bin/node'), 'utf8')).toBe('existing-runtime');
  });

  it('systemd 指向独立 runtime，并保留家目录隔离', () => {
    const service = readFileSync(fileURLToPath(new URL('../scripts/autodl-mcp.service', import.meta.url)), 'utf8');
    expect(service).toContain('ExecStart=/opt/autodl-pilot/runtime/bin/node ');
    expect(service).toContain('ProtectHome=true');
    expect(service).not.toContain('ExecStart=/usr/bin/node');
  });
});
