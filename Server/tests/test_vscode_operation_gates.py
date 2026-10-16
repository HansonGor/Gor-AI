"""即刻/审阅两种模式下的确认类操作：删除、删除项目、项目外只读、Git 与「落笔并施行」。

放行与否由扩展决定；Server 只负责把发送时冻结的模式、会话与轮次带过去，并给等待确认的操作足够的超时。
"""

import asyncio
import copy
from contextlib import asynccontextmanager

import pytest

from agent.tool_routing import TOOLCHAIN_PROMPT, route_request
from models.thinking import tool_presentation
from project_api.api import ProjectAPI
from project_api.changes import ChangeRecorder, current_recorder, snapshot
from project_api.providers.vscode import CONFIRM_TIMEOUT_SECONDS, VSCodeProjectProvider
from project_api.registry import ProjectProviderRegistry
from project_api.review import ApplyService, apply_expected, apply_round_pending, stage_vscode
from project_api.types import ProjectAPIError, ProjectRef
from tools.index import TOOLS
from tools.project_dispatch import dispatch_project_tool

REF = ProjectRef("vscode-gates", "vscode")


class Store:
    def __init__(self):
        self.rows, self.locks = {}, {}

    async def put(self, item):
        self.rows[item["id"]] = copy.deepcopy(item)

    async def get(self, id):
        return copy.deepcopy(self.rows.get(id))

    @asynccontextmanager
    async def lock(self, id):
        async with self.locks.setdefault(id, asyncio.Lock()):
            yield


class Bridge:
    """内存工作区：记录每次 RPC 的方法、参数与超时。"""

    def __init__(self):
        self.files = {"/a.ts": snapshot("old", 1)}
        self.calls = []
        self.invalidated = 0
        self.toolchain_replies = []

    async def get_workspace_tree(self, *args, **kwargs):
        return {"success": True, "files": list(self.files)}

    def update_workspace_tree(self, *args):
        pass

    def invalidate_workspace_tree(self, *args):
        self.invalidated += 1

    async def call(self, id, method, params, timeout_seconds=None):
        self.calls.append((method, copy.deepcopy(params), timeout_seconds))
        if method == "project.inspectFiles":
            return {"files": {p: copy.deepcopy(self.files.get(p, snapshot(None))) for p in params["paths"]}}
        if method == "project.restoreFiles":
            results = []
            for f in params["files"]:
                self.files[f["path"]] = snapshot(f["before"]["content"], (f["after"]["version"] or 0) + 1)
                results.append({"fileId": f["id"], "path": f["path"], "success": True})
            return {"results": results}
        if method == "toolchain.run":
            return self.toolchain_replies.pop(0)
        if method == "project.listFiles":
            return {"success": True, "files": list(self.files)}
        result = {"success": True, "deleted": True, "path": params.get("path")}
        if "changeExpected" in params:
            # 与真实扩展一致：带回执行后的实际快照，供 ChangeSet 记录
            result["changeSnapshots"] = {p: snapshot(None, None) for p in params["changeExpected"]}
        return result


def context(bridge):
    registry = ProjectProviderRegistry()
    registry.register("vscode", VSCodeProjectProvider(bridge))
    return ProjectAPI(registry), REF


def with_recorder(mode, store=None):
    recorder = ChangeRecorder(store or Store(), "session-9", "round-9", edit_mode=mode)
    return recorder, current_recorder.set(recorder)


def calls_of(bridge, method):
    return [call for call in bridge.calls if call[0] == method]


def test_new_tools_are_registered():
    names = {tool.name for tool in TOOLS}
    assert {"delete_project", "read_external_file", "list_external_directory"} <= names


def test_auto_mode_delete_sends_mode_session_round_and_waits_for_the_card():
    async def scenario():
        bridge = Bridge()
        _, token = with_recorder("auto")
        try:
            await dispatch_project_tool(context(bridge), "delete_project_file", {"path": "/a.ts"})
        finally:
            current_recorder.reset(token)
        method, params, timeout = calls_of(bridge, "project.deleteFile")[0]
        assert (params["approvalMode"], params["sessionId"], params["roundId"]) == ("auto", "session-9", "round-9")
        assert timeout == CONFIRM_TIMEOUT_SECONDS >= 600

    asyncio.run(scenario())


def test_review_mode_delete_stays_a_candidate_and_never_reaches_the_extension():
    async def scenario():
        bridge = Bridge()
        recorder, token = with_recorder("review")
        try:
            result = await dispatch_project_tool(context(bridge), "delete_project_file", {"path": "/a.ts"})
        finally:
            current_recorder.reset(token)
        assert result["pending"] is True
        assert not calls_of(bridge, "project.deleteFile")

    asyncio.run(scenario())


@pytest.mark.parametrize("mode", ["auto", "review"])
def test_delete_project_is_recursive_bypasses_review_staging_and_refreshes_the_tree(mode):
    async def scenario():
        bridge = Bridge()
        _, token = with_recorder(mode)
        try:
            await dispatch_project_tool(context(bridge), "delete_project", {"path": "/apps/web"})
        finally:
            current_recorder.reset(token)
        method, params, timeout = calls_of(bridge, "project.deleteDirectory")[0]
        assert params["recursive"] is True and params["path"] == "/apps/web"
        assert params["approvalMode"] == mode
        assert timeout == CONFIRM_TIMEOUT_SECONDS
        assert bridge.invalidated == 1

    asyncio.run(scenario())


def test_external_reads_forward_absolute_paths_with_mode_and_long_timeout():
    async def scenario():
        bridge = Bridge()
        _, token = with_recorder("auto")
        try:
            await dispatch_project_tool(context(bridge), "read_external_file", {"path": "D:\\notes\\todo.md", "start_line": 3})
            await dispatch_project_tool(context(bridge), "list_external_directory", {"path": "D:\\notes"})
            with pytest.raises(ProjectAPIError):
                await dispatch_project_tool(context(bridge), "read_external_file", {"path": "  "})
        finally:
            current_recorder.reset(token)
        (method, params, timeout), = calls_of(bridge, "external.readFile")
        assert params["path"] == "D:\\notes\\todo.md" and params["startLine"] == 3 and params["approvalMode"] == "auto"
        assert timeout == CONFIRM_TIMEOUT_SECONDS
        assert calls_of(bridge, "external.listDirectory")[0][1]["path"] == "D:\\notes"

    asyncio.run(scenario())


def test_web_preview_cannot_use_delete_project_or_external_reads():
    from services.preview.workspace import PreviewProjectWorkspace
    from project_api.preview_context import create_current_preview_project_api

    workspace = PreviewProjectWorkspace.from_request({"id": "web-1", "template": "html", "files": {"/index.html": "x"}, "revision": 1})
    preview = create_current_preview_project_api(workspace)

    async def scenario():
        for tool in ("delete_project", "read_external_file", "list_external_directory"):
            with pytest.raises(ProjectAPIError) as error:
                await dispatch_project_tool(preview, tool, {"path": "/x"})
            assert error.value.code == "UNSUPPORTED_OPERATION"

    asyncio.run(scenario())
    web = route_request("读取 D:\\notes\\a.md", has_preview=True)
    assert not {"delete_project", "read_external_file"} & set(web.tool_names)


async def stage_candidate(provider, recorder, content):
    await stage_vscode(provider, REF, "project.writeFile", {"path": "/a.ts", "content": content}, recorder)


def test_apply_round_pending_writes_candidates_mid_round_and_later_edits_use_the_applied_baseline():
    async def scenario():
        bridge = Bridge()
        provider = VSCodeProjectProvider(bridge)
        store = Store()
        recorder, token = with_recorder("review", store)
        try:
            await stage_candidate(provider, recorder, "first")
            applied = await apply_round_pending(recorder, REF, provider)
            assert applied == {"success": True, "applied": 1, "results": applied["results"]}
            assert bridge.files["/a.ts"]["content"] == "first"
            file = recorder.sets[("vscode", REF.project_id, None)]["files"][0]
            assert file["status"] == "applied" and file["before"]["content"] == "old"

            # 中途落笔后同一文件继续修改：新的候选以落笔后的内容为基线，最终落笔不报冲突
            await stage_candidate(provider, recorder, "second")
            assert file["status"] == "pending" and file["applyBaseline"]["content"] == "first"
            assert apply_expected(file)["content"] == "first"
            again = await apply_round_pending(recorder, REF, provider)
            assert again["success"] is True and bridge.files["/a.ts"]["content"] == "second"
            # 复原仍回到本轮开始前的原文
            assert file["before"]["content"] == "old"
        finally:
            current_recorder.reset(token)

    asyncio.run(scenario())


def test_apply_round_pending_refuses_when_the_file_changed_during_review():
    async def scenario():
        bridge = Bridge()
        provider = VSCodeProjectProvider(bridge)
        recorder, token = with_recorder("review", Store())
        try:
            await stage_candidate(provider, recorder, "candidate")
            bridge.files["/a.ts"] = snapshot("user edited", 2)
            result = await apply_round_pending(recorder, REF, provider)
            assert result["success"] is False and result["code"] == "VERSION_CONFLICT"
            assert bridge.files["/a.ts"]["content"] == "user edited"
            assert not calls_of(bridge, "project.restoreFiles")
        finally:
            current_recorder.reset(token)

    asyncio.run(scenario())


def test_apply_and_run_applies_pending_files_then_resumes_with_the_token():
    async def scenario():
        bridge = Bridge()
        provider = VSCodeProjectProvider(bridge)
        recorder, token = with_recorder("review", Store())
        try:
            await stage_candidate(provider, recorder, "fixed")
            bridge.toolchain_replies = [
                {"success": False, "status": "apply_requested", "resumeToken": "tok-1", "summary": "先落笔"},
                {"success": True, "status": "completed", "summary": "3 项全部通过"},
            ]
            result = await provider.toolchain_run(REF, "node", "run_script", {"name": "check"})
        finally:
            current_recorder.reset(token)
        runs = calls_of(bridge, "toolchain.run")
        assert runs[0][1]["pendingReviewFiles"] == 1
        assert runs[1][1]["resumeToken"] == "tok-1" and "pendingReviewFiles" not in runs[1][1]
        assert bridge.files["/a.ts"]["content"] == "fixed"
        assert result["status"] == "completed" and result["appliedReviewFiles"] == 1
        assert "resumeToken" not in result and "pendingReviewFiles" not in result

    asyncio.run(scenario())


def test_apply_and_run_does_not_run_when_applying_fails():
    async def scenario():
        bridge = Bridge()
        provider = VSCodeProjectProvider(bridge)
        recorder, token = with_recorder("review", Store())
        try:
            await stage_candidate(provider, recorder, "fixed")
            bridge.files["/a.ts"] = snapshot("user edited", 2)
            bridge.toolchain_replies = [{"success": False, "status": "apply_requested", "resumeToken": "tok-2"}]
            result = await provider.toolchain_run(REF, "node", "run_script", {"name": "check"})
        finally:
            current_recorder.reset(token)
        assert result["status"] == "failed" and "落笔未完成" in result["summary"]
        assert len(calls_of(bridge, "toolchain.run")) == 1

    asyncio.run(scenario())


def test_final_apply_button_uses_the_applied_baseline_too():
    async def scenario():
        bridge = Bridge()
        provider = VSCodeProjectProvider(bridge)
        store = Store()
        recorder, token = with_recorder("review", store)
        try:
            await stage_candidate(provider, recorder, "first")
            await apply_round_pending(recorder, REF, provider)
            await stage_candidate(provider, recorder, "second")
            await recorder.seal()
        finally:
            current_recorder.reset(token)
        item_id = recorder.sets[("vscode", REF.project_id, None)]["id"]

        async def factory(ref, item):
            return provider

        result = await ApplyService(store, factory).applyChangeSet(item_id)
        assert result["success"] is True
        assert bridge.files["/a.ts"]["content"] == "second"

    asyncio.run(scenario())


def test_routing_and_thinking_cover_git_delete_and_external_reads():
    caps = {"listFiles": True, "rangeRead": True, "toolchain": True, "git": True, "deleteProject": True, "externalRead": True}
    for text in ("删除 old-app 这个项目", "帮我切换到 dev 分支", "删除 feature 分支", "读取 D:\\notes\\todo.md", "拉取一下最新代码"):
        route = route_request(text, vscode_client_mode=True, vscode_workspace_id="ws-1", project_capabilities=caps)
        assert TOOLCHAIN_PROMPT in route.system_prompt, text
    git = {"toolchain": "git", "action": "delete_branch", "params": {"name": "feature/a"}}
    assert tool_presentation("run_toolchain_action", git)["title"] == "删除分支 feature/a"
    assert tool_presentation("delete_project", {"path": "/apps/web"})["title"] == "删除项目 web"
    assert tool_presentation("read_external_file", {"path": "D:\\notes\\todo.md"})["title"] == "读取项目外文件 todo.md"
    warned = tool_presentation("run_toolchain_action", {"action": "run_script", "params": {"name": "setup"}}, {
        "success": False, "status": "user_cancelled", "command": "npm run setup", "summary": "你未允准，没有执行",
        "warnings": [{"level": "warn", "reason": "下载远程内容并直接执行"}]}, True)
    assert "疑似风险：下载远程内容并直接执行" in warned["summary"]
