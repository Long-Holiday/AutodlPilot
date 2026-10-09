#!/usr/bin/env bash
# 在远程 Linux 服务器上显式运行；默认准备部署，不启动实例控制服务。
set -euo pipefail
[[ $# -eq 0 || ( $# -eq 1 && "$1" == '--start' ) ]] || { printf '用法: %s [--start]\n' "$0" >&2; exit 1; }
[[ $(id -u) -eq 0 ]] || { printf '请使用 sudo 运行部署脚本\n' >&2; exit 1; }
SOURCE_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
DEPLOY_DIR=/opt/autodl-pilot
SERVICE_USER=autodl-pilot
[[ -x /usr/bin/node && -x /usr/bin/npm ]] || { printf '请先安装系统级 Node 24 LTS 与 npm（/usr/bin），本脚本不执行远程安装脚本\n' >&2; exit 1; }
/usr/bin/node -e 'if (Number(process.versions.node.split(".")[0]) < 24) { console.error("需要 Node >=24，推荐 Node 24 LTS"); process.exit(1); }'
command -v runuser >/dev/null
command -v systemctl >/dev/null
if systemctl is-active --quiet autodl-mcp && [[ "${1:-}" != '--start' ]]; then
    printf '服务正在运行；请显式使用 --start 执行停止、更新及重启，或先手动停止服务\n' >&2
    exit 1
fi
[[ ! -L "$DEPLOY_DIR" ]] || { printf '部署目录不能是符号链接\n' >&2; exit 1; }
if ! id "$SERVICE_USER" >/dev/null 2>&1; then
    useradd --system --user-group --home-dir "$DEPLOY_DIR" --shell /usr/sbin/nologin "$SERVICE_USER"
fi

# 在独立 staging 目录构建，不复制 .env、数据库、.git 或本机密钥。
BUILD_DIR=$(mktemp -d /opt/autodl-pilot-build.XXXXXX)
cp -R "$SOURCE_DIR/src" "$SOURCE_DIR/package.json" "$SOURCE_DIR/package-lock.json" "$SOURCE_DIR/tsconfig.json" "$BUILD_DIR/"
chown -R "$SERVICE_USER:$SERVICE_USER" "$BUILD_DIR"
runuser -u "$SERVICE_USER" -- env HOME="$BUILD_DIR" PATH=/usr/bin:/bin npm_config_cache="$BUILD_DIR/.npm-cache" bash -c 'set -e; cd -- "$1"; /usr/bin/npm ci; /usr/bin/npm run build; /usr/bin/npm prune --omit=dev' _ "$BUILD_DIR"

if [[ "${1:-}" == '--start' ]] && systemctl is-active --quiet autodl-mcp; then
    systemctl stop autodl-mcp
fi
install -d -m 755 "$DEPLOY_DIR"
install -d -m 750 -o "$SERVICE_USER" -g "$SERVICE_USER" "$DEPLOY_DIR/data"
chown -R "$SERVICE_USER:$SERVICE_USER" "$DEPLOY_DIR/data"
# 保留上一版产物，避免不可恢复地覆盖；历史数据库和 .env 始终保留。
for DIR in dist node_modules; do
    if [[ -e "$DEPLOY_DIR/$DIR" ]]; then mv "$DEPLOY_DIR/$DIR" "$BUILD_DIR/previous-$DIR"; fi
    mv "$BUILD_DIR/$DIR" "$DEPLOY_DIR/$DIR"
    chown -R root:root "$DEPLOY_DIR/$DIR"
done
install -m 644 "$SOURCE_DIR/package.json" "$SOURCE_DIR/package-lock.json" "$SOURCE_DIR/.env.example" "$DEPLOY_DIR/"
if [[ ! -e "$DEPLOY_DIR/.env" ]]; then
    if [[ -f "$SOURCE_DIR/.env" ]]; then
        install -m 640 -g "$SERVICE_USER" "$SOURCE_DIR/.env" "$DEPLOY_DIR/.env"
    else
        install -m 640 -g "$SERVICE_USER" "$SOURCE_DIR/.env.example" "$DEPLOY_DIR/.env"
    fi
fi
chown "root:$SERVICE_USER" "$DEPLOY_DIR/.env"
chmod 640 "$DEPLOY_DIR/.env"
install -m 644 "$SOURCE_DIR/scripts/autodl-mcp.service" /etc/systemd/system/autodl-mcp.service
systemctl daemon-reload
printf '部署文件已准备；构建/旧产物保留于 %s，确认后可自行清理。\n' "$BUILD_DIR"

if [[ "${1:-}" == '--start' ]]; then
    runuser -u "$SERVICE_USER" -- /usr/bin/node --input-type=module -e '
      const { loadConfig } = await import("/opt/autodl-pilot/dist/config/index.js");
      const config = loadConfig();
      if (config.AUTODL_TOKEN.startsWith("your_") || config.MCP_AUTH_TOKEN.startsWith("your_")) {
        console.error("请先编辑部署项目 .env 填入真实凭据"); process.exit(1);
      }
    '
    systemctl enable autodl-mcp
    systemctl restart autodl-mcp
    systemctl is-active --quiet autodl-mcp
    printf '服务已启动。公网接入前请配置 HTTPS 反向代理，默认仅监听 127.0.0.1。\n'
else
    printf '未启动服务。请检查 %s/.env，然后执行 sudo systemctl enable --now autodl-mcp。\n' "$DEPLOY_DIR"
fi
