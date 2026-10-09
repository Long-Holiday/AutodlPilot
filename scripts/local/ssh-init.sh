#!/usr/bin/env bash
# 本机显式执行才会生成密钥；不修改现有 ~/.ssh/config，不上传私钥。
set -euo pipefail
umask 077
KEY_FILE="${1:-${HOME}/.ssh/id_ed25519_autodl}"
[[ $# -le 1 ]] || { printf '用法: %s [KEY_FILE]\n' "$0" >&2; exit 1; }
[[ ! -L "$KEY_FILE" && ! -L "${KEY_FILE}.pub" ]] || { printf '拒绝使用符号链接密钥路径\n' >&2; exit 1; }
mkdir -p "$(dirname "$KEY_FILE")"
if [[ "$(dirname "$KEY_FILE")" == "${HOME}/.ssh" ]]; then chmod 700 "${HOME}/.ssh"; fi

if [[ -f "$KEY_FILE" ]]; then
    printf '保留现有专用私钥: %s\n' "$KEY_FILE"
else
    [[ ! -e "${KEY_FILE}.pub" ]] || { printf '仅存在公钥，先找回私钥或使用其他路径，避免覆盖\n' >&2; exit 1; }
    # 由用户交互选择 passphrase；自动化时可用本机 ssh-agent 解锁。
    ssh-keygen -t ed25519 -C 'autodl-pilot-local' -f "$KEY_FILE"
fi
if [[ ! -f "${KEY_FILE}.pub" ]]; then
    PUBLIC_KEY=$(ssh-keygen -y -f "$KEY_FILE")
    printf '%s\n' "$PUBLIC_KEY" > "${KEY_FILE}.pub"
fi
chmod 600 "$KEY_FILE"
chmod 644 "${KEY_FILE}.pub"
printf '\n仅将以下公钥安装到 AutoDL，绝不上传私钥:\n%s\n' "$(< "${KEY_FILE}.pub")"
printf '\n实例开机后，在本机执行（先从可信控制台核对主机指纹）:\n'
printf 'ssh-copy-id -i %q -p <SSH_PORT> root@<SSH_HOST>\n' "${KEY_FILE}.pub"
printf '首次安装公钥可能需要输入实例密码；不要将密码写入 MCP、脚本或 prompt。\n'
printf '若平台提供公钥管理，也可手动配置；请实际验证实例是否已安装公钥。\n'
printf '本脚本未修改 ~/.ssh/config；后续脚本显式指定此私钥。\n'
