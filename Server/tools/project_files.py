"""Scoped file tools for editing the React app during a chat.

Only text source in the configured Web workspace is visible to the model.
Generated files, dependencies, secrets and symlink escapes are rejected.
"""

import difflib
import json
import os
import re
import tempfile
import threading
from pathlib import Path

from langchain_core.tools import tool

from config import config


ROOT = Path(config.ProjectWorkspace.ROOT).resolve()
EDIT_LOCK = threading.Lock()
SKIP_DIRS = {
    ".git", ".expo", ".vite", "node_modules", "dist", "build", "coverage",
    "generated", "venv", ".venv", "__pycache__", ".mypy_cache", ".next",
}
SOURCE_EXTENSIONS = {".ts", ".tsx", ".js", ".jsx", ".css", ".less", ".html", ".json"}
SECRET_NAME = re.compile(r"(^\.env(?:\.|$)|secret|credential|private.?key|token|password|\.pem$|\.key$)", re.I)
MAX_FILE_BYTES = 100_000
MAX_OUTPUT_CHARS = 20_000


def _resolve(relative_path: str, *, write: bool = False) -> Path:
    if not relative_path or "\\" in relative_path or "\x00" in relative_path:
        raise ValueError("请使用工作区内的相对路径（正斜杠分隔）。")
    raw = Path(relative_path)
    if raw.is_absolute() or any(part in {"", ".", ".."} for part in raw.parts):
        raise ValueError("不允许绝对路径或路径穿越。")
    if any(part.lower() in SKIP_DIRS or SECRET_NAME.search(part) for part in raw.parts):
        raise ValueError("该路径属于受保护目录或敏感文件。")
    if raw.suffix.lower() not in SOURCE_EXTENSIONS or raw.name.lower() in {"package-lock.json", "yarn.lock", "pnpm-lock.yaml"}:
        raise ValueError("只允许访问 Web 源码类型文件。")
    # Code writes are restricted to src/ and index.html. Configuration and
    # dependency manifests remain read-only even when they are text files.
    if write and not (raw.parts[0] == "src" or raw.as_posix() == "index.html"):
        raise ValueError("只允许修改 src/ 下的源码或 index.html。")
    path = ROOT.joinpath(*raw.parts)
    if not path.resolve().is_relative_to(ROOT):
        raise ValueError("路径超出工作区。")
    current = ROOT
    for part in raw.parts:
        current = current / part
        if current.is_symlink():
            raise ValueError("不允许访问符号链接。")
    return path


def _read(path: Path) -> str:
    if not path.is_file() or path.stat().st_size > MAX_FILE_BYTES:
        raise ValueError("文件不存在或超过 100 KB 限制。")
    return path.read_text(encoding="utf-8")


def _result(**kwargs: object) -> str:
    return json.dumps(kwargs, ensure_ascii=False)


def _diff(relative_path: str, before: str, after: str) -> str:
    diff = "".join(difflib.unified_diff(
        before.splitlines(keepends=True), after.splitlines(keepends=True),
        fromfile=f"a/{relative_path}", tofile=f"b/{relative_path}",
    ))
    return diff[:MAX_OUTPUT_CHARS] + ("\n… diff 已截断" if len(diff) > MAX_OUTPUT_CHARS else "")


@tool
def search_project_files(query: str) -> str:
    """Search Web project source filenames and text for a short keyword. Returns relative paths and matching lines."""
    query = query.strip()
    if not 2 <= len(query) <= 100:
        return _result(success=False, error="搜索词长度需为 2–100 字符。")
    matches: list[dict[str, object]] = []
    if not ROOT.is_dir():
        return _result(success=False, error="Web 工作区不存在。")
    for base, dirs, files in os.walk(ROOT, followlinks=False):
        dirs[:] = [d for d in dirs if d.lower() not in SKIP_DIRS and not SECRET_NAME.search(d) and not (Path(base) / d).is_symlink()]
        for name in files:
            path = Path(base) / name
            relative = path.relative_to(ROOT).as_posix()
            try:
                _resolve(relative)
                content = _read(path)
            except (ValueError, OSError, UnicodeError):
                continue
            if query.casefold() in relative.casefold():
                matches.append({"path": relative, "line": 0, "text": "文件名匹配"})
            for number, line in enumerate(content.splitlines(), 1):
                if query.casefold() in line.casefold():
                    matches.append({"path": relative, "line": number, "text": line[:180]})
                    if len(matches) >= 60:
                        return _result(success=True, matches=matches, truncated=True)
    return _result(success=True, matches=matches, truncated=False)


@tool
def read_project_file(path: str) -> str:
    """Read a UTF-8 source file in the configured Web workspace. Path is relative to Web, e.g. src/App.tsx."""
    try:
        source = _read(_resolve(path))
        return _result(success=True, path=path, content=source[:MAX_OUTPUT_CHARS], truncated=len(source) > MAX_OUTPUT_CHARS)
    except (ValueError, OSError, UnicodeError) as exc:
        return _result(success=False, error=str(exc))


@tool
def edit_project_file(path: str, old_text: str, new_text: str) -> str:
    """Replace one exact, unique text span in a Web source file. Read the file first; no shell commands are run."""
    try:
        target = _resolve(path, write=True)
        if not old_text or len(new_text) > MAX_FILE_BYTES:
            raise ValueError("旧内容不能为空，新内容不能超过 100 KB。")
        with EDIT_LOCK:
            before = _read(target)
            if before.count(old_text) != 1:
                raise ValueError("旧内容必须在当前文件中恰好出现一次；请重新读取文件。")
            after = before.replace(old_text, new_text, 1)
            if len(after.encode("utf-8")) > MAX_FILE_BYTES:
                raise ValueError("修改后文件超过 100 KB 限制。")
            fd, temp_path = tempfile.mkstemp(prefix=".project-edit-", dir=target.parent)
            try:
                with os.fdopen(fd, "w", encoding="utf-8", newline="") as stream:
                    stream.write(after)
                os.replace(temp_path, target)
            finally:
                if os.path.exists(temp_path):
                    os.unlink(temp_path)
        return _result(success=True, path=path, diff=_diff(path, before, after))
    except (ValueError, OSError, UnicodeError) as exc:
        return _result(success=False, error=str(exc))


@tool
def create_project_file(path: str, content: str) -> str:
    """Create one new UTF-8 Web source file under src/. Existing files are never overwritten."""
    try:
        target = _resolve(path, write=True)
        if not path.startswith("src/"):
            raise ValueError("新文件必须位于 src/ 下。")
        if len(content.encode("utf-8")) > MAX_FILE_BYTES:
            raise ValueError("内容超过 100 KB 限制。")
        with EDIT_LOCK:
            target.parent.mkdir(parents=True, exist_ok=True)
            _resolve(path, write=True)  # Recheck newly created path components.
            with target.open("x", encoding="utf-8", newline="") as stream:
                stream.write(content)
        return _result(success=True, path=path, diff=_diff(path, "", content))
    except (ValueError, OSError, UnicodeError) as exc:
        return _result(success=False, error=str(exc))
