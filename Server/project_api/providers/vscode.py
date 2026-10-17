"""ProjectProvider backed by VS Code workspace RPC."""

from typing import Any
import asyncio
import copy
import uuid

from project_api.provider import ProjectProvider
from project_api.types import ProjectAPIError, ProjectRef
from services.vscode_bridge import VSCodeBridgeClient, vscode_bridge

# 提交/推送需要等待用户在 VS Code 确认框中操作，推送还包含网络耗时
GIT_CONFIRM_TIMEOUT_SECONDS = 600.0
GIT_READ_TIMEOUT_SECONDS = 30.0
TOOLCHAIN_LIST_TIMEOUT_SECONDS = 30.0
# 审阅卡片最长等待 10 分钟，命令本身最长运行 10 分钟，另留余量
TOOLCHAIN_RUN_TIMEOUT_SECONDS = 1260.0
TOOLCHAIN_CANCEL_TIMEOUT_SECONDS = 10.0
# 删除、删除项目、项目外读取都要等用户在卡片中确认（最长 10 分钟），另留余量
CONFIRM_TIMEOUT_SECONDS = 630.0
# 取消通知是后台任务，保留引用避免被回收
_cancel_tasks: set[asyncio.Task] = set()


TEST_REPORT_GUIDE = (
    "汇报前先用 read_project_file 读取这次运行的测试文件，逐条说明用例名、断言、期望值与实际值："
    "通过的用例框架不打印实际值，按断言推出（如 assertEqual(1 + 1, 2) 通过即 1 + 1 的结果是 2）并注明由断言通过得出；"
    "失败的以输出里的 AssertionError 为准；推不出的值不要猜。用例很多时只说明失败的和用户问到的。"
)


def _is_test_run(action: str, params: dict[str, Any] | None) -> bool:
    module = (params or {}).get("module") if isinstance(params, dict) else None
    return action == "test" or (action == "run_module" and module in {"unittest", "pytest"})


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
        timeout_seconds: float | None = None,
    ) -> Any:
        # Prime the workspace tree once per active VS Code connection and root,
        # even when the model starts with a guessed or user-provided file path.
        roots = {p.get("root", project_ref.root) for p in params.get("patches", [])} if method == "project.applyPatches" else set()
        if roots and any(root is not None for root in roots):
            for root in roots:
                await self._tree(ProjectRef(project_ref.project_id, project_ref.provider, root))
        else:
            await self._tree(project_ref)
        from project_api.changes import current_recorder
        recorder = current_recorder.get()
        if recorder and recorder.edit_mode == "review":
            from project_api.review import stage_vscode, candidate_files
            if method in {"project.patchFile", "project.applyPatches", "project.writeFile", "project.createFile",
                          "project.deleteFile", "project.createDirectory", "project.deleteDirectory"}:
                return await stage_vscode(self, project_ref, method, params, recorder)
            candidates = candidate_files(recorder, project_ref)
            path = "/" + str(params.get("path", "")).lstrip("/")
            if method == "project.readFile" and path in candidates:
                state = candidates[path]
                if state["content"] is None:
                    raise ProjectAPIError("FILE_NOT_FOUND", "文件不存在。")
                lines = state["content"].splitlines(keepends=True)
                start, end = params.get("startLine"), params.get("endLine")
                if ((start is not None and (type(start) is not int or start < 1))
                    or (end is not None and (type(end) is not int or end < (start or 1)))):
                    raise ProjectAPIError("INVALID_PATH", "文件读取范围无效。")
                return {"success": True, "path": path, "content": "".join(lines[(start or 1)-1:end])
                        if start is not None or end is not None else state["content"],
                        "totalLines": len(lines), "fileVersion": state["version"], "pending": True}
        if recorder and method == "project.applyPatches" and any(p.get("root") is not None for p in params.get("patches", [])):
            return await self._recorded_root_batch(project_ref, params, recorder)
        paths = ([p["path"] for p in params.get("patches", [])] if method == "project.applyPatches"
                 else [params.get("path")]) if method in {
                     "project.patchFile", "project.applyPatches", "project.writeFile",
                     "project.createFile", "project.deleteFile"} else []
        paths = list(dict.fromkeys(paths))
        before = None
        if recorder and paths:
            before = await self.inspect_files(project_ref, paths)
            self._check_snapshot_budget([before], method, params)
            from project_api.changes import conflict
            previous = copy.deepcopy(recorder.sets.get((project_ref.provider, project_ref.project_id, project_ref.root), {}))
            for file in previous.get("files", []):
                if file["path"] in before and conflict(before[file["path"]], file["after"]):
                    raise ProjectAPIError("VERSION_CONFLICT", "文件在本轮修改之间发生变化，请重新发起请求。")
            await recorder.record(project_ref, before, before, {p: "applying" for p in before})
            params = {**params, "changeExpected": before}
        try:
            result = await self._bridge.call(project_ref.project_id, method, params,
                                             **({"timeout_seconds": timeout_seconds} if timeout_seconds else {}))
        except ProjectAPIError as error:
            if before is not None:
                receipt = error.details or {}
                after = receipt.pop("changeSnapshots", before)
                saved = receipt.get("savedFiles", [])
                saves = receipt.pop("saveReceipts", [])
                await recorder.record(project_ref, before, after,
                    {p: "applied" if p in saved and self._saved_snapshot(after[p], p, saves, receipt) else (
                        next((f["status"] for f in previous.get("files", []) if f["path"] == p), "failed")
                        if after[p] == before[p] and error.code not in {"WORKSPACE_REQUEST_TIMEOUT", "WORKSPACE_DISCONNECTED"}
                        else "failed") for p in before})
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
        if before is not None:
            after = result.pop("changeSnapshots", None)
            saves = result.pop("saveReceipts", [])
            if after is None:
                raise ProjectAPIError("CHANGE_RECORD_FAILED", "扩展未返回实际文件快照，请重载插件。")
            statuses = {}
            for path in before:
                if before[path] == after[path]:
                    statuses[path] = next((f["status"] for f in previous.get("files", []) if f["path"] == path), "unchanged")
                    continue
                safe = self._saved_snapshot(after[path], path, saves, result)
                if method == "project.createFile":
                    safe = safe and after[path]["content"] == params.get("content", "")
                elif method == "project.deleteFile":
                    safe = safe and after[path]["content"] is None
                statuses[path] = "applied" if safe else "failed"
            await recorder.record(project_ref, before, after, statuses)
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
    def _check_snapshot_budget(groups, method, params):
        size = sum(len((state["content"] or "").encode("utf-8")) for files in groups for state in files.values())
        if method in {"project.writeFile", "project.createFile"}:
            size = len(params.get("content", "").encode("utf-8"))
        elif method == "project.deleteFile":
            size = 0
        else:
            patches = params.get("patches", [params])
            size += sum(len(p.get("newText", "").encode("utf-8")) - len(p.get("oldText", "").encode("utf-8")) for p in patches)
        if size > 2_000_000:
            raise ProjectAPIError("FILE_TOO_LARGE", "变更后快照超过 2 MB 安全预算，未执行操作。")

    @staticmethod
    def _saved_snapshot(state, path, saves, receipt):
        if state.get("dirty"):
            return False
        if saves:
            return any(s.get("path") == path and s.get("identity") == state.get("identity")
                and s.get("hash") == state.get("hash") and s.get("version") == state.get("version")
                and s.get("saved") for s in saves)
        expected = receipt.get("fileVersions", {}).get(path, receipt.get("fileVersion", state["version"]))
        return expected == state["version"]

    async def _recorded_root_batch(self, ref, params, recorder):
        """Keep existing multi-root batch atomicity; journal each ProjectRef root separately."""
        from project_api.changes import current_recorder, conflict
        roots = {}
        for patch in params["patches"]:
            roots.setdefault(patch.get("root", ref.root), []).append(patch["path"])
        groups = []
        for root, paths in roots.items():
            group_ref = ProjectRef(ref.project_id, ref.provider, root)
            before = await self.inspect_files(group_ref, list(dict.fromkeys(paths)))
            previous = copy.deepcopy(recorder.sets.get((ref.provider, ref.project_id, root), {}))
            for file in previous.get("files", []):
                if file["path"] in before and conflict(before[file["path"]], file["after"]):
                    raise ProjectAPIError("VERSION_CONFLICT", "文件在本轮修改之间发生变化。")
            groups.append({"root": root, "files": before, "previous": previous})
        if sum(len((state["content"] or "").encode("utf-8")) for group in groups for state in group["files"].values()) > 2_000_000:
            raise ProjectAPIError("FILE_TOO_LARGE", "变更快照超过 2 MB 安全预算，未执行操作。")
        self._check_snapshot_budget([group["files"] for group in groups], "project.applyPatches", params)
        for group in groups:
            await recorder.record(ProjectRef(ref.project_id, ref.provider, group["root"]),
                group["files"], group["files"], {p: "applying" for p in group["files"]})
        token = current_recorder.set(None)
        error = None
        try:
            try:
                result = await self._call(ref, "project.applyPatches", {**params,
                    "changeExpectedGroups": [{"root": g["root"], "files": g["files"]} for g in groups]})
            except ProjectAPIError as exc:
                error = exc
                result = exc.details or {}
        finally:
            current_recorder.reset(token)
        after_groups = result.pop("changeSnapshotGroups", [])
        saves = result.pop("saveReceipts", [])
        for group in groups:
            before = group["files"]
            after = next((g["files"] for g in after_groups if g["root"] == group["root"]), before)
            statuses = {}
            for path in before:
                prior = next((f["status"] for f in group["previous"].get("files", []) if f["path"] == path), "unchanged")
                if error:
                    statuses[path] = "applied" if path in result.get("savedFiles", []) and self._saved_snapshot(after[path], path, saves, result) else (
                        prior if after[path] == before[path] and error.code not in {"WORKSPACE_REQUEST_TIMEOUT", "WORKSPACE_DISCONNECTED"}
                        else "failed")
                else:
                    statuses[path] = prior if after_groups and before[path] == after[path] else (
                        "failed" if not after_groups or not self._saved_snapshot(after[path], path, saves, result) else "applied")
            await recorder.record(ProjectRef(ref.project_id, ref.provider, group["root"]), before, after, statuses)
        if error:
            raise error
        if not after_groups:
            raise ProjectAPIError("CHANGE_RECORD_FAILED", "扩展未返回根目录快照，请重载插件。")
        return result

    async def inspect_files(self, ref, paths):
        self._validate(ref)
        result = await self._bridge.call(ref.project_id, "project.inspectFiles", {"paths": paths, "root": ref.root})
        return result["files"]

    async def restore_files(self, ref, targets):
        self._validate(ref)
        result = await self._bridge.call(ref.project_id, "project.restoreFiles", {"files": targets, "root": ref.root})
        try:
            await self._tree(ref, refresh=True)
        except ProjectAPIError:
            # A disconnected tree refresh cannot erase already received save results.
            pass
        return result["results"]

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
        result = await self._tree(project_ref)
        from project_api.changes import current_recorder
        from project_api.review import candidate_files
        recorder = current_recorder.get()
        if recorder and recorder.edit_mode == "review":
            result = copy.deepcopy(result)
            files = set(result.get("files", []))
            for path, state in candidate_files(recorder, project_ref).items():
                if state["content"] is None: files.discard(path)
                else: files.add(path)
            result["files"] = sorted(files)
        return result

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
        from project_api.changes import current_recorder
        from project_api.review import candidate_files
        recorder = current_recorder.get()
        if recorder and recorder.edit_mode == "review":
            candidates = candidate_files(recorder, project_ref)
            # Native search may describe a deleted/replaced original. Never expose
            # those stale hits as candidate code; overlay uses the same literal query.
            key = "matches" if isinstance(result, dict) and "matches" in result else "results"
            matches = result.get(key, []) if isinstance(result, dict) else result
            matches = [item for item in matches if item.get("path") not in candidates]
            for candidate_path, state in candidates.items():
                if state["content"] is None or (path and not candidate_path.startswith("/" + path.lstrip("/"))):
                    continue
                for index, line in enumerate(state["content"].splitlines(), 1):
                    if query in line:
                        matches.append({"path": candidate_path, "line": index, "column": line.index(query) + 1,
                                        "content": line[:240], "fileVersion": state["version"]})
            result = {**result, key: matches[:max_results]} if isinstance(result, dict) else matches[:max_results]
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
        # 即刻落笔下删除前由扩展弹卡片确认；审阅落笔的删除先成为候选，不会走到扩展。
        result = await self._call(
            project_ref,
            "project.deleteFile",
            {"path": path, "expectedFileVersion": expected_version, "root": project_ref.root, **self._mode_params()},
            mutation="delete_file",
            timeout_seconds=CONFIRM_TIMEOUT_SECONDS,
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
            {"path": path, "recursive": recursive, "root": project_ref.root, **self._mode_params()},
            mutation="delete_directory",
            timeout_seconds=CONFIRM_TIMEOUT_SECONDS,
        )
        if not isinstance(result, dict):
            raise ProjectAPIError("WORKSPACE_REQUEST_FAILED", "VS Code delete directory 响应无效。")
        return result

    async def delete_project(self, project_ref: ProjectRef, path: str) -> dict[str, Any]:
        """删除整个项目目录（递归，进回收站）。两种模式都由扩展确认；不进入审阅候选，也不记入 ChangeSet。"""
        self._validate(project_ref)
        await self._tree(project_ref)
        result = await self._bridge.call(project_ref.project_id, "project.deleteDirectory",
                                         {"path": path, "recursive": True, "root": project_ref.root, **self._mode_params()},
                                         timeout_seconds=CONFIRM_TIMEOUT_SECONDS)
        if not isinstance(result, dict):
            raise ProjectAPIError("WORKSPACE_REQUEST_FAILED", "VS Code delete project 响应无效。")
        # 整个子树都没了，缓存的目录树直接作废，下次按需重读。
        self._bridge.invalidate_workspace_tree(project_ref.project_id, project_ref.root)
        return result

    async def external_read_file(self, project_ref: ProjectRef, path: str,
                                 start_line: int | None = None, end_line: int | None = None) -> dict[str, Any]:
        """项目外文件只读：扩展校验路径并在两种模式下都请用户确认。"""
        params: dict[str, Any] = {"path": path, **self._mode_params()}
        if start_line is not None:
            params["startLine"] = start_line
        if end_line is not None:
            params["endLine"] = end_line
        return await self._git(project_ref, "external.readFile", params, CONFIRM_TIMEOUT_SECONDS)

    async def external_list_directory(self, project_ref: ProjectRef, path: str) -> dict[str, Any]:
        return await self._git(project_ref, "external.listDirectory", {"path": path, **self._mode_params()},
                               CONFIRM_TIMEOUT_SECONDS)

    @staticmethod
    def _mode_params() -> dict[str, Any]:
        """发送时冻结的模式与本轮信息；扩展据此决定是否确认，并把卡片放进对应会话。未知模式按审阅处理。"""
        from project_api.changes import current_recorder
        recorder = current_recorder.get()
        params: dict[str, Any] = {
            "approvalMode": recorder.edit_mode if recorder and recorder.edit_mode in {"auto", "review"} else "review",
        }
        if recorder:
            params["sessionId"] = recorder.session_id
            params["roundId"] = recorder.round_id
        return params

    async def _git(self, project_ref: ProjectRef, method: str, params: dict[str, Any],
                   timeout_seconds: float | None = None) -> dict[str, Any]:
        # Git 与工具链操作针对真实仓库/磁盘状态，不经过文件树缓存、审阅暂存或 ChangeSet 记录。
        self._validate(project_ref)
        result = await self._bridge.call(project_ref.project_id, method, {"root": project_ref.root, **params},
                                         **({"timeout_seconds": timeout_seconds} if timeout_seconds else {}))
        if not isinstance(result, dict):
            raise ProjectAPIError("WORKSPACE_REQUEST_FAILED", f"VS Code {method} 响应无效。")
        return result

    async def git_status(self, project_ref: ProjectRef, include_diff: bool = False) -> dict[str, Any]:
        return await self._git(project_ref, "git.status", {"includeDiff": include_diff}, GIT_READ_TIMEOUT_SECONDS)

    async def git_commit(self, project_ref: ProjectRef, message: str,
                         paths: list[str] | None = None, push: bool = True) -> dict[str, Any]:
        # 提交默认同时推送到远端分支；只有用户要求只提交本地时才传 push=False。
        params: dict[str, Any] = {"message": message, "push": push, **self._mode_params()}
        if paths is not None:
            params["paths"] = paths
        return await self._git(project_ref, "git.commit", params, GIT_CONFIRM_TIMEOUT_SECONDS)

    async def git_push(self, project_ref: ProjectRef, remote: str | None = None) -> dict[str, Any]:
        return await self._git(project_ref, "git.push", {**({"remote": remote} if remote else {}), **self._mode_params()},
                               GIT_CONFIRM_TIMEOUT_SECONDS)

    async def toolchain_list(self, project_ref: ProjectRef) -> dict[str, Any]:
        return await self._git(project_ref, "toolchain.list", {}, TOOLCHAIN_LIST_TIMEOUT_SECONDS)

    async def toolchain_run(self, project_ref: ProjectRef, toolchain: str, action: str,
                            params: dict[str, Any] | None = None, cwd: str | None = None) -> dict[str, Any]:
        """命令针对真实磁盘执行；是否放行、是否需要审阅由扩展决定，这里只传递发送时冻结的模式。"""
        from project_api.changes import current_recorder
        recorder = current_recorder.get()
        run_id = f"run-{uuid.uuid4().hex}"
        request: dict[str, Any] = {
            "toolchain": toolchain, "action": action, "args": params or {}, "runId": run_id, **self._mode_params(),
        }
        if cwd:
            request["cwd"] = cwd
        pending = self._pending_review_files(recorder, project_ref)
        if pending:
            # 卡片据此提供「落笔并施行」
            request["pendingReviewFiles"] = pending
        result = await self._run_toolchain(project_ref, request, run_id)
        if result.get("status") == "apply_requested" and recorder:
            # 用户选择「落笔并施行」：先把本轮审阅候选写入磁盘，成功后凭令牌执行刚才确认过的命令。
            from project_api.review import apply_round_pending
            applied = await apply_round_pending(recorder, project_ref, self)
            if not applied.get("success"):
                return {**result, "success": False, "status": "failed", "code": applied.get("code", "APPLY_FAILED"),
                        "summary": "落笔未完成，命令没有执行：" + str(applied.get("message") or "部分文件与候选基线不一致"),
                        "applyResults": applied.get("results", [])}
            resume = {k: v for k, v in request.items() if k != "pendingReviewFiles"}
            resume["resumeToken"] = result.get("resumeToken")
            resume["runId"] = f"run-{uuid.uuid4().hex}"
            result = await self._run_toolchain(project_ref, resume, resume["runId"])
            result["appliedReviewFiles"] = applied.get("applied", 0)
        result.pop("resumeToken", None)
        if _is_test_run(action, params) and isinstance(result.get("diagnostics"), dict):
            result["reportGuide"] = TEST_REPORT_GUIDE
        pending = self._pending_review_files(recorder, project_ref)
        if pending:
            # 审阅候选还没落笔，命令跑的是落笔前的磁盘内容
            result["pendingReviewFiles"] = pending
        return result

    async def _run_toolchain(self, project_ref: ProjectRef, request: dict[str, Any], run_id: str) -> dict[str, Any]:
        try:
            return await self._git(project_ref, "toolchain.run", request, TOOLCHAIN_RUN_TIMEOUT_SECONDS)
        except asyncio.CancelledError:
            # 本轮被停止：通知扩展收回审阅卡片或结束进程，不等待结果
            self._cancel_toolchain_run(project_ref, run_id)
            raise
        except ProjectAPIError as exc:
            if exc.code == "WORKSPACE_REQUEST_TIMEOUT":
                self._cancel_toolchain_run(project_ref, run_id)
            raise

    def _cancel_toolchain_run(self, project_ref: ProjectRef, run_id: str) -> None:
        async def cancel() -> None:
            try:
                await self._bridge.call(project_ref.project_id, "toolchain.cancel", {"runId": run_id, "root": project_ref.root},
                                        timeout_seconds=TOOLCHAIN_CANCEL_TIMEOUT_SECONDS)
            except Exception:
                pass
        task = asyncio.get_running_loop().create_task(cancel())
        _cancel_tasks.add(task)
        task.add_done_callback(_cancel_tasks.discard)

    @staticmethod
    def _pending_review_files(recorder, project_ref: ProjectRef) -> int:
        if not recorder or recorder.edit_mode != "review":
            return 0
        files = recorder.sets.get((project_ref.provider, project_ref.project_id, project_ref.root), {}).get("files", [])
        return sum(1 for item in files if item.get("status") == "pending")

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
            "git": True,
            "toolchain": True,
            # 删除整个项目（含 package.json 或 .git 的目录）与项目外只读，均由扩展确认
            "deleteProject": True,
            "externalRead": True,
        }
