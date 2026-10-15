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
    """Replace one unique exact fragment from a fresh search/read. expected_version is the Web project version or VS Code fileVersion. expected_file_version is a compatibility alias. Web stays virtual; VS Code saves Agent edits and rejects pre-existing unsaved changes."""
    return _adapter_only("patch_project_file")


@tool
def batch_patch_project_files(
    patches: list[dict],
    root: str | None = None,
    expected_version: int | None = None,
) -> str:
    """Apply exact patches atomically, each with path, old_text and new_text. Web requires the latest project expected_version at batch level; VS Code needs each patch's latest file expected_version (legacy expected_file_version accepted). Validation failure changes nothing; VS Code save failure can leave applied edits or partially saved files and is not success."""
    return _adapter_only("batch_patch_project_files")


@tool
def write_project_file(
    path: str,
    content: str,
    expected_file_version: int | None = None,
    root: str | None = None,
    expected_version: int | None = None,
) -> str:
    """Write full text according to current Provider rules. Web upserts a virtual file; VS Code replaces and saves an existing clean editor document, rejecting pre-existing unsaved changes. Read existing content first. expected_version comes from the latest project/file read; expected_file_version is a legacy alias."""
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


@tool
def git_status(include_diff: bool = False, root: str | None = None) -> str:
    """Read the real Git state of the connected VS Code workspace: branch, upstream, ahead/behind, staged/unstaged/untracked/conflict files, unsaved documents and recent commits. include_diff adds a bounded diff of tracked changes (sensitive files excluded) for drafting a commit message. Read-only."""
    return _adapter_only("git_status")


@tool
def git_commit(message: str, paths: list[str] | None = None, root: str | None = None) -> str:
    """Commit in the real VS Code workspace repository only when the user explicitly asks to commit. Call git_status first and write a concise message describing the actual changes. paths limits the commit to those workspace-relative files; omit to commit all changes. The user must confirm (and may edit the message) in a VS Code dialog; USER_CANCELLED means nothing happened. Rejects unsaved files, conflicts, sensitive files and changes outside the workspace. Report success only when committed is true. Never pushes."""
    return _adapter_only("git_commit")


@tool
def list_toolchains(root: str | None = None) -> str:
    """List language toolchains of the connected VS Code workspace (currently node): availability, actions with risk, and package.json scripts per package directory (cwd). Read-only; call it before run_toolchain_action when the script name or package directory is unknown."""
    return _adapter_only("list_toolchains")


@tool
def run_toolchain_action(
    toolchain: str,
    action: str,
    params: dict | None = None,
    cwd: str | None = None,
    root: str | None = None,
) -> str:
    """Run one command in the real VS Code workspace, only when the user asks to start/run the project, test, type-check, lint, build, run a package.json script or install dependencies. toolchain "node" actions: run_script (params.name = script name; "run the project" means dev, else start/serve, never build instead), install (installs from package.json/lock with the project's package manager), typecheck (tsc --noEmit), test (params.path optional), lint (params.path optional, never fixes), env, logs and stop (params.runId of a background process). cwd is the workspace-relative package directory from list_toolchains (default root). Not a terminal: no arbitrary commands. The extension decides execution: in 审阅落笔 mode the user approves each command in a card; install and long-running scripts always need approval; install/publish/delete commands hidden inside scripts are refused. dev/start/watch scripts keep running in the background: status background with url. Missing dependencies show as code DEPENDENCIES_NOT_INSTALLED or hint DEPENDENCIES_NOT_INSTALLED: explain, call install, then retry once. Read status: completed (and background/stopped for long-running processes) are success; failed means the command ran and reported problems (use diagnostics/stderr); user_cancelled or approval_timeout means it did not run, do not retry the same command; plan_changed, not_enabled, rejected, workspace_untrusted, cancelled, timed_out are not success. pendingReviewFiles means unconfirmed review edits are not on disk yet."""
    return _adapter_only("run_toolchain_action")


@tool
def git_push(remote: str | None = None, root: str | None = None) -> str:
    """Push the current branch of the real VS Code workspace repository only when the user explicitly asks to push. Uses the existing upstream, otherwise origin (or the given remote) and sets upstream. The user must confirm in a VS Code dialog; USER_CANCELLED means nothing was pushed. Never force-pushes; if the branch is behind the remote, explain and let the user pull. Report success only when pushed is true."""
    return _adapter_only("git_push")
