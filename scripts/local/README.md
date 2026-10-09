# 本机 Agent：SSH 与代码/实验流程

这些脚本只在**本机**由用户或 Agent 显式运行，远程 MCP 不执行它们。默认面向 Linux/WSL，需要 Bash、OpenSSH、Git，以及 GNU `timeout`（coreutils）。SSH 私钥绝不上传到 MCP 或 GPU 实例。

## 1. 先配置免密 SSH

目前项目不附带任何真实 SSH 密钥。首次使用前运行：

```bash
bash scripts/local/ssh-init.sh
```

脚本创建专用 `~/.ssh/id_ed25519_autodl`，不覆盖默认密钥，不修改 `~/.ssh/config`。生成时可设置 passphrase；供 Agent 无交互使用时先在本机执行 `ssh-add ~/.ssh/id_ed25519_autodl`。已有私钥但缺少 `.pub` 时，从私钥恢复公钥；已有公钥但没有私钥时拒绝覆盖。

通过 MCP 开机并查询到 `running` 后，从 `get_instance_info(include_connection=true)` 或可信 AutoDL 控制台获取 SSH host/port，先核实主机指纹，再在本机安装**公钥**：

```bash
ssh-copy-id -i ~/.ssh/id_ed25519_autodl.pub -p <SSH_PORT> root@<SSH_HOST>
```

首次安装可能需要输入实例密码；在自己的终端交互输入，不写入 prompt、MCP 或脚本。也可按平台提供的公钥管理/控制台终端操作，将公钥加入实例的 `/root/.ssh/authorized_keys`，但不要假定所有实例都会自动注入公钥。

本机确认一次可信主机密钥后，自动化脚本使用 `StrictHostKeyChecking=yes`。若指纹变化，先核实平台，**不自动清理 known_hosts，不关闭校验**。需要 SSH config 时可手动添加针对具体实例的 alias：

```sshconfig
Host autodl-experiment
    HostName <SSH_HOST>
    Port <SSH_PORT>
    User root
    IdentityFile ~/.ssh/id_ed25519_autodl
    IdentitiesOnly yes
    StrictHostKeyChecking yes
    ForwardAgent no
```

## 2. Agent 控制开机

1. 从用户 prompt 获取 `pro-...` 实例 ID，调用 `power_on_instance`。
2. GPU 不足时返回失败；只有此时根据用户意图调用 `retry_power_on_instance` 持续请求。
3. 查询任务或实例状态。网络超时/结果不确定时先查询状态，不盲目重复开机。
4. 实例 `running` 后获取安全 SSH 信息。MCP 不提供实例密码，也不代配置 SSH。

```bash
bash scripts/local/wait-for-ssh.sh <SSH_HOST> <SSH_PORT>
# 可显式指定密钥与总超时（秒）
bash scripts/local/wait-for-ssh.sh <SSH_HOST> <SSH_PORT> ~/.ssh/id_ed25519_autodl 120
```

探针测试的是实际免密认证，不仅是 TCP 端口。缺少私钥、公钥认证失败、主机密钥未确认分别报错；网络/SSHD 未就绪按总超时等待，单次 SSH 卡住也会结束。

## 3. 本机修改并推送代码，然后远端拉取/执行

代码仍在本机修改。先由用户授权或手动完成 commit/push；同步脚本**不**自动提交、推送或丢弃修改。然后在实验代码的本机 Git 仓库根目录运行（脚本路径可用绝对路径）：

```bash
bash /path/to/AutodlPilot/scripts/local/git-sync-run.sh \
  <SSH_HOST> <SSH_PORT> \
  https://github.com/your-org/experiment.git \
  /root/autodl-tmp/experiment \
  'python train.py --epochs 20'
```

脚本会：

- 要求本机是有效仓库、非 detached HEAD，工作区干净（包括未跟踪文件）。
- 查询指定仓库/同名分支的远端 tip，确认与本机 HEAD 相同，即该版本已推送。
- 通过本机密钥登录实例；仓库不存在时 clone 指定分支，否则检查 origin、分支和干净工作区。
- 执行 `git pull --ff-only`，校验远端 SHA 与本机 HEAD 完全一致，才执行传入的 bash 命令。
- 保留命令的输出和退出码，不自动 checkout/reset/force，不覆盖远端修改。

**默认命令前台执行**，不是隐含后台实验管理。需要防 SSH 断开的长任务时，明确传入你要运行的 `nohup`/`setsid` 命令。例如将日志放在仓库外，避免下次同步被未跟踪文件阻止：

```bash
# 作为 git-sync-run.sh 的 COMMAND 参数
'mkdir -p /root/autodl-tmp/logs && nohup python train.py > /root/autodl-tmp/logs/train.log 2>&1 < /dev/null &'
```

具体后台退出码/PID/日志监控由本机 Agent 通过 SSH 处理，MCP 不登记实验。若代码修改、依赖配置或日志写入仓库，使工作区不再干净，需要先审查处理；脚本不会替你丢弃文件。

### 私有仓库

本机推送凭据与实例拉取凭据是两套独立权限。实例上的 Git 可使用**只读 Deploy Key**或已配置的 credential helper；部署密钥与登录实例的本机私钥分开管理。脚本默认禁止 Agent Forwarding，不接受 `GIT_AUTH_TOKEN`，拒绝带凭据/query 的 HTTPS URL，避免 token 落到实例 `.git/config`、日志或进程参数。

支持无凭据 `https://host/org/repo.git` 或 `git@host:org/repo.git`。使用 SSH Git URL 时，实例上也需要核实仓库服务的主机指纹和读取权限。

## 4. 查询实验进度与关机

Agent 在本机用 SSH 查询日志和进程；确认要停止实例后调用 MCP `power_off_instance`。关机会取消关联的持续任务；单独调用 `cancel_power_on_task` **不会**关机。

关机 API 接受不等于实例已经停止，随后用 `get_instance_info` 核实。取消不能撤回平台已收到的开机请求，异常情况下按实际状态再次显式关机。
