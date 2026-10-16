"""VS Code 真实 Git 工具：只经插件 Provider 转发，Web Preview 不可见也不可调用。"""

import asyncio

import pytest

from agent.tool_routing import route_request
from project_api.api import ProjectAPI
from project_api.providers.vscode import GIT_CONFIRM_TIMEOUT_SECONDS, VSCodeProjectProvider
from project_api.registry import ProjectProviderRegistry
from project_api.types import ProjectAPIError, ProjectRef
from services.vscode_bridge import VSCodeBridgeClient
from tools.index import TOOLS
from tools.project_dispatch import dispatch_project_tool

GIT_TOOLS = {"git_status", "git_commit", "git_push"}


class FakeSocket:
    def __init__(self):
        self.sent = []

    async def send_json(self, payload):
        self.sent.append(payload)


def make_context(bridge, workspace_id="vscode-git"):
    registry = ProjectProviderRegistry()
    registry.register("vscode", VSCodeProjectProvider(bridge))
    return ProjectAPI(registry), ProjectRef(workspace_id, "vscode")


async def respond(bridge, socket, result=None, error=None, index=-1):
    for _ in range(50):
        if socket.sent:
            break
        await asyncio.sleep(0)
    request = socket.sent[index]
    bridge.handle_response({
        "type": "workspace_response", "requestId": request["requestId"], "workspaceId": request["workspaceId"],
        "success": error is None, **({"result": result} if error is None else {"error": error}),
    })
    return request


def test_git_tools_are_registered_schemas():
    names = {tool.name for tool in TOOLS}
    assert GIT_TOOLS <= names


@pytest.mark.parametrize("tool, args, method, params", [
    ("git_status", {"include_diff": True}, "git.status", {"includeDiff": True}),
    ("git_commit", {"message": "fix: 标题", "paths": ["/src/App.tsx"]}, "git.commit",
     {"message": "fix: 标题", "paths": ["/src/App.tsx"]}),
    ("git_commit", {"message": "chore: all"}, "git.commit", {"message": "chore: all"}),
    ("git_push", {"remote": "origin"}, "git.push", {"remote": "origin"}),
    ("git_push", {}, "git.push", {}),
])
def test_dispatch_forwards_git_calls_to_extension_without_tree_or_changeset(tool, args, method, params):
    async def scenario():
        bridge = VSCodeBridgeClient(timeout_seconds=0.5)
        socket = FakeSocket()
        bridge.register_workspace("vscode-git", socket)
        task = asyncio.create_task(dispatch_project_tool(make_context(bridge), tool, args))
        request = await respond(bridge, socket, {"ok": True})
        result = await task
        # 不预取文件树、不经过审阅暂存：唯一请求就是 git 方法本身
        assert [item["method"] for item in socket.sent] == [method]
        mode_keys = {"approvalMode", "sessionId", "roundId"}
        sent = {k: v for k, v in request["params"].items() if k not in {"workspaceVersion", "root", *mode_keys}}
        assert sent == params
        # 提交/推送带上发送时冻结的模式（无记录器时按审阅），由扩展决定是否确认
        if method != "git.status":
            assert request["params"]["approvalMode"] == "review"
        assert result["ok"] is True and result["provider"] == "vscode"

    asyncio.run(scenario())


def test_commit_waits_for_user_confirmation_beyond_default_timeout():
    async def scenario():
        bridge = VSCodeBridgeClient(timeout_seconds=0.05)
        socket = FakeSocket()
        bridge.register_workspace("vscode-git", socket)
        task = asyncio.create_task(dispatch_project_tool(make_context(bridge), "git_commit", {"message": "m"}))
        await asyncio.sleep(0.2)  # 远超默认超时，模拟用户正在阅读确认框
        assert not task.done()
        await respond(bridge, socket, {"committed": True, "commit": "abc"})
        assert (await task)["committed"] is True

    assert GIT_CONFIRM_TIMEOUT_SECONDS >= 300
    asyncio.run(scenario())


def test_default_bridge_timeout_unchanged_for_file_operations():
    async def scenario():
        bridge = VSCodeBridgeClient(timeout_seconds=0.05)
        bridge.register_workspace("vscode-git", FakeSocket())
        with pytest.raises(ProjectAPIError) as error:
            await bridge.call("vscode-git", "project.listFiles", {})
        assert error.value.code == "WORKSPACE_REQUEST_TIMEOUT"

    asyncio.run(scenario())


def test_user_cancel_is_reported_as_failure_not_success():
    async def scenario():
        bridge = VSCodeBridgeClient(timeout_seconds=0.5)
        socket = FakeSocket()
        bridge.register_workspace("vscode-git", socket)
        task = asyncio.create_task(dispatch_project_tool(make_context(bridge), "git_push", {}))
        await respond(bridge, socket, error={"code": "USER_CANCELLED", "message": "用户取消了推送，未做任何改动。"})
        with pytest.raises(ProjectAPIError) as error:
            await task
        assert error.value.code == "USER_CANCELLED"

    asyncio.run(scenario())


def test_commit_rejects_non_list_paths_before_calling_extension():
    async def scenario():
        bridge = VSCodeBridgeClient(timeout_seconds=0.5)
        socket = FakeSocket()
        bridge.register_workspace("vscode-git", socket)
        with pytest.raises(ProjectAPIError) as error:
            await dispatch_project_tool(make_context(bridge), "git_commit", {"message": "m", "paths": "/a"})
        assert error.value.code == "INVALID_PATH" and socket.sent == []

    asyncio.run(scenario())


def test_web_preview_provider_cannot_dispatch_git():
    from services.preview.workspace import PreviewProjectWorkspace
    from project_api.preview_context import create_current_preview_project_api

    workspace = PreviewProjectWorkspace.from_request({"id": "web-1", "template": "html", "files": {"/index.html": "<div></div>"},
                                                 "revision": 1})
    context = create_current_preview_project_api(workspace)

    async def scenario():
        for tool in GIT_TOOLS:
            with pytest.raises(ProjectAPIError) as error:
                await dispatch_project_tool(context, tool, {"message": "m"})
            assert error.value.code == "UNSUPPORTED_OPERATION"

    asyncio.run(scenario())


def test_routing_exposes_git_only_to_registered_vscode_workspace():
    plugin = route_request("帮我提交代码并推送", vscode_client_mode=True, vscode_workspace_id="ws-1",
                           project_capabilities={"listFiles": True, "rangeRead": True, "git": True})
    assert GIT_TOOLS <= set(plugin.tool_names)
    unregistered = route_request("帮我提交代码", vscode_client_mode=True)
    assert not GIT_TOOLS & set(unregistered.tool_names)
    web = route_request("帮我提交代码并推送", has_preview=True)
    assert not GIT_TOOLS & set(web.tool_names)
