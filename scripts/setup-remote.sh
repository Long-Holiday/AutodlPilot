#!/usr/bin/env bash
# ==============================================================================
# AutoDL Pilot 远程服务器一键部署脚本
# ==============================================================================

set -euo pipefail

DEPLOY_DIR="/opt/autodl-pilot"
SERVICE_NAME="autodl-mcp"

echo "=========================================================="
echo "  AutoDL Pilot MCP 远程服务器自动化部署"
echo "=========================================================="

if [ "$(id -u)" -ne 0 ]; then
    echo "❌ 错误: 请使用 sudo 或 root 权限执行此部署脚本"
    exit 1
fi

echo "📦 1. 检查基础环境..."
if ! command -v node >/dev/null 2>&1; then
    echo "⬇️  安装 Node.js LTS (v22+)..."
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
    apt-get install -y nodejs build-essential
fi

echo "Node 版本: $(node -v)"
echo "NPM 版本:  $(npm -v)"

echo "📂 2. 同步项目源码到 ${DEPLOY_DIR}..."
mkdir -p "${DEPLOY_DIR}"
cp -r . "${DEPLOY_DIR}/"

cd "${DEPLOY_DIR}"

echo "📥 3. 安装依赖与编译 TypeScript..."
npm install --production=false
npm run build
npm prune --production

echo "⚙️  4. 检查 .env 配置文件..."
if [ ! -f "${DEPLOY_DIR}/.env" ]; then
    cp "${DEPLOY_DIR}/.env.example" "${DEPLOY_DIR}/.env"
    echo "⚠️  已生成初始 .env，请编辑 ${DEPLOY_DIR}/.env 填入真实的 AUTODL_TOKEN 与 MCP_AUTH_TOKEN"
fi

echo "🛠️ 5. 配置 systemd 系统服务..."
cp "${DEPLOY_DIR}/scripts/autodl-mcp.service" "/etc/systemd/system/${SERVICE_NAME}.service"
systemctl daemon-reload
systemctl enable "${SERVICE_NAME}"
systemctl restart "${SERVICE_NAME}"

echo ""
echo "=========================================================="
echo "🎉 部署完成！服务当前运行状态："
echo "=========================================================="
systemctl status "${SERVICE_NAME}" --no-pager || true
echo ""
echo "常用维护命令："
echo "  查看日志: journalctl -u ${SERVICE_NAME} -f"
echo "  重启服务: systemctl restart ${SERVICE_NAME}"
echo "  停止服务: systemctl stop ${SERVICE_NAME}"
