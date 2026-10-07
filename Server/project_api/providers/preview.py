"""Preview Project adapter. No database, session, Agent, or Tool dependencies."""

from typing import Any

from project_api.provider import ProjectProvider
from project_api.types import ProjectRef
from services.preview_project_service import PreviewProjectService


_PREVIEW_TO_PROJECT_ERRORS = {
    "PATCH_REVISION_CONFLICT": "VERSION_CONFLICT",
    "PATCH_OVERLAPPING": "PATCH_OVERLAP_CONFLICT",
    "PATCH_OVERLAP_CONFLICT": "PATCH_OVERLAP_CONFLICT",
    "PATCH_TARGET_NOT_FOUND": "PATCH_TARGET_NOT_FOUND",
    "PATCH_TARGET_NOT_UNIQUE": "PATCH_TARGET_NOT_UNIQUE",
}


def _generic_error_code(payload: dict[str, Any], operation: str) -> str:
    code = payload.get("code")
    if isinstance(code, str):
        if code in _PREVIEW_TO_PROJECT_ERRORS:
            return _PREVIEW_TO_PROJECT_ERRORS[code]
        if code in {"PATCH_INVALID", "PATCH_SIZE_LIMIT"}:
            return "UNSUPPORTED_OPERATION"
    message = str(payload.get("error") or "")
    if "路径" in message or "穿越" in message or "受保护" in message or "名称" in message:
        return "INVALID_PATH"
    if "文件不存在" in message or "文件不在" in message:
        return "FILE_NOT_FOUND"
    if operation == "project":
        return "PROJECT_NOT_FOUND"
    return "UNSUPPORTED_OPERATION"


class PreviewProjectProvider:
    def __init__(self, service: PreviewProjectService):
        self._service = service

    def _matches(self, project_ref: ProjectRef) -> bool:
        return project_ref.provider == "preview" and project_ref.project_id == self._service.project_id

    def _normalize(self, payload: Any, operation: str) -> Any:
        if isinstance(payload, list):
            return payload
        if not isinstance(payload, dict):
            return {"success": False, "code": "UNSUPPORTED_OPERATION", "error": "Preview Provider 返回无效结果。"}
        result = dict(payload)
        if not result.get("success"):
            result["code"] = _generic_error_code(result, operation)
        if "revision" in result:
            result["version"] = result.pop("revision")
        return result

    def _not_found(self) -> dict[str, Any]:
        return {"success": False, "code": "PROJECT_NOT_FOUND", "error": "Preview Project 不存在。"}

    async def list_files(self, project_ref: ProjectRef) -> dict[str, Any]:
        if not self._matches(project_ref):
            return self._not_found()
        raw = self._normalize(self._service.list_files(), "project")
        if raw.get("success"):
            return {key: raw[key] for key in ("success", "projectId", "files", "version") if key in raw}
        return raw

    async def search_code(
        self,
        project_ref: ProjectRef,
        query: str,
        path: str | None = None,
        max_results: int = 20,
    ) -> list[dict[str, Any]] | dict[str, Any]:
        if not self._matches(project_ref):
            return self._not_found()
        return self._normalize(self._service.search_code(query, path, max_results), "search")

    async def read_file(
        self,
        project_ref: ProjectRef,
        path: str,
        start_line: int | None = None,
        end_line: int | None = None,
    ) -> dict[str, Any]:
        if not self._matches(project_ref):
            return self._not_found()
        return self._normalize(self._service.read_file(path, start_line, end_line), "read")

    async def patch_file(
        self,
        project_ref: ProjectRef,
        path: str,
        old_text: str,
        new_text: str,
        expected_version: int | str | None = None,
    ) -> dict[str, Any]:
        if not self._matches(project_ref):
            return self._not_found()
        return self._normalize(
            self._service.patch_file(path, old_text, new_text, expected_version), "patch"
        )

    async def apply_patches(
        self,
        project_ref: ProjectRef,
        patches: list[dict[str, Any]],
        expected_version: int | str | None = None,
    ) -> dict[str, Any]:
        if not self._matches(project_ref):
            return self._not_found()
        return self._normalize(self._service.apply_patches(patches, expected_version), "patch")

    async def write_file(
        self,
        project_ref: ProjectRef,
        path: str,
        content: str,
        expected_version: int | str | None = None,
    ) -> dict[str, Any]:
        if not self._matches(project_ref):
            return self._not_found()
        return self._normalize(
            self._service.write_file(path, content, expected_version), "write"
        )

    async def create_file(
        self, project_ref: ProjectRef, path: str, content: str = ""
    ) -> dict[str, Any]:
        del path, content
        if not self._matches(project_ref):
            return self._not_found()
        return {"success": False, "code": "UNSUPPORTED_OPERATION", "error": "Preview Provider 不支持通用文件创建。"}

    async def create_directory(self, project_ref: ProjectRef, path: str) -> dict[str, Any]:
        del path
        if not self._matches(project_ref):
            return self._not_found()
        return {"success": False, "code": "UNSUPPORTED_OPERATION", "error": "Preview Provider 不支持目录创建。"}

    async def delete_file(
        self,
        project_ref: ProjectRef,
        path: str,
        expected_version: int | str | None = None,
    ) -> dict[str, Any]:
        del path, expected_version
        if not self._matches(project_ref):
            return self._not_found()
        return {"success": False, "code": "UNSUPPORTED_OPERATION", "error": "Preview Provider 不支持通用文件删除。"}

    async def delete_directory(
        self, project_ref: ProjectRef, path: str, recursive: bool = False
    ) -> dict[str, Any]:
        del path, recursive
        if not self._matches(project_ref):
            return self._not_found()
        return {"success": False, "code": "UNSUPPORTED_OPERATION", "error": "Preview Provider 不支持目录删除。"}

    async def get_version(self, project_ref: ProjectRef) -> int | str:
        if not self._matches(project_ref):
            raise ValueError("Preview Project 不存在。")
        return self._service.get_version()

    async def get_capabilities(self, project_ref: ProjectRef) -> dict[str, bool]:
        if not self._matches(project_ref):
            return {}
        return {
            "listFiles": True,
            "searchCode": True,
            "rangeRead": True,
            "patch": True,
            "batchPatch": True,
            "write": True,
            "createFile": False,
            "createDirectory": False,
            "deleteFile": False,
            "deleteDirectory": False,
            "recursiveDelete": False,
            "build": True,
            "diagnostics": True,
            "terminal": False,
            "git": False,
            "renameSymbol": False,
        }
