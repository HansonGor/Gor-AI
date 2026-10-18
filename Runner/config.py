"""Runner 配置。所有数值可用环境变量覆盖（只读取下列变量名，不打印环境变量内容）。"""

from __future__ import annotations

import os
from dataclasses import dataclass


def _int_env(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None or not raw.strip():
        return default
    try:
        return int(raw)
    except ValueError:
        return default


@dataclass(frozen=True)
class Settings:
    version: str = "0.1.0"
    host: str = "127.0.0.1"
    port: int = _int_env("GOR_RUNNER_PORT", 4000)
    image: str = os.environ.get("GOR_RUNNER_IMAGE", "gor-runner-git:latest")
    # 超时（秒）
    default_timeout: int = _int_env("GOR_RUNNER_DEFAULT_TIMEOUT", 30)
    min_timeout: int = 1
    max_timeout: int = _int_env("GOR_RUNNER_MAX_TIMEOUT", 120)
    # 单个输出流上限（字节）
    output_limit: int = _int_env("GOR_RUNNER_OUTPUT_LIMIT", 64 * 1024)
    # 快照上限
    snapshot_max_compressed: int = _int_env("GOR_RUNNER_SNAPSHOT_MAX_COMPRESSED", 50 * 1024 * 1024)
    snapshot_max_uncompressed: int = _int_env("GOR_RUNNER_SNAPSHOT_MAX_UNCOMPRESSED", 200 * 1024 * 1024)
    snapshot_max_members: int = _int_env("GOR_RUNNER_SNAPSHOT_MAX_MEMBERS", 20000)
    skipped_report_limit: int = 50
    # 残留容器清理
    sweep_interval: int = _int_env("GOR_RUNNER_SWEEP_INTERVAL", 60)
    sweep_max_age: int = _int_env("GOR_RUNNER_SWEEP_MAX_AGE", 600)
    container_label: str = "gor-runner"


settings = Settings()
