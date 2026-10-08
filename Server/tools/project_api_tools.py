"""Provider-neutral project tool schemas used by Project API adapters."""

import json

from langchain_core.tools import tool


def _adapter_only(name: str) -> str:
    return json.dumps({
        "success": False,
        "code": "PROJECT_CONTEXT_UNAVAILABLE",
        "error": f"{name} 只能由当前请求的 Project API 上下文执行。",
    }, ensure_ascii=False)


@tool
def list_project_files(root: str | None = None) -> str:
    """List files in the current project. Directory/cache support depends on its Provider. root selects a VS Code workspace root, never a disk path."""
    return _adapter_only("list_project_files")


@tool
def search_project_code(
    query: str,
    path: str | None = None,
    root: str | None = None,
    max_results: int = 20,
) -> str:
    """Search text in the currently attached project workspace and return bounded snippets, not entire files."""
    return _adapter_only("search_project_code")


@tool
def read_project_file(
    path: str,
    start_line: int | None = None,
    end_line: int | None = None,
    root: str | None = None,
) -> str:
    """Read a text file or one-based line range from the currently attached project workspace. Paths are workspace-relative."""
    return _adapter_only("read_project_file")


@tool
def patch_project_file(
    path: str,
    old_text: str,
    new_text: str,
    expected_file_version: int | None = None,
    root: str | None = None,
    expected_version: int | None = None,
) -> str:
    """Replace one unique exact fragment from a fresh search/read. expected_version is the Web project version or VS Code fileVersion. expected_file_version is a compatibility alias; no automatic disk save."""
    return _adapter_only("patch_project_file")


@tool
def batch_patch_project_files(
    patches: list[dict],
    root: str | None = None,
    expected_version: int | None = None,
) -> str:
    """Apply exact patches atomically, each with path, old_text and new_text. Web requires the latest project expected_version at batch level; VS Code needs each patch's latest file expected_version (legacy expected_file_version accepted). Failure changes nothing."""
    return _adapter_only("batch_patch_project_files")


@tool
def write_project_file(
    path: str,
    content: str,
    expected_file_version: int | None = None,
    root: str | None = None,
    expected_version: int | None = None,
) -> str:
    """Write full text according to current Provider rules. Web upserts a virtual file; VS Code replaces an existing editor document without saving. Read existing content first. expected_version comes from the latest project/file read; expected_file_version is a legacy alias."""
    return _adapter_only("write_project_file")


@tool
def create_project_file(path: str, content: str = "", root: str | None = None) -> str:
    """Create a new text file only when the current Provider supports createFile. Existing files are never overwritten; paths are project-relative."""
    return _adapter_only("create_project_file")


@tool
def create_project_directory(path: str, root: str | None = None) -> str:
    """Create a project-relative directory only when the current Provider supports createDirectory."""
    return _adapter_only("create_project_directory")


@tool
def delete_project_file(
    path: str,
    expected_file_version: int | None = None,
    root: str | None = None,
    expected_version: int | None = None,
) -> str:
    """Delete one explicitly requested file if deleteFile is supported. Use its latest expected_version; expected_file_version is a legacy alias. Provider permissions and dirty-document protection remain enforced."""
    return _adapter_only("delete_project_file")


@tool
def delete_project_directory(path: str, root: str | None = None) -> str:
    """Delete one explicitly requested empty project directory if deleteDirectory is supported. Never recursive."""
    return _adapter_only("delete_project_directory")
