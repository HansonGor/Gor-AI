"""残留容器清理：按 label 识别 Runner 创建的容器，删除超过最长存活时间的容器（连同匿名卷）。

清理失败只记录日志，不影响服务。
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timezone

from docker.errors import DockerException

from config import settings


def _created_at(value: str) -> datetime | None:
    # Docker 返回纳秒精度的 RFC3339，例如 2026-10-15T12:00:00.123456789Z
    try:
        base = value.rstrip("Z").split(".")[0]
        return datetime.strptime(base, "%Y-%m-%dT%H:%M:%S").replace(tzinfo=timezone.utc)
    except (ValueError, AttributeError):
        return None


def sweep_once(client=None, *, max_age_seconds: int | None = None, now: datetime | None = None) -> list[str]:
    """删除超龄容器，返回已删除的容器 ID 列表。"""
    max_age = settings.sweep_max_age if max_age_seconds is None else max_age_seconds
    removed: list[str] = []
    try:
        if client is None:
            from sandbox import get_client
            client = get_client()
        now = now or datetime.now(timezone.utc)
        containers = client.containers.list(all=True, filters={"label": f"{settings.container_label}=1"})
        for container in containers:
            created = _created_at(container.attrs.get("Created", ""))
            if created is None or (now - created).total_seconds() <= max_age:
                continue
            try:
                container.remove(force=True, v=True)
                removed.append(container.id)
            except DockerException as exc:
                print(f"[Sweeper] 删除容器 {container.short_id} 失败：{type(exc).__name__}")
    except Exception as exc:  # Docker 不可用等情况只记录
        print(f"[Sweeper] 清理跳过：{type(exc).__name__}")
    if removed:
        print(f"[Sweeper] 已清理 {len(removed)} 个残留容器")
    return removed


async def sweep_forever(interval: int | None = None) -> None:
    interval = settings.sweep_interval if interval is None else interval
    while True:
        await asyncio.to_thread(sweep_once)
        await asyncio.sleep(interval)
