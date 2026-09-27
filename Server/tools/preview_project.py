"""Per-chat, in-memory Preview Project editing. Never touches the local filesystem."""

import difflib
import json
import re
from dataclasses import dataclass

from langchain_core.tools import tool
from tools.scene_spec import apply_scene_command


MAX_FILES = 40
MAX_FILE_BYTES = 100_000
MAX_TOTAL_BYTES = 500_000
MAX_DIFF_CHARS = 20_000
ALLOWED_EXTENSIONS = {".ts", ".tsx", ".js", ".jsx", ".css", ".json", ".html"}
BLOCKED_SEGMENT = re.compile(r"(^\.|node_modules|dist|build|generated|secret|credential|private|token|password)", re.I)


def normalize_virtual_path(path: str) -> str:
    if not isinstance(path, str) or not path or "\\" in path or "\x00" in path:
        raise ValueError("虚拟文件路径必须使用正斜杠。")
    parts = path.lstrip("/").split("/")
    if any(not part or part in {".", ".."} or BLOCKED_SEGMENT.search(part) for part in parts):
        raise ValueError("虚拟文件路径包含受保护目录或路径穿越。")
    normalized = "/" + "/".join(parts)
    if not re.fullmatch(r"/(?:src/(?:[A-Za-z0-9_-]+/)*[A-Za-z0-9_-]+\.(?:ts|tsx|js|jsx|css|json|html)|index\.html|main\.js|style\.css)", normalized):
        raise ValueError("虚拟文件路径仅允许安全的源码名称。")
    extension = "." + parts[-1].rsplit(".", 1)[-1].lower() if "." in parts[-1] else ""
    if extension not in ALLOWED_EXTENSIONS:
        raise ValueError("不支持该虚拟文件类型。")
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

    @classmethod
    def from_request(cls, project: dict | None) -> "PreviewProjectWorkspace | None":
        if project is None:
            return None
        if not isinstance(project, dict):
            raise ValueError("Preview Project 格式无效。")
        project_id = project.get("id")
        template = project.get("template")
        raw_files = project.get("files")
        if not isinstance(project_id, str) or not 1 <= len(project_id) <= 100:
            raise ValueError("Preview Project ID 无效。")
        if template not in {"react", "html"} or not isinstance(raw_files, dict):
            raise ValueError("Preview Project 模板或文件集无效。")
        if len(raw_files) > MAX_FILES:
            raise ValueError("Preview Project 文件数量超限。")
        files: dict[str, str] = {}
        for path, content in raw_files.items():
            normalized = normalize_virtual_path(path)
            if normalized != path or not isinstance(content, str) or len(content.encode("utf-8")) > MAX_FILE_BYTES:
                raise ValueError("Preview Project 文件路径或内容无效。")
            files[normalized] = content
        if sum(len(value.encode("utf-8")) for value in files.values()) > MAX_TOTAL_BYTES:
            raise ValueError("Preview Project 总大小超限。")
        return cls(project_id=project_id, template=template, files=files)

    def list_files(self) -> str:
        return json.dumps({"success": True, "projectId": self.project_id, "template": self.template, "files": sorted(self.files)}, ensure_ascii=False)

    def read_file(self, path: str) -> str:
        try:
            normalized = normalize_virtual_path(path)
            if normalized not in self.files:
                raise ValueError("虚拟文件不存在。")
            return json.dumps({"success": True, "path": normalized, "content": self.files[normalized]}, ensure_ascii=False)
        except ValueError as exc:
            return json.dumps({"success": False, "error": str(exc)}, ensure_ascii=False)

    def write_file(self, path: str, content: str) -> str:
        try:
            normalized = normalize_virtual_path(path)
            if not isinstance(content, str) or len(content.encode("utf-8")) > MAX_FILE_BYTES:
                raise ValueError("虚拟文件内容超过 100 KB 限制。")
            if normalized not in self.files and len(self.files) >= MAX_FILES:
                raise ValueError("虚拟文件数量超限。")
            before = self.files.get(normalized, "")
            total = sum(len(value.encode("utf-8")) for value in self.files.values()) - len(before.encode("utf-8")) + len(content.encode("utf-8"))
            if total > MAX_TOTAL_BYTES:
                raise ValueError("虚拟项目总大小超过 500 KB。")
            self.files[normalized] = content
            return json.dumps({
                "success": True,
                "projectId": self.project_id,
                "path": normalized,
                "content": content,
                "diff": _diff(normalized, before, content),
                "changed": before != content,
            }, ensure_ascii=False)
        except ValueError as exc:
            return json.dumps({"success": False, "error": str(exc)}, ensure_ascii=False)


@tool
def list_preview_files() -> str:
    """List paths in the browser-only Preview Project Virtual FS. Use this before editing a preview page."""
    return '{"success":false,"error":"Preview Project context unavailable"}'


@tool
def read_preview_file(path: str) -> str:
    """Read one Preview Project virtual file, such as /src/App.tsx. Never reads local disk."""
    return '{"success":false,"error":"Preview Project context unavailable"}'


@tool
def write_preview_file(path: str, content: str) -> str:
    """Create or replace one Preview Project virtual source file. Content must be the complete file. Never writes local disk."""
    return '{"success":false,"error":"Preview Project context unavailable"}'


PREVIEW_TOOLS = [list_preview_files, read_preview_file, write_preview_file]
PREVIEW_TOOL_NAMES = {item.name for item in PREVIEW_TOOLS} | {"set_3d_scene"}


def execute_preview_tool(workspace: PreviewProjectWorkspace | None, name: str, args: dict) -> str:
    if workspace is None:
        return '{"success":false,"error":"请求中没有 Preview Project 快照。"}'
    if name == "list_preview_files":
        return workspace.list_files()
    if name == "read_preview_file":
        return workspace.read_file(args.get("path", ""))
    if name == "write_preview_file":
        return workspace.write_file(args.get("path", ""), args.get("content", ""))
    if name == "set_3d_scene":
        try:
            current = None
            serialized = workspace.files.get("/src/scene.json")
            if serialized:
                try:
                    current = json.loads(serialized)
                except json.JSONDecodeError:
                    raise ValueError("当前 /src/scene.json 无法解析；请重新创建场景。")
            scene = apply_scene_command(current, args)
            result = workspace.write_file(
                "/src/scene.json",
                json.dumps(scene, ensure_ascii=False, separators=(",", ":")),
            )
            parsed = json.loads(result)
            if parsed.get("success"):
                return json.dumps({"success": True, "sceneSpec": scene}, ensure_ascii=False)
            return result
        except (ValueError, TypeError) as exc:
            return json.dumps({"success": False, "error": str(exc)}, ensure_ascii=False)
    return '{"success":false,"error":"未知 Preview Project 工具。"}'
