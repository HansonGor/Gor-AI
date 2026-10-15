"""Shared operation names; provider capabilities remain authoritative."""

PROJECT_TOOL_CAPABILITIES = {
    "list_project_files": "listFiles",
    "search_project_code": "searchCode",
    "read_project_file": "rangeRead",
    "patch_project_file": "patch",
    "batch_patch_project_files": "batchPatch",
    "write_project_file": "write",
    "create_project_file": "createFile",
    "create_project_directory": "createDirectory",
    "delete_project_file": "deleteFile",
    "delete_project_directory": "deleteDirectory",
    # 真实 Git 仓库操作：只有 VS Code Provider 声明 git 能力，Web Preview 自动过滤
    "git_status": "git",
    "git_commit": "git",
    "git_push": "git",
    # 语言工具链（第一阶段 Node 验证类命令）：只有 VS Code Provider 声明 toolchain 能力
    "list_toolchains": "toolchain",
    "run_toolchain_action": "toolchain",
}

PREVIEW_TOOL_ALIASES = {
    "list_preview_files": "list_project_files",
    "search_preview_code": "search_project_code",
    "read_preview_file": "read_project_file",
    "patch_preview_file": "patch_project_file",
    "batch_patch_preview_files": "batch_patch_project_files",
    "write_preview_file": "write_project_file",
}


def canonical_project_tool(name: str) -> str:
    return PREVIEW_TOOL_ALIASES.get(name, name)


def preview_operation_name(name: str) -> str:
    """Compatibility name for the existing Preview event/budget protocol."""
    return next((alias for alias, canonical in PREVIEW_TOOL_ALIASES.items() if canonical == name), name)


def filter_project_tools(names, capabilities: dict[str, bool]):
    return {
        name for name in names
        if (name not in PROJECT_TOOL_CAPABILITIES
            or capabilities.get(PROJECT_TOOL_CAPABILITIES[name]) is True)
        and (name != "set_3d_scene" or (
            capabilities.get("write") is True and capabilities.get("rangeRead") is True
        ))
    }
