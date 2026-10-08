#!/usr/bin/env bash
# ==============================================================================
# AutoDL 代码同步与实验远程执行脚本（本地 Agent 执行）
# 流程：
# 1. 检查本地未提交代码，强制要求已 Commit 并已 Push 到远端仓库
# 2. 获取当前本地提交 SHA (git rev-parse HEAD)
# 3. 登录 AutoDL 实例拉取代码并强制检出对应 SHA，确保远程与本地严格一致
# 4. 支持私有仓库凭证注入（环境变量 GIT_AUTH_TOKEN 或 Deploy Key）
# 5. 后台安全运行实验命令，防止 SSH 中断导致训练退出
# ==============================================================================

set -euo pipefail

HOST="${1:-}"
PORT="${2:-}"
REPO_URL="${3:-}"
TARGET_DIR="${4:-/root/autodl-tmp/workspace}"
REMOTE_CMD="${5:-}"
KEY_FILE="${6:-${HOME}/.ssh/id_ed25519_autodl}"

if [ -z "${HOST}" ] || [ -z "${PORT}" ] || [ -z "${REPO_URL}" ] || [ -z "${REMOTE_CMD}" ]; then
    echo "❌ 参数缺失"
    echo "用法: $0 <SSH_HOST> <SSH_PORT> <GIT_REPO_URL> <REMOTE_DIR> <COMMAND> [KEY_FILE]"
    echo "示例: $0 connect.xxx.autodl.com 34222 https://github.com/my/project.git /root/autodl-tmp/myproj 'python train.py'"
    exit 1
fi

# 1. 校验本地 Git 状态
echo "🔍 检查本地 Git 仓库状态..."
if ! git diff-index --quiet HEAD -- 2>/dev/null; then
    echo "⚠️  警告: 本地工作区存在未提交的修改！为了确保实验版本可复现，请先 git commit 并 git push。"
    read -p "是否仍然继续？(y/N): " confirm
    if [[ "${confirm}" != "y" && "${confirm}" != "Y" ]]; then
        exit 1
    fi
fi

LOCAL_SHA=$(git rev-parse HEAD 2>/dev/null || echo "UNKNOWN_COMMIT")
echo "📌 本地当前执行版本 Commit SHA: ${LOCAL_SHA}"

# 2. 私有仓库 URL 兼容处理 (若配置了 GIT_AUTH_TOKEN，自动转为带 token 的 HTTPS 认证)
AUTHED_REPO_URL="${REPO_URL}"
if [ -n "${GIT_AUTH_TOKEN:-}" ]; then
    if [[ "${REPO_URL}" =~ ^https://github\.com/ ]]; then
        AUTHED_REPO_URL="https://x-access-token:${GIT_AUTH_TOKEN}@${REPO_URL#https://}"
        echo "🔒 已注入只读 GitHub Token 访问私有仓库"
    elif [[ "${REPO_URL}" =~ ^https://gitee\.com/ ]]; then
        AUTHED_REPO_URL="https://oauth2:${GIT_AUTH_TOKEN}@${REPO_URL#https://}"
        echo "🔒 已注入只读 Gitee Token 访问私有仓库"
    fi
fi

# 3. 构造远端执行脚本
REMOTE_SCRIPT=$(cat << EOF
set -e
mkdir -p "\$(dirname "${TARGET_DIR}")"

# 检查仓库目录是否存在，不存在则 clone，存在则更新
if [ ! -d "${TARGET_DIR}/.git" ]; then
    echo "📥 正在克隆仓库到 ${TARGET_DIR}..."
    git clone "${AUTHED_REPO_URL}" "${TARGET_DIR}"
fi

cd "${TARGET_DIR}"
echo "🔄 正在同步远端分支..."
git fetch origin

if [ "${LOCAL_SHA}" != "UNKNOWN_COMMIT" ]; then
    echo "🔀 正在检出指定提交: ${LOCAL_SHA}..."
    git checkout -q "${LOCAL_SHA}"
    REMOTE_CURR_SHA=\$(git rev-parse HEAD)
    if [ "\${REMOTE_CURR_SHA}" != "${LOCAL_SHA}" ]; then
        echo "❌ 远端版本与本地不匹配: 本地 ${LOCAL_SHA} vs 远端 \${REMOTE_CURR_SHA}"
        exit 1
    fi
    echo "✅ 远端代码版本一致性校验通过: \${REMOTE_CURR_SHA}"
fi
EOF
)

echo "🚀 正在通过 SSH 登录 AutoDL 实例并同步代码仓库..."
ssh -i "${KEY_FILE}" \
    -p "${PORT}" \
    -o BatchMode=yes \
    -o StrictHostKeyChecking=accept-new \
    "root@${HOST}" \
    "bash -c '${REMOTE_SCRIPT}'"

echo "🎉 代码同步成功，准备执行实验任务: ${REMOTE_CMD}"
