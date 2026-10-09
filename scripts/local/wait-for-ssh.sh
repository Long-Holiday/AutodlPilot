#!/usr/bin/env bash
# 本机验证免密 SSH 就绪；未配置密钥和主机密钥错误不当作启动延迟。
set -euo pipefail
SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
source "$SCRIPT_DIR/common.sh"
[[ $# -ge 2 && $# -le 4 ]] || fail "用法: $0 <SSH_HOST> <SSH_PORT> [KEY_FILE] [TIMEOUT_SEC]"
HOST="$1"
PORT="$2"
KEY_FILE="${3:-${HOME}/.ssh/id_ed25519_autodl}"
TIMEOUT_SEC="${4:-120}"
[[ "$TIMEOUT_SEC" =~ ^[1-9][0-9]{0,4}$ ]] || fail 'TIMEOUT_SEC 必须是 1-99999 的整数'
validate_connection
command -v timeout >/dev/null || fail '请安装 GNU coreutils 的 timeout（本脚本支持 Linux/WSL）'
DEADLINE=$((SECONDS + TIMEOUT_SEC))

while (( SECONDS < DEADLINE )); do
    REMAINING=$((DEADLINE - SECONDS))
    ATTEMPT_LIMIT=$((REMAINING < 8 ? REMAINING : 8))
    if OUTPUT=$(timeout --signal=TERM --kill-after=1 "${ATTEMPT_LIMIT}s" ssh "${SSH_OPTIONS[@]}" "root@${HOST}" true 2>&1); then
        printf 'SSH 免密登录已就绪: %s:%s\n' "$HOST" "$PORT"
        exit 0
    fi
    if [[ "$OUTPUT" == *'Permission denied'* ]]; then
        fail 'SSH 公钥认证失败：检查实例 authorized_keys、私钥及本机 ssh-agent'
    fi
    if [[ "$OUTPUT" == *'Host key verification failed'* || "$OUTPUT" == *'REMOTE HOST IDENTIFICATION HAS CHANGED'* ]]; then
        fail 'SSH 主机密钥未确认或已变化：先核实平台指纹，不自动删除 known_hosts'
    fi
    REMAINING=$((DEADLINE - SECONDS))
    (( REMAINING > 0 )) || break
    sleep "$((REMAINING < 2 ? REMAINING : 2))"
done
fail "等待 SSH 超时 (${TIMEOUT_SEC}s)，尚未执行任何实验命令"
