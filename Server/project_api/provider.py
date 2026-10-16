"""Provider contract shared by Agent tools and future project integrations."""

from typing import Any, Protocol

from project_api.types import ProjectRef


class ProjectProvider(Protocol):
    async def list_files(self, project_ref: ProjectRef) -> dict[str, Any]: ...

    async def search_code(
        self,
        project_ref: ProjectRef,
        query: str,
        path: str | None = None,
        max_results: int = 20,
    ) -> list[dict[str, Any]] | dict[str, Any]: ...

    async def read_file(
        self,
        project_ref: ProjectRef,
        path: str,
        start_line: int | None = None,
        end_line: int | None = None,
    ) -> dict[str, Any]: ...

    async def patch_file(
        self,
        project_ref: ProjectRef,
        path: str,
        old_text: str,
        new_text: str,
        expected_version: int | str | None = None,
    ) -> dict[str, Any]: ...

    async def apply_patches(
        self,
        project_ref: ProjectRef,
        patches: list[dict[str, Any]],
        expected_version: int | str | None = None,
    ) -> dict[str, Any]: ...

    async def write_file(
        self,
        project_ref: ProjectRef,
        path: str,
        content: str,
        expected_version: int | str | None = None,
    ) -> dict[str, Any]: ...

    async def create_file(
        self,
        project_ref: ProjectRef,
        path: str,
        content: str = "",
    ) -> dict[str, Any]: ...

    async def create_directory(self, project_ref: ProjectRef, path: str) -> dict[str, Any]: ...

    async def delete_file(
        self,
        project_ref: ProjectRef,
        path: str,
        expected_version: int | str | None = None,
    ) -> dict[str, Any]: ...

    async def delete_directory(
        self,
        project_ref: ProjectRef,
        path: str,
        recursive: bool = False,
    ) -> dict[str, Any]: ...

    # Git 操作为可选能力：只有 get_capabilities 声明 git=True 的 Provider 需要实现。
    async def git_status(self, project_ref: ProjectRef, include_diff: bool = False) -> dict[str, Any]: ...

    async def git_commit(
        self, project_ref: ProjectRef, message: str, paths: list[str] | None = None,
    ) -> dict[str, Any]: ...

    async def git_push(self, project_ref: ProjectRef, remote: str | None = None) -> dict[str, Any]: ...

    # 删除项目、项目外只读为可选能力：只有声明 deleteProject / externalRead 的 Provider 需要实现。
    async def delete_project(self, project_ref: ProjectRef, path: str) -> dict[str, Any]: ...

    async def external_read_file(
        self, project_ref: ProjectRef, path: str, start_line: int | None = None, end_line: int | None = None,
    ) -> dict[str, Any]: ...

    async def external_list_directory(self, project_ref: ProjectRef, path: str) -> dict[str, Any]: ...

    # 工具链为可选能力：只有 get_capabilities 声明 toolchain=True 的 Provider 需要实现。
    async def toolchain_list(self, project_ref: ProjectRef) -> dict[str, Any]: ...

    async def toolchain_run(
        self, project_ref: ProjectRef, toolchain: str, action: str,
        params: dict[str, Any] | None = None, cwd: str | None = None,
    ) -> dict[str, Any]: ...

    async def get_version(self, project_ref: ProjectRef) -> int | str: ...

    async def get_capabilities(self, project_ref: ProjectRef) -> dict[str, bool]: ...
