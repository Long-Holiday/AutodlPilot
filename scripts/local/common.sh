#!/usr/bin/env bash
# 仅供本机脚本引用；远程 MCP 不执行这些函数。
set -euo pipefail

fail() { printf '错误: %s\n' "$*" >&2; exit 1; }

validate_connection() {
    [[ "$HOST" =~ ^[a-zA-Z0-9][a-zA-Z0-9.-]*$ ]] || fail 'SSH_HOST 必须是主机名或 IPv4 地址'
    [[ "$PORT" =~ ^[0-9]{1,5}$ ]] && (( 10#$PORT >= 1 && 10#$PORT <= 65535 )) || fail 'SSH_PORT 必须在 1-65535 之间'
    [[ -f "$KEY_FILE" && -r "$KEY_FILE" ]] || fail '本机 SSH 私钥尚未配置，请先执行 ssh-init.sh 并安装公钥'
    command -v ssh >/dev/null || fail '请安装 OpenSSH client'
    SSH_OPTIONS=(-i "$KEY_FILE" -p "$PORT" -o BatchMode=yes -o IdentitiesOnly=yes
        -o ForwardAgent=no -o StrictHostKeyChecking=yes -o ConnectTimeout=5
        -o ServerAliveInterval=15 -o ServerAliveCountMax=2 -o LogLevel=ERROR)
}

shell_quote() {
    local escaped=${1//\'/\'\\\'\'}
    printf "'%s'" "$escaped"
}
