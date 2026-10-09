import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scripts = fileURLToPath(new URL('../scripts/local/', import.meta.url));

describe('本机 SSH/Git 辅助脚本（替身命令，不接触真实 SSH 或仓库）', () => {
  let root: string;
  let bin: string;
  let local: string;
  let remote: string;
  let key: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'autodl-local-test-'));
    bin = path.join(root, 'bin'); local = path.join(root, 'local'); remote = path.join(root, "remote's workspace");
    mkdirSync(bin); mkdirSync(local); mkdirSync(path.join(remote, '.git'), { recursive: true });
    key = path.join(root, 'test-key'); writeFileSync(key, 'dummy-private-key');
    env = {
      ...process.env, HOME: path.join(root, 'home'), PATH: `${bin}:${process.env.PATH}`,
      GIT_AUTH_TOKEN: '', REPO_URL: 'https://example.invalid/owner/repo.git',
      LOCAL_SHA: 'fixture-sha', REMOTE_SHA: 'fixture-sha', PUSHED_SHA: 'fixture-sha',
      REMOTE_DIR: remote, SSH_MODE: '', LOCAL_DIRTY: '', REMOTE_DIRTY: '',
    };
    writeFileSync(path.join(bin, 'git'), `#!/usr/bin/env bash
set -euo pipefail
case "$1 $2" in
  'rev-parse --show-toplevel') pwd -P ;;
  'rev-parse --verify') if [[ "$PWD" == "$REMOTE_DIR" ]]; then printf '%s\\n' "$REMOTE_SHA"; else printf '%s\\n' "$LOCAL_SHA"; fi ;;
  'status --porcelain') if [[ "$PWD" == "$REMOTE_DIR" ]]; then printf '%s' "$REMOTE_DIRTY"; else printf '%s' "$LOCAL_DIRTY"; fi ;;
  'symbolic-ref --quiet') printf 'main\\n' ;;
  'ls-remote --exit-code') printf '%s\\trefs/heads/main\\n' "$PUSHED_SHA" ;;
  'remote get-url') printf '%s\\n' "$REPO_URL" ;;
  'pull --ff-only') printf 'pull --ff-only\\n' > "$REMOTE_DIR/pull-marker" ;;
  'clone --branch') mkdir -p -- "\${!#}/.git" ;;
  *) printf 'unexpected git args\\n' >&2; exit 90 ;;
esac
`, { mode: 0o755 });
    writeFileSync(path.join(bin, 'ssh'), `#!/usr/bin/env bash
set -euo pipefail
case "$SSH_MODE" in
  deny) printf 'Permission denied (publickey)\\n' >&2; exit 255 ;;
  hostkey) printf 'Host key verification failed\\n' >&2; exit 255 ;;
  hang) sleep 10; exit 1 ;;
esac
if [[ "\${!#}" == 'true' ]]; then exit 0; fi
exec bash -c "\${!#}"
`, { mode: 0o755 });
    writeFileSync(path.join(bin, 'ssh-keygen'), `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == '-y' ]]; then printf 'dummy-restored-public\\n'; exit 0; fi
while [[ $# -gt 0 ]]; do
  if [[ "$1" == '-f' ]]; then key="$2"; break; fi
  shift
done
printf 'dummy-generated-private' > "$key"
printf 'dummy-generated-public\\n' > "$key.pub"
`, { mode: 0o755 });
  });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  function run(script: string, args: string[] = []) {
    return spawnSync('bash', [path.join(scripts, script), ...args], { cwd: local, env, encoding: 'utf8', timeout: 4000 });
  }
  function sync(command = "printf 'training ready' > 'result file.txt'", url = env.REPO_URL!) {
    return run('git-sync-run.sh', ['connect.example.autodl.com', '34222', url, remote, command, key]);
  }

  it('真正执行命令，正确引用含单引号的路径并传播退出码', () => {
    const result = sync("printf '%s' 'training ready' > 'result file.txt'; exit 7");
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(7);
    expect(readFileSync(path.join(remote, 'result file.txt'), 'utf8')).toBe('training ready');
    expect(readFileSync(path.join(remote, 'pull-marker'), 'utf8')).toContain('--ff-only');
  });

  it('本机未推送、存在未跟踪文件、远端 SHA 不一致均不执行实验', () => {
    env.PUSHED_SHA = 'not-pushed';
    expect(sync().status).toBe(1);
    env.PUSHED_SHA = env.LOCAL_SHA; env.LOCAL_DIRTY = '?? untracked.py';
    expect(sync().status).toBe(1);
    env.LOCAL_DIRTY = ''; env.REMOTE_SHA = 'wrong-sha';
    expect(sync().status).toBe(1);
    expect(existsSync(path.join(remote, 'result file.txt'))).toBe(false);
  });

  it('不覆盖远端修改，不使用带凭据的 URL 或 GIT_AUTH_TOKEN', () => {
    env.REMOTE_DIRTY = ' M train.py';
    expect(sync().status).toBe(1);
    env.REMOTE_DIRTY = '';
    expect(sync(undefined, 'https://secret@example.invalid/repo.git').status).toBe(1);
    expect(sync(undefined, 'https://example.invalid/repo.git?token=secret').status).toBe(1);
    env.GIT_AUTH_TOKEN = 'must-not-be-injected';
    expect(sync().stderr).toContain('不接收 GIT_AUTH_TOKEN');
    expect(existsSync(path.join(remote, 'result file.txt'))).toBe(false);
  });

  it('缺少本机密钥立即提示配置，不当作等待 GPU/SSH 启动', () => {
    const result = run('wait-for-ssh.sh', ['connect.example.autodl.com', '34222', path.join(root, 'missing-key'), '1']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('私钥尚未配置');
  });

  it('公钥认证失败、主机密钥失败各有明确提示', () => {
    env.SSH_MODE = 'deny';
    expect(run('wait-for-ssh.sh', ['host.example', '22', key, '1']).stderr).toContain('公钥认证失败');
    env.SSH_MODE = 'hostkey';
    expect(run('wait-for-ssh.sh', ['host.example', '22', key, '1']).stderr).toContain('主机密钥');
  });

  it('就绪检查能够成功；远端协议卡住也有有界总超时', () => {
    expect(run('wait-for-ssh.sh', ['host.example', '22', key, '1']).status).toBe(0);
    env.SSH_MODE = 'hang';
    const result = run('wait-for-ssh.sh', ['host.example', '22', key, '1']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('等待 SSH 超时');
    expect(result.error).toBeUndefined();
  });

  it('拒绝恶意主机、非法端口和参数，避免 SSH 参数注入', () => {
    expect(run('wait-for-ssh.sh', ['-oProxyCommand=bad', '22', key]).status).toBe(1);
    expect(run('wait-for-ssh.sh', ['host.example', '0', key]).status).toBe(1);
    expect(run('wait-for-ssh.sh', ['host.example', '99999', key]).status).toBe(1);
  });

  it('密钥初始化保留现有配置/私钥，并能从已有私钥恢复缺失公钥', () => {
    mkdirSync(path.join(env.HOME!, '.ssh'), { recursive: true });
    const config = path.join(env.HOME!, '.ssh/config');
    writeFileSync(config, 'existing-user-config');
    expect(run('ssh-init.sh', [key]).status).toBe(0);
    expect(readFileSync(key, 'utf8')).toBe('dummy-private-key');
    expect(readFileSync(`${key}.pub`, 'utf8')).toContain('dummy-restored-public');
    expect(readFileSync(config, 'utf8')).toBe('existing-user-config');
    expect(statSync(key).mode & 0o777).toBe(0o600);
  });

  it('使用替身生成专用密钥，不修改默认用户配置', () => {
    expect(run('ssh-init.sh').status).toBe(0);
    const generated = path.join(env.HOME!, '.ssh/id_ed25519_autodl');
    expect(readFileSync(generated, 'utf8')).toBe('dummy-generated-private');
    expect(existsSync(path.join(env.HOME!, '.ssh/config'))).toBe(false);
  });
});
