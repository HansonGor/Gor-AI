"""Per-chat in-memory working copy of a server-persisted Preview Project; never touches local disk."""

import difflib
import json
import re
from dataclasses import dataclass, field

from services.token_estimator import estimate_tokens


MAX_FILES = 40
MAX_FILE_BYTES = 100_000
MAX_TOTAL_BYTES = 500_000
MAX_DIFF_CHARS = 20_000
MAX_SEARCH_RESULTS = 50
SEARCH_CONTEXT_LINES = 3
MAX_SEARCH_LINE_CHARS = 240
MAX_SEARCH_SNIPPET_CHARS = 1_200
# Virtual FS values are text. Keep media, archives and compiled assets out of the
# source-file tools while allowing new text languages without a new patch tool.
BINARY_EXTENSIONS = {
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".bmp", ".ico",
    ".pdf", ".zip", ".rar", ".7z", ".tar", ".gz", ".glb", ".gltf", ".obj", ".fbx", ".stl", ".wasm",
    ".ttf", ".otf", ".woff", ".woff2", ".eot", ".mp3", ".wav",
    ".ogg", ".mp4", ".mov", ".webm", ".pptx", ".docx", ".xlsx",
    ".exe", ".dll", ".so", ".dylib", ".bin", ".class", ".pyc",
}
BLOCKED_SEGMENT = re.compile(r"(^\.|node_modules|dist|build|generated|secret|credential|private|token|password)", re.I)


def normalize_virtual_path(path: str) -> str:
    if not isinstance(path, str) or not path or "\\" in path or "\x00" in path:
        raise ValueError("虚拟文件路径必须使用正斜杠。")
    parts = path.lstrip("/").split("/")
    if any(not part or part in {".", ".."} or BLOCKED_SEGMENT.search(part) for part in parts):
        raise ValueError("虚拟文件路径包含受保护目录或路径穿越。")
    normalized = "/" + "/".join(parts)
    if not re.fullmatch(r"/(?:[A-Za-z0-9_-]+/)*[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+", normalized):
        raise ValueError("虚拟文件路径仅允许安全的文本源码名称。")
    extension = "." + parts[-1].rsplit(".", 1)[-1].lower() if "." in parts[-1] else ""
    if extension in BINARY_EXTENSIONS:
        raise ValueError("二进制文件不能使用 Preview 文本源码工具。")
    return normalized


def _diff(path: str, before: str, after: str) -> str:
    result = "".join(difflib.unified_diff(
        before.splitlines(keepends=True), after.splitlines(keepends=True),
        fromfile=f"a{path}", tofile=f"b{path}",
    ))
    return result[:MAX_DIFF_CHARS] + ("\n… diff 已截断" if len(result) > MAX_DIFF_CHARS else "")


@dataclass
class PreviewProjectWorkspace:
    project_id: str
    template: str
    files: dict[str, str]
    revision: int = 0
    initial_files: dict[str, str] = field(init=False, repr=False)

    def __post_init__(self) -> None:
        self.initial_files = dict(self.files)

    def diff_from_initial(self, path: str) -> str:
        normalized = normalize_virtual_path(path)
        return _diff(normalized, self.initial_files.get(normalized, ""), self.files[normalized])

    @classmethod
    def from_request(cls, project: dict | None) -> "PreviewProjectWorkspace | None":
        if project is None:
            return None
        if not isinstance(project, dict):
            raise ValueError("Preview Project 格式无效。")
        project_id = project.get("id")
        template = project.get("template")
        raw_files = project.get("files")
        revision = project.get("revision", 0)
        if not isinstance(project_id, str) or not 1 <= len(project_id) <= 100:
            raise ValueError("Preview Project ID 无效。")
        if template not in {"react", "html"} or not isinstance(raw_files, dict):
            raise ValueError("Preview Project 模板或文件集无效。")
        if type(revision) is not int or not 0 <= revision <= 9_007_199_254_740_990:
            raise ValueError("Preview Project revision 无效。")
        if len(raw_files) > MAX_FILES:
            raise ValueError("Preview Project 文件数量超限。")
        files: dict[str, str] = {}
        for path, content in raw_files.items():
            normalized = normalize_virtual_path(path)
            if normalized != path or not isinstance(content, str) or "\x00" in content or len(content.encode("utf-8")) > MAX_FILE_BYTES:
                raise ValueError("Preview Project 文件路径或内容无效。")
            files[normalized] = content
        if sum(len(value.encode("utf-8")) for value in files.values()) > MAX_TOTAL_BYTES:
            raise ValueError("Preview Project 总大小超限。")
        return cls(project_id=project_id, template=template, files=files, revision=revision)

    def list_files(self) -> str:
        return json.dumps({"success": True, "projectId": self.project_id, "template": self.template, "files": sorted(self.files), "revision": self.revision}, ensure_ascii=False)

    def read_file(self, path: str, start_line: int | None = None, end_line: int | None = None) -> str:
        try:
            normalized = normalize_virtual_path(path)
            if normalized not in self.files:
                raise ValueError("虚拟文件不存在。")
            content = self.files[normalized]
            if start_line is None and end_line is None:
                total_lines = len(content.splitlines())
                print(
                    f"[PreviewContext] project={self.project_id} read_file={normalized} "
                    f"lines=1-{total_lines} read_tokens={estimate_tokens(content)}"
                )
                return json.dumps({
                    "success": True,
                    "path": normalized,
                    "content": content,
                    "totalLines": total_lines,
                    "revision": self.revision,
                }, ensure_ascii=False)

            if start_line is not None and (type(start_line) is not int or start_line < 1):
                raise ValueError("start_line 必须是大于等于 1 的行号。")
            if end_line is not None and (type(end_line) is not int or end_line < 1):
                raise ValueError("end_line 必须是大于等于 1 的行号。")

            lines = content.splitlines(keepends=True)
            total_lines = len(lines)
            selected_start = start_line if start_line is not None else 1
            selected_end = end_line if end_line is not None else total_lines
            if selected_end < selected_start:
                raise ValueError("end_line 不能小于 start_line。")
            actual_end = min(selected_end, total_lines)
            selected = lines[selected_start - 1:actual_end] if selected_start <= actual_end else []
            selected_content = "".join(selected)
            returned_end = actual_end if selected else selected_start - 1
            print(
                f"[PreviewContext] project={self.project_id} read_file={normalized} "
                f"lines={selected_start}-{returned_end} read_tokens={estimate_tokens(selected_content)}"
            )
            return json.dumps({
                "success": True,
                "path": normalized,
                "startLine": selected_start,
                "endLine": returned_end,
                "totalLines": total_lines,
                "content": selected_content,
                "revision": self.revision,
            }, ensure_ascii=False)
        except ValueError as exc:
            return json.dumps({"success": False, "error": str(exc)}, ensure_ascii=False)

    @staticmethod
    def _search_line_snippet(line: str, match_column: int) -> str:
        if len(line) <= MAX_SEARCH_LINE_CHARS:
            return line
        start = max(0, min(match_column - MAX_SEARCH_LINE_CHARS // 2, len(line) - MAX_SEARCH_LINE_CHARS))
        end = start + MAX_SEARCH_LINE_CHARS
        return ("…" if start else "") + line[start:end] + ("…" if end < len(line) else "")

    def search_code(self, query: str, path: str | None = None, max_results: int = 20) -> str:
        try:
            if not isinstance(query, str) or not query.strip():
                raise ValueError("query 必须是非空文本。")
            if type(max_results) is not int or max_results < 1:
                raise ValueError("max_results 必须是大于等于 1 的整数。")
            result_limit = min(max_results, MAX_SEARCH_RESULTS)
            if path is not None:
                normalized = normalize_virtual_path(path)
                if normalized not in self.files:
                    raise ValueError("虚拟文件不存在。")
                paths = [normalized]
            else:
                paths = sorted(self.files)

            needle = query.casefold()
            raw_matches = []
            raw_match_limit = min(MAX_SEARCH_RESULTS * 5, result_limit * 5)
            for file_path in paths:
                lines = self.files[file_path].splitlines()
                folded_lines = [line.casefold() for line in lines]
                for index, folded_line in enumerate(folded_lines):
                    match_column = folded_line.find(needle)
                    if match_column < 0:
                        continue
                    raw_matches.append({
                        "path": file_path,
                        "line": index + 1,
                        "matchCount": max(1, folded_line.count(needle)),
                        "_matchColumn": match_column,
                    })
                    if len(raw_matches) >= raw_match_limit:
                        break
                if len(raw_matches) >= raw_match_limit:
                    break

            # Nearby matches have overlapping context windows. Merge those into
            # one bounded snippet rather than sending almost-identical excerpts.
            grouped: dict[str, list[dict]] = {}
            for hit in raw_matches:
                grouped.setdefault(hit["path"], []).append(hit)

            results = []
            for file_path, hits in grouped.items():
                lines = self.files[file_path].splitlines()
                clusters: list[dict] = []
                for hit in hits:
                    first = max(1, hit["line"] - SEARCH_CONTEXT_LINES)
                    last = min(len(lines), hit["line"] + SEARCH_CONTEXT_LINES)
                    if clusters and first <= clusters[-1]["endLine"] + 1:
                        current = clusters[-1]
                        candidate_end = max(current["endLine"], last)
                        candidate = "\n".join(lines[current["startLine"] - 1:candidate_end])
                        if len(candidate) <= MAX_SEARCH_SNIPPET_CHARS:
                            current["endLine"] = candidate_end
                            current["matchCount"] += hit["matchCount"]
                            current["matchLines"].append(hit["line"])
                            current["snippet"] = candidate
                            continue

                    snippet_lines = [
                        self._search_line_snippet(lines[line_index], hit["_matchColumn"] if line_index + 1 == hit["line"] else 0)
                        for line_index in range(first - 1, last)
                    ]
                    snippet = "\n".join(snippet_lines)
                    if len(snippet) > MAX_SEARCH_SNIPPET_CHARS:
                        snippet = snippet[:MAX_SEARCH_SNIPPET_CHARS] + "…"
                    clusters.append({
                        "path": file_path,
                        "line": hit["line"],
                        "startLine": first,
                        "endLine": last,
                        "matchCount": hit["matchCount"],
                        "matchLines": [hit["line"]],
                        "snippet": snippet,
                    })
                results.extend(clusters)
            results = results[:result_limit]
            serialized = json.dumps(results, ensure_ascii=False)
            print(
                f"[PreviewContext] project={self.project_id} search_results={len(results)} "
                f"raw_match_lines={len(raw_matches)} "
                f"query_tokens={estimate_tokens(query)} result_tokens={estimate_tokens(serialized)}"
            )
            return serialized
        except ValueError as exc:
            return json.dumps({"success": False, "error": str(exc)}, ensure_ascii=False)

    def write_file(self, path: str, content: str) -> str:
        try:
            normalized = normalize_virtual_path(path)
            if not isinstance(content, str) or "\x00" in content or len(content.encode("utf-8")) > MAX_FILE_BYTES:
                raise ValueError("虚拟文件内容超过 100 KB 限制。")
            if normalized not in self.files and len(self.files) >= MAX_FILES:
                raise ValueError("虚拟文件数量超限。")
            before = self.files.get(normalized, "")
            total = sum(len(value.encode("utf-8")) for value in self.files.values()) - len(before.encode("utf-8")) + len(content.encode("utf-8"))
            if total > MAX_TOTAL_BYTES:
                raise ValueError("虚拟项目总大小超过 500 KB。")
            if before != content:
                self.files[normalized] = content
                self.revision += 1
            return json.dumps({
                "success": True,
                "projectId": self.project_id,
                "path": normalized,
                "content": content,
                "diff": _diff(normalized, before, content),
                "changed": before != content,
                "revision": self.revision,
            }, ensure_ascii=False)
        except ValueError as exc:
            return json.dumps({"success": False, "error": str(exc)}, ensure_ascii=False)

    def patch_file(self, path: str, old_text: str, new_text: str, expected_revision: int | None = None) -> str:
        try:
            normalized = normalize_virtual_path(path)
            if normalized not in self.files:
                return self._patch_error("PATCH_TARGET_NOT_FOUND", "目标文件不存在，请重新 read_preview_file 后生成 patch。")
            if expected_revision is not None and (type(expected_revision) is not int or expected_revision != self.revision):
                return self._patch_error("PATCH_REVISION_CONFLICT", "Preview Project 已变化，请重新 read_preview_file 获取最新源码和 revision。")
            if not isinstance(old_text, str) or not old_text or not isinstance(new_text, str):
                raise ValueError("old_text 必须是非空文本，new_text 必须是文本。")
            before = self.files[normalized]
            count = before.count(old_text)
            if count == 0:
                return self._patch_error("PATCH_TARGET_NOT_FOUND", "目标源码可能已经变化，请重新 read_preview_file 后生成 patch。")
            if count > 1:
                return self._patch_error("PATCH_TARGET_NOT_UNIQUE", "old_text 匹配多个位置，请扩大上下文后重新 patch。")
            result = json.loads(self.write_file(normalized, before.replace(old_text, new_text, 1)))
            if not result.get("success"):
                return json.dumps(result, ensure_ascii=False)
            print(
                f"[PreviewContext] project={self.project_id} patch_diff_tokens={estimate_tokens(result['diff'])} "
                f"path={normalized} revision={result['revision']}"
            )
            return json.dumps({
                "success": True,
                "projectId": self.project_id,
                "path": normalized,
                "diff": result["diff"],
                "changed": result["changed"],
                "revision": result["revision"],
            }, ensure_ascii=False)
        except ValueError as exc:
            return json.dumps({"success": False, "error": str(exc), "revision": self.revision}, ensure_ascii=False)

    def batch_patch_files(self, patches: list[dict], expected_revision: int | None = None) -> str:
        """Validate every exact replacement against one revision, then commit atomically."""
        try:
            if expected_revision is None or type(expected_revision) is not int or expected_revision != self.revision:
                return self._patch_error("PATCH_REVISION_CONFLICT", "Preview Project 已变化，请重新读取源码和 revision 后再批量 patch。")
            if not isinstance(patches, list) or not patches:
                raise ValueError("patches 必须是非空数组。")

            staged: dict[str, str] = {}
            positions: dict[str, list[tuple[int, int]]] = {}
            counts_by_path: dict[str, int] = {}
            # Validate against the same immutable revision before changing any file.
            for index, patch in enumerate(patches):
                if not isinstance(patch, dict):
                    return self._batch_patch_error("PATCH_INVALID", "patch 项格式无效。", index=index)
                path = normalize_virtual_path(patch.get("path", ""))
                if path not in self.files:
                    return self._batch_patch_error("PATCH_TARGET_NOT_FOUND", "目标文件不存在，请重新读取文件后再 patch。", index=index, path=path)
                old_text, new_text = patch.get("old_text"), patch.get("new_text")
                if not isinstance(old_text, str) or not old_text or not isinstance(new_text, str):
                    return self._batch_patch_error("PATCH_INVALID", "old_text 必须是非空文本，new_text 必须是文本。", index=index, path=path)
                original = self.files[path]
                count = original.count(old_text)
                if count == 0:
                    return self._batch_patch_error("PATCH_TARGET_NOT_FOUND", "目标源码可能已经变化，请重新 read_preview_file 后重新生成 patch。", index=index, path=path)
                if count > 1:
                    return self._batch_patch_error("PATCH_TARGET_NOT_UNIQUE", "old_text 匹配多个位置，请扩大上下文后重新 patch。", index=index, path=path)
                start = original.find(old_text)
                end = start + len(old_text)
                if any(start < other_end and other_start < end for other_start, other_end in positions.setdefault(path, [])):
                    return self._batch_patch_error("PATCH_OVERLAPPING", "同一文件中的 patch 目标重叠，请合并为一个 patch。", index=index, path=path)
                positions[path].append((start, end))
                staged.setdefault(path, original)
                counts_by_path[path] = counts_by_path.get(path, 0) + 1

            for path, path_patches in positions.items():
                # Resolve each corresponding new_text from the original offsets, then apply back-to-front.
                replacements = []
                original = self.files[path]
                for patch in patches:
                    if normalize_virtual_path(patch.get("path", "")) == path:
                        old_text = patch["old_text"]
                        replacements.append((original.find(old_text), len(old_text), patch["new_text"]))
                content = original
                for start, old_length, new_text in sorted(replacements, key=lambda item: item[0], reverse=True):
                    content = content[:start] + new_text + content[start + old_length:]
                if "\x00" in content or len(content.encode("utf-8")) > MAX_FILE_BYTES:
                    return self._batch_patch_error("PATCH_SIZE_LIMIT", "patch 后文件超过 100 KB 限制。", path=path)
                staged[path] = content

            total_bytes = sum(
                len(staged.get(path, content).encode("utf-8"))
                for path, content in self.files.items()
            )
            if total_bytes > MAX_TOTAL_BYTES:
                return self._batch_patch_error("PATCH_SIZE_LIMIT", "patch 后项目总大小超过 500 KB。")

            changed_files = []
            for path, after in staged.items():
                before = self.files[path]
                if before == after:
                    continue
                changed_files.append({
                    "path": path,
                    "diff": _diff(path, before, after),
                    "patchCount": counts_by_path[path],
                })
            if changed_files:
                # All checks have passed: one atomic in-memory commit and one revision bump.
                for item in changed_files:
                    self.files[item["path"]] = staged[item["path"]]
                self.revision += 1

            combined_diff = "\n".join(item["diff"] for item in changed_files)
            if len(combined_diff) > MAX_DIFF_CHARS:
                combined_diff = combined_diff[:MAX_DIFF_CHARS] + "\n… combined diff 已截断"
            print(
                f"[PreviewContext] project={self.project_id} batch_patch_count={len(patches)} "
                f"changed_files={len(changed_files)} diff_tokens={estimate_tokens(combined_diff)} revision={self.revision}"
            )
            return json.dumps({
                "success": True,
                "projectId": self.project_id,
                "changedFiles": changed_files,
                "diff": combined_diff,
                "patchCount": len(patches),
                "revision": self.revision,
                "changed": bool(changed_files),
            }, ensure_ascii=False)
        except ValueError as exc:
            return json.dumps({"success": False, "code": "PATCH_INVALID", "error": str(exc), "revision": self.revision}, ensure_ascii=False)

    def _batch_patch_error(self, code: str, message: str, *, index: int | None = None, path: str | None = None) -> str:
        result: dict[str, object] = {"success": False, "code": code, "error": message, "revision": self.revision}
        if index is not None:
            result["patchIndex"] = index
        if path is not None:
            result["path"] = path
        return json.dumps(result, ensure_ascii=False)

    def _patch_error(self, code: str, message: str) -> str:
        return json.dumps({"success": False, "code": code, "error": message, "revision": self.revision}, ensure_ascii=False)
