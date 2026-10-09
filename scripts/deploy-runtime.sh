#!/usr/bin/env bash
# 供部署脚本引用：只复制 Node 二进制和 npm 包，不放开用户家目录权限。

runtime_error() { printf '错误: %s\n' "$*" >&2; return 1; }

resolve_node_runtime() {
    local candidate sudo_home major
    NODE_SOURCE="${NODE_BIN:-}"
    if [[ -z "$NODE_SOURCE" && -n "${SUDO_USER:-}" ]]; then
        sudo_home=$(getent passwd "$SUDO_USER" | cut -d: -f6) || sudo_home=''
        # sudo 会清理 PATH；不执行用户的 .bashrc，只查找常规 nvm 安装。
        while IFS= read -r candidate; do
            [[ -x "$candidate" ]] || continue
            major=$(basename "$(dirname "$(dirname "$candidate")")")
            [[ "$major" =~ ^v([0-9]+)\. ]] || continue
            if (( 10#${BASH_REMATCH[1]} >= 24 )); then NODE_SOURCE="$candidate"; break; fi
        done < <(printf '%s\n' "$sudo_home"/.nvm/versions/node/*/bin/node | sort -Vr)
    fi
    if [[ -z "$NODE_SOURCE" ]]; then NODE_SOURCE=$(command -v node || true); fi
    [[ -n "$NODE_SOURCE" && -x "$NODE_SOURCE" ]] || {
        runtime_error '未找到 Node >=24；请显式传入 sudo env NODE_BIN="$(command -v node)" NPM_CLI="$(readlink -f "$(command -v npm)")" bash scripts/setup-remote.sh'
        return 1
    }
    NODE_SOURCE=$(readlink -f -- "$NODE_SOURCE")
    "$NODE_SOURCE" -e 'if (Number(process.versions.node.split(".")[0]) < 24) { console.error("需要 Node >=24，推荐 Node 24 LTS"); process.exit(1); }' || return 1

    NPM_SOURCE="${NPM_CLI:-}"
    if [[ -z "$NPM_SOURCE" ]]; then
        if [[ -e "$(dirname "$NODE_SOURCE")/npm" ]]; then
            NPM_SOURCE="$(dirname "$NODE_SOURCE")/npm"
        else
            NPM_SOURCE=$(command -v npm || true)
        fi
    fi
    [[ -n "$NPM_SOURCE" && -f "$NPM_SOURCE" ]] || { runtime_error '未找到 npm CLI，请使用 NPM_CLI 指定 npm-cli.js 的真实路径'; return 1; }
    NPM_SOURCE=$(readlink -f -- "$NPM_SOURCE")
    NPM_SOURCE_DIR=$(dirname "$(dirname "$NPM_SOURCE")")
    [[ "$NPM_SOURCE" == "$NPM_SOURCE_DIR/bin/npm-cli.js" && -f "$NPM_SOURCE_DIR/package.json" ]] || {
        runtime_error 'npm 不是常规 npm-cli.js 布局；请用 NPM_CLI 显式指定真实 npm-cli.js 路径'
        return 1
    }
    "$NODE_SOURCE" -e 'const fs = require("node:fs"); if (JSON.parse(fs.readFileSync(process.argv[1], "utf8")).name !== "npm") process.exit(1)' "$NPM_SOURCE_DIR/package.json" || {
        runtime_error '指定的目录不是 npm 包'
        return 1
    }
}

prepare_node_runtime() {
    local target="$1"
    [[ ! -L "$target" && ! -e "$target/bin/node" && ! -e "$target/lib/node_modules/npm" ]] || {
        runtime_error 'runtime staging 目录已存在安装文件，拒绝覆盖'
        return 1
    }
    install -d -m 755 "$target" "$target/bin" "$target/lib/node_modules"
    install -m 755 "$NODE_SOURCE" "$target/bin/node"
    # 解引用 npm 包中的链接，独立副本不能再依赖 /home 或 /root 下的文件。
    cp -RL -- "$NPM_SOURCE_DIR" "$target/lib/node_modules/npm"
    chmod -R u+rwX,go+rX,go-w "$target"
    ln -s ../lib/node_modules/npm/bin/npm-cli.js "$target/bin/npm"
    if [[ -f "$target/lib/node_modules/npm/bin/npx-cli.js" ]]; then
        ln -s ../lib/node_modules/npm/bin/npx-cli.js "$target/bin/npx"
    fi
    "$target/bin/node" "$target/lib/node_modules/npm/bin/npm-cli.js" --version
}
