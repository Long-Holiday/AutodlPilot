#!/usr/bin/env bash
# ==============================================================================
# AutoDL SSH 免密登录初始化脚本（本地 Agent / 用户执行）
# 功能：
# 1. 在本地生成独立的 Ed25519 密钥对（不影响现有的 ~/.ssh/id_rsa 等默认密钥）
# 2. 设置安全的 SSH 目录与私钥权限 (0700 / 0600)
# 3. 提供 AutoDL 控制台公钥配置说明
# 4. 生成或更新本地 ~/.ssh/config 针对 AutoDL 代理节点的连接参数
# ==============================================================================

set -euo pipefail

KEY_FILE="${HOME}/.ssh/id_ed25519_autodl"
CONFIG_FILE="${HOME}/.ssh/config"

echo "=========================================================="
echo "  AutoDL 独立 SSH 免密登录环境初始化"
echo "=========================================================="

mkdir -p "${HOME}/.ssh"
chmod 700 "${HOME}/.ssh"

# 1. 生成独立 Ed25519 密钥对
if [ -f "${KEY_FILE}" ]; then
    echo "ℹ️  检测到已存在专属密钥: ${KEY_FILE}，跳过生成。"
else
    echo "🔑 正在生成独立的 Ed25519 SSH 密钥对..."
    ssh-keygen -t ed25519 -C "autodl-pilot-agent-$(date +%Y%m%d)" -f "${KEY_FILE}" -N ""
    echo "✅ 密钥生成成功: ${KEY_FILE}"
fi

chmod 600 "${KEY_FILE}"
chmod 644 "${KEY_FILE}.pub"

# 2. 打印公钥内容
echo ""
echo "=========================================================="
echo "📋 请复制以下公钥内容并配置到 AutoDL 控制台："
echo "=========================================================="
cat "${KEY_FILE}.pub"
echo "=========================================================="
echo "操作路径: 打开浏览器访问 https://www.autodl.com"
echo "        -> 控制台中心 -> 账号设置 -> SSH公钥 -> 点击「添加公钥」"
echo "说明: 添加为全局公钥后，所有新启动的容器实例都会自动注入此公钥进行免密登录。"
echo ""

# 3. 配置 ~/.ssh/config 针对 AutoDL 的连接模板
touch "${CONFIG_FILE}"
chmod 600 "${CONFIG_FILE}"

if grep -q "Host \*.autodl.com" "${CONFIG_FILE}" 2>/dev/null; then
    echo "ℹ️  ~/.ssh/config 中已存在 AutoDL 节点的通配配置，跳过追加。"
else
    echo "⚙️  正在将 AutoDL 节点的安全配置追加到 ~/.ssh/config..."
    cat << 'EOF' >> "${CONFIG_FILE}"

# --- AutoDL GPU Instances Configuration ---
Host *.autodl.com connect.*.autodl.com
    User root
    IdentityFile ~/.ssh/id_ed25519_autodl
    IdentitiesOnly yes
    # 自动信任并记录新节点 Host Key，避免交互式确认卡住 AI Agent
    StrictHostKeyChecking accept-new
    # 连接心跳保活，防止网络闲置断开
    ServerAliveInterval 30
    ServerAliveCountMax 5
    # 关闭 X11 转发与 GSSAPI 鉴权加速握手
    ForwardX11 no
    GSSAPIAuthentication no
EOF
    echo "✅ ~/.ssh/config 配置完成。"
fi

echo ""
echo "🎉 本地 SSH 初始化全部完成！"
