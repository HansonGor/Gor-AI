"""ProjectProvider backed by VS Code workspace RPC."""

from typing import Any

from project_api.provider import ProjectProvider
from project_api.types import ProjectAPIError, ProjectRef
from services.vscode_bridge import VSCodeBridgeClient, vscode_bridge


class VSCodeProjectProvider:
    def __init__(self, bridge: VSCodeBridgeClient = vscode_bridge):
        self._bridge = bridge

    async def _tree(self, project_ref: ProjectRef, *, refresh: bool = False) -> dict[str, Any]:
        self._validate(project_ref)

        async def load() -> dict[str, Any]:
            result = await self._bridge.call(
                project_ref.project_id,
                "project.listFiles",
                {"root": project_ref.root},
            )
            if not isinstance(result, dict):
                raise ProjectAPIError("WORKSPACE_REQUEST_FAILED", "VS Code 文件列表响应无效。")
            return result

        return await self._bridge.get_workspace_tree(
            project_ref.project_id, project_ref.root, load, refresh=refresh
        )

    async def _call(
        self,
        project_ref: ProjectRef,
        method: str,
        params: dict[str, Any],
        *,
        mutation: str | None = None,
    ) -> Any:
        # Prime the workspace tree once per active VS Code connection and root,
        # even when the model starts with a guessed or user-provided file path.
        await self._tree(project_ref)
        try:
            result = await self._bridge.call(project_ref.project_id, method, params)
        except ProjectAPIError as error:
            if error.code in {
                "FILE_NOT_FOUND", "DIRECTORY_NOT_FOUND",
                "FILE_ALREADY_EXISTS", "DIRECTORY_ALREADY_EXISTS",
            }:
                # A path-level conflict proves our cached view may be stale.
                # Refresh once, but do not silently retry the user's operation.
                try:
                    await self._tree(project_ref, refresh=True)
                except ProjectAPIError:
                    pass
            raise
        if mutation and isinstance(result, dict) and result.get("success") is True:
            path = result.get("path")
            if isinstance(path, str):
                self._bridge.update_workspace_tree(
                    project_ref.project_id,
                    project_ref.root,
                    lambda snapshot: self._apply_tree_mutation(snapshot, mutation, path),
                )
        return result

    @staticmethod
    def _apply_tree_mutation(snapshot: dict[str, Any], operation: str, path: str) -> None:
        normalized = "/" + "/".join(part for part in path.split("/") if part)
        files = set(item for item in snapshot.get("files", []) if isinstance(item, str))
        directories = set(item for item in snapshot.get("directories", []) if isinstance(item, str))
        if operation == "create_file":
            files.add(normalized)
        elif operation == "delete_file":
            files.discard(normalized)
        elif operation == "create_directory":
            parts = normalized.strip("/").split("/")
            for index in range(len(parts)):
                directories.add("/" + "/".join(parts[: index + 1]))
        elif operation == "delete_directory":
            directories = {
                item for item in directories
                if item != normalized and not item.startswith(normalized + "/")
            }
            files = {item for item in files if not item.startswith(normalized + "/")}
        snapshot["files"] = sorted(files)
        snapshot["directories"] = sorted(directories)

    @staticmethod
    def _validate(project_ref: ProjectRef) -> None:
        if project_ref.provider != "vscode" or not project_ref.project_id.startswith("vscode-"):
            raise ProjectAPIError("WORKSPACE_NOT_FOUND", "VS Code 工作区标识无效。")

    async def list_files(self, project_ref: ProjectRef) -> dict[str, Any]:
        return await self._tree(project_ref)

    async def search_code(
        self,
        project_ref: ProjectRef,
        query: str,
        path: str | None = None,
        max_results: int = 20,
    ) -> list[dict[str, Any]] | dict[str, Any]:
        self._validate(project_ref)
        result = await self._call(
            project_ref,
            "project.searchCode",
            {"query": query, "path": path, "root": project_ref.root, "maxResults": max_results},
        )
        if not isinstance(result, (dict, list)):
            raise ProjectAPIError("WORKSPACE_REQUEST_FAILED", "VS Code 搜索响应无效。")
        return result

    async def read_file(
        self,
        project_ref: ProjectRef,
        path: str,
        start_line: int | None = None,
        end_line: int | None = None,
    ) -> dict[str, Any]:
        self._validate(project_ref)
        result = await self._call(
            project_ref,
            "project.readFile",
            {
                "path": path,
                "startLine": start_line,
                "endLine": end_line,
                "root": project_ref.root,
            },
        )
        if not isinstance(result, dict):
            raise ProjectAPIError("WORKSPACE_REQUEST_FAILED", "VS Code 文件读取响应无效。")
        return result

    async def patch_file(
        self,
        project_ref: ProjectRef,
        path: str,
        old_text: str,
        new_text: str,
        expected_version: int | str | None = None,
    ) -> dict[str, Any]:
        self._validate(project_ref)
        result = await self._call(
            project_ref,
            "project.patchFile",
            {
                "path": path,
                "oldText": old_text,
                "newText": new_text,
                "expectedFileVersion": expected_version,
                "root": project_ref.root,
            },
        )
        if not isinstance(result, dict):
            raise ProjectAPIError("WORKSPACE_REQUEST_FAILED", "VS Code patch 响应无效。")
        return result

    async def apply_patches(
        self,
        project_ref: ProjectRef,
        patches: list[dict[str, Any]],
        expected_version: int | str | None = None,
    ) -> dict[str, Any]:
        self._validate(project_ref)
        normalized: list[dict[str, Any]] = []
        for patch in patches:
            if not isinstance(patch, dict):
                raise ProjectAPIError("WORKSPACE_REQUEST_FAILED", "batch patch 中的每项都必须是对象。")
            normalized_patch = {
                "path": patch.get("path"),
                "oldText": patch.get("old_text", patch.get("oldText")),
                "newText": patch.get("new_text", patch.get("newText")),
                "expectedFileVersion": patch.get(
                    "expected_file_version",
                    patch.get("expectedFileVersion", expected_version),
                ),
            }
            patch_root = patch.get("root", project_ref.root)
            if patch_root is not None:
                normalized_patch["root"] = patch_root
            normalized.append(normalized_patch)
        result = await self._call(
            project_ref,
            "project.applyPatches",
            {"patches": normalized, "root": project_ref.root},
        )
        if not isinstance(result, dict):
            raise ProjectAPIError("WORKSPACE_REQUEST_FAILED", "VS Code batch patch 响应无效。")
        return result

    async def write_file(
        self,
        project_ref: ProjectRef,
        path: str,
        content: str,
        expected_version: int | str | None = None,
    ) -> dict[str, Any]:
        self._validate(project_ref)
        result = await self._call(
            project_ref,
            "project.writeFile",
            {
                "path": path,
                "content": content,
                "expectedFileVersion": expected_version,
                "root": project_ref.root,
            },
        )
        if not isinstance(result, dict):
            raise ProjectAPIError("WORKSPACE_REQUEST_FAILED", "VS Code write 响应无效。")
        return result

    async def create_file(
        self, project_ref: ProjectRef, path: str, content: str = ""
    ) -> dict[str, Any]:
        self._validate(project_ref)
        result = await self._call(
            project_ref,
            "project.createFile",
            {"path": path, "content": content, "root": project_ref.root},
            mutation="create_file",
        )
        if not isinstance(result, dict):
            raise ProjectAPIError("WORKSPACE_REQUEST_FAILED", "VS Code create file 响应无效。")
        return result

    async def create_directory(self, project_ref: ProjectRef, path: str) -> dict[str, Any]:
        self._validate(project_ref)
        result = await self._call(
            project_ref,
            "project.createDirectory",
            {"path": path, "root": project_ref.root},
            mutation="create_directory",
        )
        if not isinstance(result, dict):
            raise ProjectAPIError("WORKSPACE_REQUEST_FAILED", "VS Code create directory 响应无效。")
        return result

    async def delete_file(
        self,
        project_ref: ProjectRef,
        path: str,
        expected_version: int | str | None = None,
    ) -> dict[str, Any]:
        self._validate(project_ref)
        result = await self._call(
            project_ref,
            "project.deleteFile",
            {"path": path, "expectedFileVersion": expected_version, "root": project_ref.root},
            mutation="delete_file",
        )
        if not isinstance(result, dict):
            raise ProjectAPIError("WORKSPACE_REQUEST_FAILED", "VS Code delete file 响应无效。")
        return result

    async def delete_directory(
        self, project_ref: ProjectRef, path: str, recursive: bool = False
    ) -> dict[str, Any]:
        self._validate(project_ref)
        result = await self._call(
            project_ref,
            "project.deleteDirectory",
            {"path": path, "recursive": recursive, "root": project_ref.root},
            mutation="delete_directory",
        )
        if not isinstance(result, dict):
            raise ProjectAPIError("WORKSPACE_REQUEST_FAILED", "VS Code delete directory 响应无效。")
        return result

    async def get_version(self, project_ref: ProjectRef) -> int | str:
        """Return the connection generation, not a workspace content snapshot version."""
        self._validate(project_ref)
        return self._bridge.workspace_generation(project_ref.project_id)

    async def get_capabilities(self, project_ref: ProjectRef) -> dict[str, bool]:
        self._validate(project_ref)
        return {
            "listFiles": True,
            "searchCode": True,
            "rangeRead": True,
            "patch": True,
            "batchPatch": True,
            "write": True,
            "createFile": True,
            "createDirectory": True,
            "deleteFile": True,
            "deleteDirectory": True,
            "recursiveDelete": False,
            "build": False,
            "diagnostics": False,
            "terminal": False,
            "git": False,
        }
