"""Task-local source references. Providers always read/validate real state first."""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any

from project_api.types import ProjectRef
from services.token_estimator import estimate_tokens


def encode(value):
    return json.dumps(value, ensure_ascii=False)


@dataclass
class FileReads:
    ref: ProjectRef
    path: str
    state: dict
    probe: tuple[int | None, int | None]
    lines: dict[int, tuple[str, str]] = field(default_factory=dict)
    messages: list[Any] = field(default_factory=list)


class ProjectReadContext:
    """No filesystem, write authority, persistent cache, or LLM calls."""
    def __init__(self, context):
        self.context = context
        self.files: dict[tuple, FileReads] = {}
        self.sequence = 0
        self.stats = dict(reads=0, duplicate_reads=0, hits=0, partial_hits=0,
                          invalidations=0, validation_failures=0, conflicts=0,
                          validations=0,
                          raw_tokens=0, sent_tokens=0, saved_tokens=0)

    @staticmethod
    def _state(data):
        state = data.get("readState")
        if not isinstance(state, dict) or not state.get("contentHash"):
            return None
        if state.get("provider") == "preview" and type(state.get("projectVersion")) is int:
            return state
        if (state.get("provider") == "vscode" and type(state.get("fileVersion")) is int
                and type(state.get("dirty")) is bool and state.get("identity")):
            return state
        return None

    def _invalidate(self, key, reason):
        old = self.files.pop(key, None)
        if old is None:
            return
        self.stats["invalidations"] += 1
        # Context messages are copies; raw callbacks/SSE/tool receipts stay exact.
        for message in old.messages:
            message.content = encode({"success": False, "path": old.path,
                "cacheStatus": "invalidated", "error": reason,
                "message": "此前该文件的 readRef 全部失效；必须重新读取，不能用于写入依据。"})

    async def validate(self, signal=None):
        """Revalidate once per file before each model call, via its own provider.

        Clean/disk/Dirty/connection checks belong to the adapter. Legacy adapters
        without reliable readState never receive references in the first place.
        """
        if not self.context:
            return
        api, _ = self.context
        for key, entry in list(self.files.items()):
            if signal and signal.is_set():
                return
            try:
                self.stats["validations"] += 1
                data = await api.read_file(entry.ref, entry.path, *entry.probe)
                state = self._state(data) if data.get("success") else None
                if state is None:
                    self.stats["validation_failures"] += 1
                if state != entry.state:
                    self._invalidate(key, "文件版本、内容或编辑器状态已变化，旧读取已撤销。")
            except Exception as error:
                self.stats["validation_failures"] += 1
                if getattr(error, "code", "") in {"VERSION_CONFLICT", "FILE_HAS_UNSAVED_CHANGES"}:
                    self.stats["conflicts"] += 1
                self._invalidate(key, "当前文件状态无法确认，请通过项目读取工具重新读取。")

    def observe(self, name, args, raw, message):
        """Attach only verified, lossless ranges; overlap becomes line references."""
        if not self.context or name not in {"read_project_file", "read_preview_file"}:
            # Conservatively invalidate on all mutations, even partial failures.
            if name in {"patch_project_file", "batch_patch_project_files", "write_project_file",
                        "create_project_file", "delete_project_file", "create_project_directory",
                        "delete_project_directory", "patch_preview_file", "batch_patch_preview_files",
                        "write_preview_file", "set_3d_scene"}:
                paths = [args.get("path")]
                if name in {"batch_patch_project_files", "batch_patch_preview_files"}:
                    paths = [item.get("path") for item in args.get("patches", []) if isinstance(item, dict)]
                normalized = {"/" + path.lstrip("/") for path in paths if isinstance(path, str)}
                unknown = not normalized or name in {"create_project_directory", "delete_project_directory", "set_3d_scene"}
                for key in list(self.files):
                    if unknown or key[-1] in normalized:
                        self._invalidate(key, "本轮发生项目修改；请读取修改后的实际版本。")
            return
        try:
            data = json.loads(raw)
        except (TypeError, ValueError):
            return
        if not isinstance(data, dict):
            return
        if not data.get("success"):
            if data.get("code") in {"VERSION_CONFLICT", "FILE_HAS_UNSAVED_CHANGES"}:
                self.stats["conflicts"] += 1
            for key in list(self.files):
                self._invalidate(key, "文件读取失败，无法确认旧版本仍然有效，请重新读取。")
            return
        _, current = self.context
        path = data.get("path")
        root = data.get("root", args.get("root", current.root))
        if not isinstance(path, str) or (root is not None and not isinstance(root, str)):
            return
        root = (root.strip() or None) if isinstance(root, str) else None
        ref = ProjectRef(current.project_id, current.provider, root)
        key = (ref.provider, ref.project_id, ref.root, path)
        state = self._state(data)
        if not data.get("success") or state is None or state.get("provider") != current.provider:
            self._invalidate(key, "本次读取未能确认当前版本，旧引用已撤销。")
            return
        invalidated = key in self.files and self.files[key].state != state
        if invalidated:
            self._invalidate(key, "文件版本或内容变化，禁止拼接旧版本的范围。")
        content = data.get("content")
        if not isinstance(content, str) or data.get("truncated"):
            return
        start = data.get("startLine", 1)
        total = data.get("totalLines")
        end = data.get("endLine", total)
        if any(type(value) is not int for value in (start, end, total)) or start < 1:
            return
        lines = content.splitlines(keepends=True)
        # VS Code counts a final empty line; it has no text but is still a range.
        if len(lines) + 1 == end - start + 1 and (not content or content.endswith(("\n", "\r"))):
            lines.append("")
        if len(lines) != max(0, end - start + 1):
            return  # Unknown/truncated formatting: retain original result intact.
        self.stats["reads"] += 1
        entry = self.files.get(key)
        if entry and any(number in entry.lines and entry.lines[number][0] != line
                         for number, line in enumerate(lines, start)):
            self._invalidate(key, "同版本的正文出现差异，旧引用已撤销。")
            entry = None
            invalidated = True
        if entry is None:
            entry = FileReads(ref, path, dict(state), (args.get("start_line"), args.get("end_line")))
            self.files[key] = entry
        self.sequence += 1
        read_ref = f"read-{self.sequence}"
        segments, references = [], []
        missing = []
        for number, line in enumerate(lines, start):
            previous = entry.lines.get(number)
            if previous is None:
                if segments and segments[-1]["endLine"] == number - 1:
                    segments[-1]["endLine"] = number
                    segments[-1]["content"] += line
                else:
                    segments.append({"startLine": number, "endLine": number, "content": line})
                missing.append((number, line))
            else:
                original_ref = previous[1]
                if references and references[-1]["readRef"] == original_ref and references[-1]["endLine"] == number - 1:
                    references[-1]["endLine"] = number
                else:
                    references.append({"readRef": original_ref, "startLine": number, "endLine": number})
        status = "partial" if references and missing else "hit" if references else "invalidated" if invalidated else "miss"
        full = {**data, "readRef": read_ref, "cacheStatus": status,
                "range": {"startLine": start, "endLine": end}}
        compact = {key: value for key, value in full.items() if key != "content"}
        compact.update(references=references, segments=segments,
                       message="引用的行在此前 readRef 正文中；需要时可按原路径和范围重新读取。缓存不代表写入许可。")
        original = encode(full)
        reduced = encode(compact)
        use_reference = bool(references) and len(reduced) < len(original)
        message.content = reduced if use_reference else original
        if references:
            self.stats["duplicate_reads"] += 1
        if use_reference:
            self.stats["partial_hits" if missing else "hits"] += 1
            for number, line in missing:
                entry.lines[number] = (line, read_ref)
        else:
            for number, line in enumerate(lines, start):
                entry.lines[number] = (line, read_ref)
        entry.messages.append(message)
        raw_tokens, sent_tokens = estimate_tokens(raw), estimate_tokens(message.content)
        self.stats["raw_tokens"] += raw_tokens
        self.stats["sent_tokens"] += sent_tokens
        self.stats["saved_tokens"] = self.stats["raw_tokens"] - self.stats["sent_tokens"]

    def audit(self):
        # Counts only: no source, tool parameters, host paths, or user content.
        print("[ProjectReadContext] " + encode(self.stats))
