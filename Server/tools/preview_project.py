"""LangChain tool definitions and compatibility dispatch for Preview Projects."""

import json
from typing import Any

from langchain_core.tools import tool

from project_api.preview_context import create_current_preview_project_api
from project_api.types import ProjectAPIError
from tools.scene_spec import apply_scene_command


@tool
def list_preview_files() -> str:
    """List paths in the browser-only Preview Project Virtual FS. Use this before editing a preview page."""
    return '{"success":false,"error":"Preview Project context unavailable"}'


@tool
def read_preview_file(path: str, start_line: int | None = None, end_line: int | None = None) -> str:
    """Read Preview source only when search snippets are insufficient. Prefer a one-based line range around the match (about 30-60 lines); omit both range values only for a small file or when whole-file context is genuinely required. Returns totalLines and current revision; never reads local disk."""
    return '{"success":false,"error":"Preview Project context unavailable"}'


@tool
def search_preview_code(query: str, path: str | None = None, max_results: int = 20) -> str:
    """Search literal text across the current Preview Project source files. Returns only matching paths, line ranges, and short snippets (maximum 50 results); optionally limit to one path."""
    return '[]'


@tool
def write_preview_file(path: str, content: str) -> str:
    """Create a new Preview source file or replace one during a full restructure. For small edits to existing files use patch_preview_file. Never writes local disk."""
    return '{"success":false,"error":"Preview Project context unavailable"}'


@tool
def patch_preview_file(path: str, old_text: str, new_text: str, expected_revision: int | None = None) -> str:
    """Replace one exact, unique text fragment in an existing Preview source file. Use a sufficient unique search snippet directly when possible; otherwise use a recent local read. Always pass the latest revision from list/read/patch."""
    return '{"success":false,"error":"Preview Project context unavailable"}'


@tool
def batch_patch_preview_files(expected_revision: int, patches: list[dict]) -> str:
    """Atomically apply multiple exact old_text → new_text patches across existing Preview text files. Pass the latest project revision. Each old_text must uniquely match the same current revision. Returns only concise per-file diffs and increments revision once."""
    return '{"success":false,"error":"Preview Project context unavailable"}'


PREVIEW_TOOLS = [list_preview_files, search_preview_code, read_preview_file, write_preview_file, patch_preview_file, batch_patch_preview_files]
PREVIEW_TOOL_NAMES = {item.name for item in PREVIEW_TOOLS} | {"set_3d_scene"}


def _preview_tool_response(result: object, operation: str) -> str:
    if isinstance(result, list):
        return json.dumps(result, ensure_ascii=False)
    if not isinstance(result, dict):
        return json.dumps({"success": False, "error": "Project API 返回格式无效。"}, ensure_ascii=False)
    payload = dict(result)
    if "version" in payload:
        payload["revision"] = payload.pop("version")
    code = payload.get("code")
    if code == "VERSION_CONFLICT":
        payload["code"] = "PATCH_REVISION_CONFLICT"
    elif code == "PATCH_OVERLAP_CONFLICT":
        payload["code"] = "PATCH_OVERLAPPING"
    elif code in {"INVALID_PATH", "FILE_NOT_FOUND"}:
        payload.pop("code", None)
    elif code == "UNSUPPORTED_OPERATION":
        message = str(payload.get("error") or "")
        if operation in {"patch", "batch_patch"}:
            payload["code"] = "PATCH_SIZE_LIMIT" if "超过" in message else "PATCH_INVALID"
        else:
            payload.pop("code", None)
    return json.dumps(payload, ensure_ascii=False)


async def execute_preview_tool(workspace: Any | None, name: str, args: dict) -> str:
    if workspace is None:
        return '{"success":false,"error":"请求中没有 Preview Project 快照。"}'
    current = create_current_preview_project_api(workspace)
    if current is None:
        return '{"success":false,"error":"当前 Preview Project 无法解析。"}'
    project_api, project_ref = current
    try:
        if name == "list_preview_files":
            result = await project_api.list_files(project_ref)
            if isinstance(result, dict) and result.get("success"):
                result = {**result, "template": workspace.template}
            return _preview_tool_response(result, "list")
        if name == "search_preview_code":
            result = await project_api.search_code(
                project_ref, args.get("query", ""), args.get("path"), args.get("max_results", 20)
            )
            return _preview_tool_response(result, "search")
        if name == "read_preview_file":
            result = await project_api.read_file(
                project_ref, args.get("path", ""), args.get("start_line"), args.get("end_line")
            )
            return _preview_tool_response(result, "read")
        if name == "write_preview_file":
            result = await project_api.write_file(
                project_ref, args.get("path", ""), args.get("content", "")
            )
            return _preview_tool_response(result, "write")
        if name == "patch_preview_file":
            result = await project_api.patch_file(
                project_ref,
                args.get("path", ""),
                args.get("old_text", ""),
                args.get("new_text", ""),
                args.get("expected_revision"),
            )
            return _preview_tool_response(result, "patch")
        if name == "batch_patch_preview_files":
            result = await project_api.apply_patches(
                project_ref, args.get("patches", []), args.get("expected_revision")
            )
            return _preview_tool_response(result, "batch_patch")
        if name == "set_3d_scene":
            current_result = await project_api.read_file(project_ref, "/src/scene.json")
            current_scene = None
            if current_result.get("success"):
                try:
                    current_scene = json.loads(current_result.get("content", ""))
                except json.JSONDecodeError:
                    raise ValueError("当前 /src/scene.json 无法解析；请重新创建场景。")
            elif current_result.get("code") != "FILE_NOT_FOUND":
                return _preview_tool_response(current_result, "read")
            scene = apply_scene_command(current_scene, args)
            version = await project_api.get_version(project_ref)
            result = await project_api.write_file(
                project_ref,
                "/src/scene.json",
                json.dumps(scene, ensure_ascii=False, separators=(",", ":")),
                version,
            )
            if result.get("success"):
                workspace.template = "html"
                return json.dumps({
                    "success": True,
                    "sceneSpec": scene,
                    "changed": result.get("changed", False),
                    "revision": result.get("version", version),
                }, ensure_ascii=False)
            return _preview_tool_response(result, "write")
        return '{"success":false,"error":"未知 Preview Project 工具。"}'
    except ProjectAPIError as exc:
        return json.dumps({"success": False, "code": exc.code, "error": exc.message}, ensure_ascii=False)
    except (TypeError, ValueError) as exc:
        return json.dumps({"success": False, "error": str(exc)}, ensure_ascii=False)
