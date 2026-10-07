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
    """List the cached files and directories in the attached VS Code workspace. On multi-root workspaces, pass a root id/name from the root-required response."""
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
) -> str:
    """Replace one exact, unique text fragment in an existing project text file. Use old_text from the latest search/read result and pass its fileVersion as expected_file_version. Does not create or save files."""
    return _adapter_only("patch_project_file")


@tool
def batch_patch_project_files(
    patches: list[dict],
    root: str | None = None,
) -> str:
    """Apply several exact-text patches atomically. Every patch needs path, old_text, new_text, and expected_file_version from the latest read. All patches validate before one WorkspaceEdit; any failure changes nothing. Does not create or save files."""
    return _adapter_only("batch_patch_project_files")


@tool
def write_project_file(
    path: str,
    content: str,
    expected_file_version: int | None = None,
    root: str | None = None,
) -> str:
    """Replace the whole content of an existing text file using its latest fileVersion. Read the current file first; this does not create or automatically save a file."""
    return _adapter_only("write_project_file")


@tool
def create_project_file(path: str, content: str = "", root: str | None = None) -> str:
    """Create a new text file in the attached project workspace. The path must be workspace-relative; an existing file is never overwritten."""
    return _adapter_only("create_project_file")


@tool
def create_project_directory(path: str, root: str | None = None) -> str:
    """Create a directory in the attached project workspace. The path must be workspace-relative."""
    return _adapter_only("create_project_directory")


@tool
def delete_project_file(
    path: str,
    expected_file_version: int | None = None,
    root: str | None = None,
) -> str:
    """Delete one explicitly requested file from the attached project workspace. Dirty open files are protected; pass the latest fileVersion when available."""
    return _adapter_only("delete_project_file")


@tool
def delete_project_directory(path: str, root: str | None = None) -> str:
    """Delete one explicitly requested empty directory from the attached project workspace. Deletion is never recursive."""
    return _adapter_only("delete_project_directory")
