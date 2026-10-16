"""Generic project operations. This module has no chat, storage, or LLM knowledge."""

from typing import Any

from project_api.registry import ProjectProviderRegistry
from project_api.types import ProjectRef


class ProjectAPI:
    def __init__(self, registry: ProjectProviderRegistry):
        self._registry = registry

    def _provider(self, project_ref: ProjectRef):
        return self._registry.resolve(project_ref.provider)

    async def list_files(self, project_ref: ProjectRef) -> dict[str, Any]:
        return await self._provider(project_ref).list_files(project_ref)

    async def search_code(
        self,
        project_ref: ProjectRef,
        query: str,
        path: str | None = None,
        max_results: int = 20,
    ) -> list[dict[str, Any]] | dict[str, Any]:
        return await self._provider(project_ref).search_code(project_ref, query, path, max_results)

    async def read_file(
        self,
        project_ref: ProjectRef,
        path: str,
        start_line: int | None = None,
        end_line: int | None = None,
    ) -> dict[str, Any]:
        return await self._provider(project_ref).read_file(project_ref, path, start_line, end_line)

    async def patch_file(
        self,
        project_ref: ProjectRef,
        path: str,
        old_text: str,
        new_text: str,
        expected_version: int | str | None = None,
    ) -> dict[str, Any]:
        return await self._provider(project_ref).patch_file(
            project_ref, path, old_text, new_text, expected_version
        )

    async def apply_patches(
        self,
        project_ref: ProjectRef,
        patches: list[dict[str, Any]],
        expected_version: int | str | None = None,
    ) -> dict[str, Any]:
        return await self._provider(project_ref).apply_patches(project_ref, patches, expected_version)

    async def write_file(
        self,
        project_ref: ProjectRef,
        path: str,
        content: str,
        expected_version: int | str | None = None,
    ) -> dict[str, Any]:
        return await self._provider(project_ref).write_file(
            project_ref, path, content, expected_version
        )

    async def create_file(
        self, project_ref: ProjectRef, path: str, content: str = ""
    ) -> dict[str, Any]:
        return await self._provider(project_ref).create_file(project_ref, path, content)

    async def create_directory(self, project_ref: ProjectRef, path: str) -> dict[str, Any]:
        return await self._provider(project_ref).create_directory(project_ref, path)

    async def delete_file(
        self,
        project_ref: ProjectRef,
        path: str,
        expected_version: int | str | None = None,
    ) -> dict[str, Any]:
        return await self._provider(project_ref).delete_file(project_ref, path, expected_version)

    async def delete_directory(
        self, project_ref: ProjectRef, path: str, recursive: bool = False
    ) -> dict[str, Any]:
        return await self._provider(project_ref).delete_directory(project_ref, path, recursive)

    async def git_status(self, project_ref: ProjectRef, include_diff: bool = False) -> dict[str, Any]:
        return await self._provider(project_ref).git_status(project_ref, include_diff)

    async def git_commit(
        self, project_ref: ProjectRef, message: str, paths: list[str] | None = None
    ) -> dict[str, Any]:
        return await self._provider(project_ref).git_commit(project_ref, message, paths)

    async def git_push(self, project_ref: ProjectRef, remote: str | None = None) -> dict[str, Any]:
        return await self._provider(project_ref).git_push(project_ref, remote)

    async def delete_project(self, project_ref: ProjectRef, path: str) -> dict[str, Any]:
        return await self._provider(project_ref).delete_project(project_ref, path)

    async def external_read_file(
        self, project_ref: ProjectRef, path: str, start_line: int | None = None, end_line: int | None = None,
    ) -> dict[str, Any]:
        return await self._provider(project_ref).external_read_file(project_ref, path, start_line, end_line)

    async def external_list_directory(self, project_ref: ProjectRef, path: str) -> dict[str, Any]:
        return await self._provider(project_ref).external_list_directory(project_ref, path)

    async def toolchain_list(self, project_ref: ProjectRef) -> dict[str, Any]:
        return await self._provider(project_ref).toolchain_list(project_ref)

    async def toolchain_run(
        self, project_ref: ProjectRef, toolchain: str, action: str,
        params: dict[str, Any] | None = None, cwd: str | None = None,
    ) -> dict[str, Any]:
        return await self._provider(project_ref).toolchain_run(project_ref, toolchain, action, params, cwd)

    async def get_version(self, project_ref: ProjectRef) -> int | str:
        return await self._provider(project_ref).get_version(project_ref)

    async def get_capabilities(self, project_ref: ProjectRef) -> dict[str, bool]:
        return await self._provider(project_ref).get_capabilities(project_ref)
