#!/usr/bin/env bash
# 本机确认已 push 的版本，再通过 SSH pull --ff-only 并执行明确给定的命令。
set -euo pipefail
SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
source "$SCRIPT_DIR/common.sh"
[[ $# -ge 5 && $# -le 6 ]] || fail "用法: $0 <SSH_HOST> <SSH_PORT> <REPO_URL> <REMOTE_DIR> <COMMAND> [KEY_FILE]"
HOST="$1"
PORT="$2"
REPO_URL="$3"
TARGET_DIR="$4"
REMOTE_CMD="$5"
KEY_FILE="${6:-${HOME}/.ssh/id_ed25519_autodl}"
validate_connection
[[ -n "$REMOTE_CMD" ]] || fail '必须明确指定要执行的命令'
[[ "$TARGET_DIR" == /* && "$TARGET_DIR" != '/' ]] || fail 'REMOTE_DIR 必须是非根目录的绝对路径'
[[ -z "${GIT_AUTH_TOKEN:-}" ]] || fail '不接收 GIT_AUTH_TOKEN；请为实例配置只读 Deploy Key 或 credential helper'
if [[ "$REPO_URL" =~ ^https://[^/]+/.+ ]]; then
    [[ ! "$REPO_URL" =~ ^https://[^/]*@ && "$REPO_URL" != *'?'* && "$REPO_URL" != *'#'* ]] || fail '仓库 URL 不得包含凭据、query 或 fragment'
elif [[ ! "$REPO_URL" =~ ^git@[a-zA-Z0-9.-]+:[^[:space:]]+$ ]]; then
    fail 'REPO_URL 仅支持无凭据 HTTPS 或 git@host:repo SSH 地址'
fi
export GIT_TERMINAL_PROMPT=0
command -v git >/dev/null || fail '请安装 Git'
git rev-parse --show-toplevel >/dev/null 2>&1 || fail '当前目录不是有效的本机 Git 仓库'
[[ -z "$(git status --porcelain)" ]] || fail '本机仓库有未提交修改或未跟踪文件，请先审查并 commit/push'
LOCAL_SHA=$(git rev-parse --verify HEAD)
BRANCH=$(git symbolic-ref --quiet --short HEAD) || fail '本机为 detached HEAD，请明确切换到已推送的分支'
PUSHED=$(git ls-remote --exit-code "$REPO_URL" "refs/heads/$BRANCH") || fail '目标远端分支不存在或无读取权限'
read -r PUSHED_SHA _ <<< "$PUSHED"
[[ "$PUSHED_SHA" == "$LOCAL_SHA" ]] || fail '本机 HEAD 不是目标远端分支最新提交，请先 push 或审查分支差异'

REMOTE_SCRIPT_COMMAND='bash -s --'
for ARG in "$REPO_URL" "$TARGET_DIR" "$BRANCH" "$LOCAL_SHA" "$REMOTE_CMD"; do
    REMOTE_SCRIPT_COMMAND+=" $(shell_quote "$ARG")"
done
ssh "${SSH_OPTIONS[@]}" "root@${HOST}" "$REMOTE_SCRIPT_COMMAND" <<'REMOTE'
set -euo pipefail
export GIT_TERMINAL_PROMPT=0
repo_url="$1"
target_dir="$2"
branch="$3"
expected_sha="$4"
run_command="$5"
if [[ ! -e "$target_dir/.git" ]]; then
    mkdir -p -- "$(dirname -- "$target_dir")"
    git clone --branch "$branch" --single-branch -- "$repo_url" "$target_dir"
fi
cd -- "$target_dir"
[[ "$(git rev-parse --show-toplevel)" == "$(pwd -P)" ]] || { printf '远端目录不是仓库根目录\n' >&2; exit 1; }
[[ "$(git remote get-url origin)" == "$repo_url" ]] || { printf '远端 origin 与目标仓库不一致\n' >&2; exit 1; }
[[ -z "$(git status --porcelain)" ]] || { printf '远端有未提交修改或未跟踪文件，不覆盖\n' >&2; exit 1; }
[[ "$(git symbolic-ref --quiet --short HEAD)" == "$branch" ]] || { printf '远端分支不一致，不自动切换\n' >&2; exit 1; }
git pull --ff-only origin "$branch"
[[ "$(git rev-parse --verify HEAD)" == "$expected_sha" ]] || { printf '远端 SHA 不匹配，不执行实验\n' >&2; exit 1; }
printf '版本校验通过: %s；开始执行指定命令\n' "$expected_sha"
exec bash -c "$run_command" </dev/null
REMOTE
