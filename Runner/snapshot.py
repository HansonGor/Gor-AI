"""快照 tar.gz 的安全检查与过滤。

以流式方式逐个读取成员：先按 tar 头检查路径、类型、数量与累计大小，再读取内容，
因此超限快照会在解压到上限前被拒绝。通过检查的成员重新打包为临时 tar（不含被丢弃的成员），
所有者统一改为容器内用户 1000:1000，并去掉 setuid/setgid 等特殊权限位。
"""

from __future__ import annotations

import fnmatch
import tarfile
import tempfile
import zlib
from dataclasses import dataclass, field
from pathlib import PurePosixPath
from typing import BinaryIO

from config import settings

SKIP_DIRS = {"node_modules", ".venv", "venv", "dist", "build", "coverage", "__pycache__"}
SKIP_FILE_PATTERNS = ("*.pem", "*.key", "id_rsa*", "*secret*", "*credential*")
CONTAINER_UID = 1000
CONTAINER_GID = 1000


class SnapshotRejected(Exception):
    """快照内容不安全或格式错误。"""


class SnapshotTooLarge(Exception):
    """快照超过大小或成员数量上限。"""


@dataclass
class FilteredSnapshot:
    tar_file: BinaryIO              # 过滤后的未压缩 tar，读指针位于开头
    skipped: list[str] = field(default_factory=list)
    member_count: int = 0
    total_bytes: int = 0

    def close(self) -> None:
        self.tar_file.close()


def _normalize(name: str) -> PurePosixPath:
    if "\\" in name:
        raise SnapshotRejected(f"成员路径不得包含反斜杠：{name}")
    if name.startswith("/") or (len(name) > 1 and name[1] == ":"):
        raise SnapshotRejected(f"成员不得使用绝对路径：{name}")
    path = PurePosixPath(name)
    parts = [p for p in path.parts if p not in ("", ".")]
    if ".." in parts:
        raise SnapshotRejected(f"成员路径不得包含 ..：{name}")
    return PurePosixPath(*parts) if parts else PurePosixPath(".")


def should_skip(path: PurePosixPath) -> bool:
    """是否丢弃该路径。.git/ 内部（对象、引用名等）不按名称过滤，避免破坏仓库结构。"""
    parts = path.parts
    if parts and parts[0] == ".git":
        return False
    if any(part in SKIP_DIRS for part in parts):
        return True
    name = parts[-1] if parts else ""
    if name == ".env" or name.startswith(".env."):
        return True
    lowered = name.lower()
    return any(fnmatch.fnmatchcase(lowered, pattern) for pattern in SKIP_FILE_PATTERNS)


def _skip_label(path: PurePosixPath) -> str:
    """被丢弃目录只记录目录本身一次，而不是其下的每个文件。"""
    for i, part in enumerate(path.parts):
        if part in SKIP_DIRS:
            return "/".join(path.parts[: i + 1]) + "/"
    return str(path)


def filter_snapshot(source: BinaryIO, *, max_uncompressed: int | None = None,
                    max_members: int | None = None) -> FilteredSnapshot:
    """检查并过滤 tar.gz 流，返回过滤后的临时 tar。"""
    max_uncompressed = settings.snapshot_max_uncompressed if max_uncompressed is None else max_uncompressed
    max_members = settings.snapshot_max_members if max_members is None else max_members
    head = source.read(2)
    if head != b"\x1f\x8b":
        raise SnapshotRejected("快照必须是 gzip 压缩的 tar（.tar.gz）")
    source.seek(0)

    out = tempfile.SpooledTemporaryFile(max_size=16 * 1024 * 1024)
    result = FilteredSnapshot(tar_file=out)
    skipped_seen: set[str] = set()
    written_dirs: set[str] = set()
    try:
        with tarfile.open(fileobj=source, mode="r|gz") as src, tarfile.open(fileobj=out, mode="w") as dst:
            for member in src:
                result.member_count += 1
                if result.member_count > max_members:
                    raise SnapshotTooLarge(f"快照成员数量超过上限 {max_members}")
                if member.issym():
                    raise SnapshotRejected(f"快照不得包含符号链接：{member.name}")
                if member.islnk():
                    raise SnapshotRejected(f"快照不得包含硬链接：{member.name}")
                if member.ischr() or member.isblk() or member.isfifo() or member.isdev():
                    raise SnapshotRejected(f"快照不得包含设备或特殊文件：{member.name}")
                if not (member.isfile() or member.isdir()):
                    raise SnapshotRejected(f"不支持的成员类型：{member.name}")
                path = _normalize(member.name)
                if member.isfile():
                    result.total_bytes += member.size
                    if result.total_bytes > max_uncompressed:
                        raise SnapshotTooLarge(f"快照解压后大小超过上限 {max_uncompressed // (1024 * 1024)} MB")
                if str(path) == ".":
                    continue
                if should_skip(path):
                    label = _skip_label(path)
                    if label not in skipped_seen:
                        skipped_seen.add(label)
                        result.skipped.append(label)
                    continue
                # 补齐父目录条目，保证容器内用户对目录可写（git 需要写 index.lock 等）
                for parent in reversed(path.parents[:-1]):
                    key = str(parent)
                    if key not in written_dirs:
                        written_dirs.add(key)
                        dst.addfile(_dir_info(key))
                if member.isdir():
                    if str(path) not in written_dirs:
                        written_dirs.add(str(path))
                        dst.addfile(_dir_info(str(path)))
                    continue
                info = tarfile.TarInfo(str(path))
                info.size = member.size
                info.mode = (member.mode & 0o755) | 0o600
                info.mtime = member.mtime
                info.uid, info.gid = CONTAINER_UID, CONTAINER_GID
                info.uname = info.gname = "runner"
                dst.addfile(info, src.extractfile(member))
    except (SnapshotRejected, SnapshotTooLarge):
        out.close()
        raise
    except (tarfile.TarError, EOFError, OSError, zlib.error) as exc:
        out.close()
        raise SnapshotRejected(f"快照无法解析：{exc}") from exc
    out.seek(0)
    return result


def _dir_info(name: str) -> tarfile.TarInfo:
    info = tarfile.TarInfo(name)
    info.type = tarfile.DIRTYPE
    info.mode = 0o755
    info.uid, info.gid = CONTAINER_UID, CONTAINER_GID
    info.uname = info.gname = "runner"
    return info
