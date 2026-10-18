"""在一次性 Docker 容器中执行已校验的命令。

隔离参数：无网络、只读根文件系统、非 root 用户、丢弃全部 capability、禁止提权、
内存/CPU/进程数限制。不挂载 Docker socket，也不挂载宿主机目录。

快照投放：Docker 拒绝向 read_only 容器 put_archive（包括目标是 tmpfs 的情况，
实测返回 "container rootfs is marked read-only"），因此 /work 使用 Docker 管理的匿名卷
（不是宿主机目录），put_archive 写入该卷；容器删除时以 v=True 一并删除卷。/tmp 仍为 tmpfs。
"""

from __future__ import annotations

import time
import uuid
from dataclasses import dataclass, field
from typing import BinaryIO, Callable

import docker
from docker.errors import DockerException, ImageNotFound, NotFound
from docker.types import Mount
from requests.exceptions import ConnectionError as RequestsConnectionError, ReadTimeout

from config import settings


class DockerUnavailable(Exception):
    """Docker 守护进程不可达。"""


class ImageMissing(Exception):
    """执行镜像未构建。"""


@dataclass
class RunResult:
    run_id: str
    exit_code: int | None
    stdout: str
    stderr: str
    stdout_truncated: bool
    stderr_truncated: bool
    timed_out: bool
    duration_ms: int
    skipped_snapshot_entries: list[str] = field(default_factory=list)


CONTAINER_ENV = {
    "HOME": "/tmp",
    "GIT_CONFIG_NOSYSTEM": "1",
    "GIT_CONFIG_GLOBAL": "/dev/null",
    "GIT_TERMINAL_PROMPT": "0",
    "LANG": "C.UTF-8",
}


def container_options(argv: list[str]) -> dict:
    """容器创建参数（集中定义，便于测试逐项核对）。"""
    return {
        "image": settings.image,
        "command": list(argv),
        "network_mode": "none",
        "read_only": True,
        # /work 改为匿名卷，原因见模块说明；/tmp 保留 tmpfs
        "tmpfs": {"/tmp": "rw,size=64m"},
        "mounts": [Mount(target="/work", source=None, type="volume")],
        "user": "1000:1000",
        "mem_limit": "512m",
        "nano_cpus": 1_000_000_000,
        "pids_limit": 128,
        "cap_drop": ["ALL"],
        "security_opt": ["no-new-privileges:true"],
        "working_dir": "/work",
        "environment": dict(CONTAINER_ENV),
        "labels": {settings.container_label: "1"},
    }


def truncate_output(data: bytes, limit: int | None = None) -> tuple[str, bool]:
    """按字节上限截断输出，返回 (文本, 是否截断)。截断处的半个 UTF-8 字符被丢弃。"""
    limit = settings.output_limit if limit is None else limit
    truncated = len(data) > limit
    if truncated:
        data = data[:limit]
    return data.decode("utf-8", errors="ignore" if truncated else "replace"), truncated


def get_client() -> docker.DockerClient:
    try:
        client = docker.from_env(timeout=30)
        client.ping()
        return client
    except (DockerException, RequestsConnectionError, OSError) as exc:
        raise DockerUnavailable("Docker 不可用，请确认 Docker Desktop 已启动") from exc


def image_present(client: docker.DockerClient) -> bool:
    try:
        client.images.get(settings.image)
        return True
    except ImageNotFound:
        return False


def run(tar_file: BinaryIO, argv: list[str], timeout_seconds: int,
        validator: Callable[[list[str]], list[str]], skipped: list[str] | None = None,
        client: docker.DockerClient | None = None) -> RunResult:
    """校验 argv 后在容器中执行。validator 由调用方注入（正式服务用 policy.validate）。"""
    final_argv = validator(argv)
    client = client or get_client()
    if not image_present(client):
        raise ImageMissing(f"缺少镜像 {settings.image}，请先执行 docker build")

    run_id = uuid.uuid4().hex
    started = time.perf_counter()
    container = None
    timed_out = False
    exit_code: int | None = None
    try:
        container = client.containers.create(name=f"gor-runner-{run_id[:12]}", **container_options(final_argv))
        if not container.put_archive("/work", tar_file):
            raise RuntimeError("快照放入容器失败")
        container.start()
        try:
            status = container.wait(timeout=timeout_seconds)
            exit_code = int(status.get("StatusCode", -1))
        except (ReadTimeout, RequestsConnectionError):
            timed_out = True
            try:
                container.kill()
            except (NotFound, DockerException):
                pass
            try:
                container.wait(timeout=10)
            except (ReadTimeout, RequestsConnectionError, DockerException):
                pass
        stdout, stdout_truncated = truncate_output(container.logs(stdout=True, stderr=False))
        stderr, stderr_truncated = truncate_output(container.logs(stdout=False, stderr=True))
    except (RequestsConnectionError,) as exc:
        raise DockerUnavailable("执行过程中 Docker 连接中断") from exc
    finally:
        if container is not None:
            try:
                container.remove(force=True, v=True)
            except NotFound:
                pass
            except DockerException as exc:  # 由 sweeper 兜底清理
                print(f"[Runner] 删除容器失败，将由清理任务处理：{type(exc).__name__}")
    return RunResult(
        run_id=run_id,
        exit_code=None if timed_out else exit_code,
        stdout=stdout, stderr=stderr,
        stdout_truncated=stdout_truncated, stderr_truncated=stderr_truncated,
        timed_out=timed_out,
        duration_ms=round((time.perf_counter() - started) * 1000),
        skipped_snapshot_entries=list(skipped or [])[: settings.skipped_report_limit],
    )
