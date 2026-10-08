#!/usr/bin/env bash
# ==============================================================================
# AutoDL 实例 SSH 就绪探针脚本（本地 Agent 执行）
# 功能：
# 轮询探测 AutoDL 实例的 SSH 端口及免密登录是否完全就绪
# ==============================================================================

set -euo pipefail

HOST="${1:-}"
PORT="${2:-}"
KEY_FILE="${3:-${HOME}/.ssh/id_ed25519_autodl}"
TIMEOUT_SEC="${4:-120}"

if [ -z "${HOST}" ] || [ -z "${PORT}" ]; then
    echo "❌ 错误: 参数缺失"
    echo "用法: $0 <SSH_HOST> <SSH_PORT> [KEY_FILE] [TIMEOUT_SEC]"
    echo "示例: $0 connect.westb.seetacloud.com 34222 ~/.ssh/id_ed25519_autodl 120"
    exit 1
fi

echo "🔍 开始探测实例 SSH 就绪状态: root@${HOST}:${PORT} (最长等待 ${TIMEOUT_SEC} 秒)..."

START_TIME=$(date +%s)

while true; do
    CURRENT_TIME=$(date +%s)
    ELAPSED=$((CURRENT_TIME - START_TIME))

    if [ "${ELAPSED}" -ge "${TIMEOUT_SEC}" ]; then
        echo "❌ 等待超时 (${TIMEOUT_SEC}s): 无法在规定时间内建立 SSH 连接"
        exit 1
    fi

    # 1. 网络层与端口连通性检查 (尝试使用 nc，若无则尝试 /dev/tcp)
    PORT_OPEN=0
    if command -v nc >/dev/null 2>&1; then
        if nc -z -w 2 "${HOST}" "${PORT}" 2>/dev/null; then
            PORT_OPEN=1
        fi
    elif timeout 2 bash -c "cat < /dev/null > /dev/tcp/${HOST}/${PORT}" 2>/dev/null; then
        PORT_OPEN=1
    fi

    if [ "${PORT_OPEN}" -eq 1 ]; then
        # 2. SSH 协议层与密钥免密鉴权测试
        # -o BatchMode=yes 禁止密码弹窗
        # -o StrictHostKeyChecking=accept-new 自动信任新主机公钥
        # -o ConnectTimeout=4 单次连接超时
        if ssh -i "${KEY_FILE}" \
               -p "${PORT}" \
               -o BatchMode=yes \
               -o StrictHostKeyChecking=accept-new \
               -o ConnectTimeout=4 \
               -o LogLevel=ERROR \
               "root@${HOST}" "echo __AUTODL_SSH_READY__" 2>/dev/null | grep -q "__AUTODL_SSH_READY__"; then
            echo "✅ SSH 免密连接已成功就绪！(耗时 ${ELAPSED} 秒)"
            exit 0
        fi
    fi

    echo "⏳ [${ELAPSED}/${TIMEOUT_SEC}s] 等待 SSHD 启动并加载公钥中..."
    sleep 3
done
