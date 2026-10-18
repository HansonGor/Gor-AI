# Gor Runner（P0）

独立的沙箱执行服务：接收一份项目快照（`.tar.gz`），在**一次性、无网络、资源受限**的 Docker 容器中执行白名单内的 **git 只读命令**，返回输出。

P0 只是独立服务，**尚未接入 Gor Server 和 VS Code 插件**。

## 快速开始（PowerShell）

```powershell
cd D:\Gor\Runner
docker build -t gor-runner-git:latest D:\Gor\Runner\images\git
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
python -X utf8 -m pytest tests -q
python -X utf8 -m uvicorn app:app --host 127.0.0.1 --port 4000
```

如果 `docker build` 报 `git (no such package)`，通常是 Docker Desktop 内置代理拉取 Alpine 索引时偶发失败，可重试，或加 `--no-cache` 重建。

## 接口

| 接口 | 说明 |
| --- | --- |
| `GET /health` | 返回 `version`、`docker_reachable`、`image_present`；Docker 不可达时返回 503 + `DOCKER_UNAVAILABLE` |
| `POST /v1/runs` | multipart：`snapshot`（.tar.gz，≤50 MB）、`language`（仅 `git`）、`argv`（JSON 数组字符串）、`timeout_seconds`（1–120，默认 30） |
| `GET /v1/runs/{run_id}` | 本进程内最近 200 次运行的结果摘要（不含输出和快照），重启后清空 |

`POST /v1/runs` 成功返回：`run_id`、`exit_code`（超时为 null）、`stdout`、`stderr`、`stdout_truncated`、`stderr_truncated`、`timed_out`、`duration_ms`、`skipped_snapshot_entries`（最多 50 条）。

错误统一为 `{"error": {"code": "...", "message": "..."}}`：

| code | HTTP | 场景 |
| --- | --- | --- |
| `COMMAND_NOT_ALLOWED` | 403 | 命令不在白名单内，message 说明违反的规则 |
| `BAD_REQUEST` | 400 | language 不支持、argv 不是字符串数组、timeout 越界、缺少字段 |
| `SNAPSHOT_REJECTED` | 400 | 不是 .tar.gz、含绝对路径/`..`/链接/设备文件、无法解析 |
| `SNAPSHOT_TOO_LARGE` | 413 | 压缩后 >50 MB、解压后 >200 MB、成员 >20000 |
| `DOCKER_UNAVAILABLE` | 503 | Docker 不可达 |
| `IMAGE_MISSING` | 503 | 未构建 `gor-runner-git:latest` |
| `INTERNAL_ERROR` | 500 | 其他未预期错误（不回显异常详情） |

## 白名单（`policy.py`）

保守设计，未列出的子命令、选项和位置参数一律拒绝。

| 子命令 | 允许 |
| --- | --- |
| `status` | `--short` `-s` `--branch` `-b` `--porcelain` `--ignored` |
| `log` | `--oneline` `-n<数字>` `-<数字>` `--max-count=<数字>` `--stat` `--graph` `--format=<格式串>` `--all` |
| `diff` | `--stat` `--name-only` `--name-status` `--cached` `--staged` `-U<数字>`，路径只能放在 `--` 之后；自动追加 `--no-ext-diff --no-textconv` |
| `show` | `--oneline` `--format=<格式串>` `--stat` `--name-only` |
| `branch` | `-a` `-r` `-v` `--list` `--show-current`，不允许位置参数 |
| `rev-parse` | `--show-toplevel` `--abbrev-ref` `HEAD` `--is-inside-work-tree` |
| `ls-files` | `--cached` `--others` `--modified` `--stage` |
| `blame` | `-L<起>,<止>`（仅数字范围）`--porcelain`，必须带文件路径 |

全局规则：`argv[0]` 必须是 `git`；子命令前不得出现 `-c` `-C` `--git-dir` `--work-tree` `--exec-path` `--namespace`；参数不得含换行符或 NUL；任何位置不得出现 `--output` `-o` `--ext-diff` `--textconv` `--exec` `--upload-pack` `--receive-pack` `--no-index` `--open-files-in-pager`；路径不得是绝对路径、不得含 `..`、不得以 `-` 或 pathspec 魔法前缀 `:` 开头。

与任务原始清单的差异：`log` 额外允许 `-<数字>`。它是 git 对 `-n<数字>` 的简写，验收命令 `git log --oneline -3` 需要。

## 快照处理（`snapshot.py`）

- 只接受 gzip 压缩的 tar（按文件头魔数判断，文件名需为 `.tar.gz` / `.tgz`）。
- 按流式方式逐个检查成员：拒绝绝对路径、`..`、反斜杠路径、符号链接、硬链接、设备/FIFO 文件。成员数量和累计大小按 tar 头计算，超限立即拒绝，不会先解压完。
- 丢弃以下路径并记入 `skipped_snapshot_entries`：`node_modules/` `.venv/` `venv/` `dist/` `build/` `coverage/` `__pycache__/`（目录只记一条）、`.env` `.env.*`、文件名匹配 `*.pem` `*.key` `id_rsa*` `*secret*` `*credential*` 的文件（不区分大小写）。
- `.git/` 内部不按名称过滤：例如分支名 `build`、`secret-fix` 对应 `.git/refs/heads/...` 下的文件，丢弃会破坏仓库。同理，已经提交进 git 对象库的敏感内容也无法靠路径过滤去除。
- 过滤后重新打包为临时 tar（16 MB 以内放在内存，超过则落到系统临时目录，用完删除），所有者统一改为 `1000:1000`，去掉 setuid/setgid 位，并补齐父目录条目。
- 注意：被丢弃的**已跟踪**文件在容器里看起来是被删除的，`git status` 会显示为 `D`；被丢弃的未跟踪文件（如 `.env`）不会出现在 `??` 里。所以容器结果与宿主机直接执行可能不同。

## 容器隔离（`sandbox.py`）

每次运行新建容器，参数：`network_mode="none"`、`read_only=True`、`user="1000:1000"`、`mem_limit="512m"`、`nano_cpus=1e9`、`pids_limit=128`、`cap_drop=["ALL"]`、`security_opt=["no-new-privileges:true"]`、`working_dir="/work"`、固定环境变量（`HOME=/tmp`、`GIT_CONFIG_NOSYSTEM=1`、`GIT_CONFIG_GLOBAL=/dev/null`、`GIT_TERMINAL_PROMPT=0`、`LANG=C.UTF-8`）、标签 `gor-runner=1`。不挂载 Docker socket，也不挂载宿主机目录。

流程：`create` → `put_archive("/work")` → `start` → `wait(timeout)`，超时则 `kill` → 读取 stdout/stderr（各 64 KB 截断）→ `finally` 中执行 `remove(force=True, v=True)`。

**与任务原始要求的差异（已确认）**：任务要求 `/work` 用 tmpfs，但实测在 `read_only=True` 时，Docker 拒绝任何 `put_archive`（包括目标是 tmpfs，容器启动前后都一样），报错 `container rootfs is marked read-only`。因此：

- `/work` 改为 Docker 管理的**匿名卷**（不是宿主机目录），随容器 `remove(v=True)` 一起删除；
- `/tmp` 仍为 tmpfs（`rw,size=64m`）；
- 代价：`/work` 没有 512 MB 的 tmpfs 大小限制，只靠快照解压后 200 MB 的上限约束；卷数据落在 Docker Desktop 的 WSL2 虚拟磁盘上，而不是内存里。

## 残留容器清理（`sweeper.py`）

服务启动时和之后每 60 秒，列出带 `gor-runner=1` 标签的容器，删除创建时间超过 10 分钟的容器（连同匿名卷）。清理失败只记录日志。

## 配置（`config.py`，可用环境变量覆盖）

`GOR_RUNNER_PORT`、`GOR_RUNNER_IMAGE`、`GOR_RUNNER_DEFAULT_TIMEOUT`、`GOR_RUNNER_MAX_TIMEOUT`、`GOR_RUNNER_OUTPUT_LIMIT`、`GOR_RUNNER_SNAPSHOT_MAX_COMPRESSED`、`GOR_RUNNER_SNAPSHOT_MAX_UNCOMPRESSED`、`GOR_RUNNER_SNAPSHOT_MAX_MEMBERS`、`GOR_RUNNER_SWEEP_INTERVAL`、`GOR_RUNNER_SWEEP_MAX_AGE`。监听地址固定为 `127.0.0.1`，由启动命令的 `--host` 指定。

## 测试

| 文件 | 内容 | 是否需要 Docker |
| --- | --- | --- |
| `test_policy.py` | 允许组合、14 个禁止子命令、全局选项、危险参数、换行/NUL、branch 位置参数、路径规则 | 否 |
| `test_snapshot.py` | 绝对路径、`..`、链接、设备、超大、超数量、敏感/生成目录丢弃、重打包所有者 | 否 |
| `test_output_limits.py` | 64 KB 截断与 UTF-8 边界 | 否 |
| `test_sandbox_integration.py` | 容器参数核对；Docker 不可达返回 503；与宿主机 git 输出一致（status/log/diff）；无网络；只读根文件系统；3 秒超时；API 403；测试后无残留容器 | 部分需要，不可用时跳过 |

隔离测试使用测试文件内注入的策略（允许 `sh -c` 与 `sleep`），正式 `policy.py` 不包含它。

## 已知限制与未验证风险

- 仓库内 `.git/config` 由用户提供，可能设置 `core.fsmonitor` 等会在容器内执行程序的配置。容器无网络、只读根文件系统、非 root，但这类配置仍会在沙箱内执行。
- Windows 上 Docker Desktop 的 `put_archive` 性能和大快照（接近 200 MB）表现未测试。
- `/work` 改用匿名卷后，磁盘占用的实际上限没有在大快照下验证；`/tmp` 的 tmpfs 大小限制也未专门测试。
- 容器隔离只经过上述测试，**不代表已完成安全审计**。
- 白名单是保守设计，部分合法 git 用法（如 `git log <范围>`、`git show <提交>`、`git diff <提交>`）会被拒绝，需要按实际需求逐项放开。
