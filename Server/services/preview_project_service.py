"""Application operations over the request-scoped Preview Project workspace."""

import json
from typing import Any

from services.preview.workspace import PreviewProjectWorkspace


class PreviewProjectService:
    def __init__(self, workspace: PreviewProjectWorkspace):
        if not isinstance(workspace, PreviewProjectWorkspace):
            raise ValueError("Preview Project workspace is unavailable")
        self._workspace = workspace

    @property
    def project_id(self) -> str:
        return self._workspace.project_id

    @property
    def revision(self) -> int:
        return self._workspace.revision

    @staticmethod
    def _decode(result: str | dict[str, Any] | list[Any]) -> Any:
        if isinstance(result, str):
            return json.loads(result)
        return result

    def list_files(self) -> dict[str, Any]:
        return self._decode(self._workspace.list_files())

    def search_code(
        self, query: str, path: str | None = None, max_results: int = 20
    ) -> list[dict[str, Any]] | dict[str, Any]:
        return self._decode(self._workspace.search_code(query, path, max_results))

    def read_file(
        self, path: str, start_line: int | None = None, end_line: int | None = None
    ) -> dict[str, Any]:
        return self._decode(self._workspace.read_file(path, start_line, end_line))

    def patch_file(
        self,
        path: str,
        old_text: str,
        new_text: str,
        expected_revision: int | str | None = None,
    ) -> dict[str, Any]:
        return self._decode(self._workspace.patch_file(path, old_text, new_text, expected_revision))

    def apply_patches(
        self, patches: list[dict[str, Any]], expected_revision: int | str | None = None
    ) -> dict[str, Any]:
        return self._decode(self._workspace.batch_patch_files(patches, expected_revision))

    def write_file(
        self,
        path: str,
        content: str,
        expected_revision: int | str | None = None,
    ) -> dict[str, Any]:
        if expected_revision is not None and expected_revision != self.revision:
            return {
                "success": False,
                "code": "PATCH_REVISION_CONFLICT",
                "error": "Preview Project 已变化，请重新读取源码和 revision 后再写入。",
                "revision": self.revision,
            }
        return self._decode(self._workspace.write_file(path, content))

    def get_version(self) -> int:
        return self.revision
