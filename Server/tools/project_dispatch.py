"""One dispatch path for both hosts, with no filesystem or Preview side effects."""

from project_api.operations import PROJECT_TOOL_CAPABILITIES, canonical_project_tool
from project_api.types import ProjectAPIError, ProjectRef


def expected_version(args: dict):
    values = [args[key] for key in ("expected_version", "expected_file_version", "expected_revision")
              if args.get(key) is not None]
    if values and any(value != values[0] for value in values[1:]):
        raise ProjectAPIError("VERSION_CONFLICT", "版本参数互相冲突，请使用最新读取结果的 expected_version。")
    return values[0] if values else None


async def dispatch_project_tool(context, name: str, args: dict):
    name = canonical_project_tool(name)
    if context is None:
        raise ProjectAPIError("PROJECT_CONTEXT_UNAVAILABLE", "当前请求没有已连接的项目工作区。")
    api, current_ref = context
    root = args.get("root", current_ref.root)
    if root is not None and not isinstance(root, str):
        raise ProjectAPIError("WORKSPACE_ROOT_REQUIRED", "root 必须是工作区 root id 或名称。")
    root = (root.strip() or None) if isinstance(root, str) else None
    if current_ref.provider == "preview" and root is not None:
        raise ProjectAPIError("INVALID_PATH", "Web 虚拟项目不接受 VS Code root 选择器。")
    ref = ProjectRef(current_ref.project_id, current_ref.provider, root)
    # Minimal protocol doubles can omit introspection; real ProjectAPI always has it.
    if callable(getattr(api, "get_capabilities", None)):
        capabilities = await api.get_capabilities(ref)
        if capabilities.get(PROJECT_TOOL_CAPABILITIES.get(name)) is not True:
            raise ProjectAPIError("UNSUPPORTED_OPERATION", "当前项目 Provider 不支持此操作。")
    path = args.get("path", "")
    if name == "list_project_files":
        result = await api.list_files(ref)
    elif name == "search_project_code":
        result = await api.search_code(ref, args.get("query", ""), args.get("path"), args.get("max_results", 20))
    elif name == "read_project_file":
        result = await api.read_file(ref, path, args.get("start_line"), args.get("end_line"))
    elif name == "patch_project_file":
        result = await api.patch_file(ref, path, args.get("old_text", ""), args.get("new_text", ""), expected_version(args))
    elif name == "batch_patch_project_files":
        patches = args.get("patches", [])
        if not isinstance(patches, list) or any(not isinstance(item, dict) for item in patches):
            raise ProjectAPIError("PATCH_INVALID", "patches 必须是补丁对象列表。")
        normalized = []
        for patch in patches:
            version = expected_version(patch)
            normalized.append({**patch, **({"expected_file_version": version} if version is not None else {})})
        result = await api.apply_patches(ref, normalized, expected_version(args))
    elif name == "write_project_file":
        result = await api.write_file(ref, path, args.get("content", ""), expected_version(args))
    elif name == "create_project_file":
        result = await api.create_file(ref, path, args.get("content", ""))
    elif name == "create_project_directory":
        result = await api.create_directory(ref, path)
    elif name == "delete_project_file":
        result = await api.delete_file(ref, path, expected_version(args))
    elif name == "delete_project_directory":
        result = await api.delete_directory(ref, path, recursive=False)
    elif name == "git_status":
        result = await api.git_status(ref, args.get("include_diff") is True)
    elif name == "git_commit":
        paths = args.get("paths")
        if paths is not None and (not isinstance(paths, list) or any(not isinstance(p, str) for p in paths)):
            raise ProjectAPIError("INVALID_PATH", "paths 必须是工作区相对路径列表。")
        result = await api.git_commit(ref, str(args.get("message") or ""), paths)
    elif name == "git_push":
        remote = args.get("remote")
        result = await api.git_push(ref, remote if isinstance(remote, str) and remote.strip() else None)
    elif name == "list_toolchains":
        result = await api.toolchain_list(ref)
    elif name == "run_toolchain_action":
        toolchain, action = args.get("toolchain"), args.get("action")
        if not isinstance(toolchain, str) or not toolchain.strip() or not isinstance(action, str) or not action.strip():
            raise ProjectAPIError("INVALID_PARAMS", "toolchain 与 action 必须是非空字符串。")
        params = args.get("params")
        if params is not None and not isinstance(params, dict):
            raise ProjectAPIError("INVALID_PARAMS", "params 必须是对象。")
        cwd = args.get("cwd")
        if cwd is not None and not isinstance(cwd, str):
            raise ProjectAPIError("INVALID_PATH", "cwd 必须是工作区相对目录。")
        result = await api.toolchain_run(ref, toolchain.strip(), action.strip(), params or {}, (cwd or "").strip() or None)
    else:
        raise ProjectAPIError("UNSUPPORTED_OPERATION", "未知项目操作。")
    if isinstance(result, dict):
        # Add common metadata, but preserve provider fields and legacy consumers.
        result = {**result, "projectId": current_ref.project_id, "provider": current_ref.provider}
        if "version" not in result and result.get("fileVersion") is not None:
            result["version"] = result["fileVersion"]
    return result
