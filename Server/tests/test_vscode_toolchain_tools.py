"""VS Code 工具链：只经插件 Provider 转发，审阅模式随请求冻结传给扩展，Web Preview 不可见也不可调用。"""

import asyncio
import json

import pytest

from agent.tool_routing import TOOLCHAIN_PROMPT, route_request
from models.thinking import final_presentation, tool_presentation
from project_api.api import ProjectAPI
from project_api.changes import ChangeRecorder, current_recorder
from project_api.providers.vscode import TOOLCHAIN_RUN_TIMEOUT_SECONDS, VSCodeProjectProvider
from project_api.registry import ProjectProviderRegistry
from project_api.types import ProjectAPIError, ProjectRef
from services.vscode_bridge import VSCodeBridgeClient
from tools.index import TOOLS
from tools.project_dispatch import dispatch_project_tool

TOOLCHAIN_TOOLS = {"list_toolchains", "run_toolchain_action"}
RUN_ARGS = {"toolchain": "node", "action": "run_script", "params": {"name": "test"}, "cwd": "/packages/a"}


class FakeSocket:
    def __init__(self):
        self.sent = []

    async def send_json(self, payload):
        self.sent.append(payload)


def make_context(bridge, workspace_id="vscode-tc"):
    registry = ProjectProviderRegistry()
    registry.register("vscode", VSCodeProjectProvider(bridge))
    return ProjectAPI(registry), ProjectRef(workspace_id, "vscode")


async def wait_sent(socket, count=1):
    for _ in range(100):
        if len(socket.sent) >= count:
            return
        await asyncio.sleep(0)
    raise AssertionError("extension request was not sent")


def respond(bridge, request, result=None, error=None):
    bridge.handle_response({
        "type": "workspace_response", "requestId": request["requestId"], "workspaceId": request["workspaceId"],
        "success": error is None, **({"result": result} if error is None else {"error": error}),
    })


def with_recorder(mode):
    recorder = ChangeRecorder(store=None, session_id="session-1", edit_mode=mode)
    return recorder, current_recorder.set(recorder)


def test_toolchain_tools_are_registered_schemas():
    names = {tool.name for tool in TOOLS}
    assert TOOLCHAIN_TOOLS <= names
    schema = next(tool for tool in TOOLS if tool.name == "run_toolchain_action").args
    assert {"toolchain", "action", "params", "cwd", "root"} <= set(schema)


@pytest.mark.parametrize("mode", ["review", "auto"])
def test_run_forwards_frozen_edit_mode_session_and_run_id_without_tree_or_changeset(mode):
    async def scenario():
        bridge = VSCodeBridgeClient(timeout_seconds=0.5)
        socket = FakeSocket()
        bridge.register_workspace("vscode-tc", socket)
        _, token = with_recorder(mode)
        try:
            task = asyncio.create_task(dispatch_project_tool(make_context(bridge), "run_toolchain_action", RUN_ARGS))
            await wait_sent(socket)
            request = socket.sent[0]
            respond(bridge, request, {"success": True, "status": "completed", "summary": "3 项全部通过"})
            result = await task
        finally:
            current_recorder.reset(token)
        # 不预取文件树、不经过审阅暂存：唯一请求就是 toolchain.run
        assert [item["method"] for item in socket.sent] == ["toolchain.run"]
        params = request["params"]
        assert params["approvalMode"] == mode
        assert params["sessionId"] == "session-1"
        assert params["runId"].startswith("run-")
        assert (params["toolchain"], params["action"], params["args"], params["cwd"]) == ("node", "run_script", {"name": "test"}, "/packages/a")
        assert result["status"] == "completed" and result["provider"] == "vscode"
        assert "pendingReviewFiles" not in result

    asyncio.run(scenario())


def test_missing_recorder_defaults_to_review():
    async def scenario():
        bridge = VSCodeBridgeClient(timeout_seconds=0.5)
        socket = FakeSocket()
        bridge.register_workspace("vscode-tc", socket)
        task = asyncio.create_task(dispatch_project_tool(make_context(bridge), "run_toolchain_action",
                                                         {"toolchain": "node", "action": "typecheck"}))
        await wait_sent(socket)
        assert socket.sent[0]["params"]["approvalMode"] == "review"
        assert "cwd" not in socket.sent[0]["params"]
        respond(bridge, socket.sent[0], {"success": True, "status": "completed"})
        await task

    asyncio.run(scenario())


def test_pending_review_candidates_are_reported_with_the_result():
    async def scenario():
        bridge = VSCodeBridgeClient(timeout_seconds=0.5)
        socket = FakeSocket()
        bridge.register_workspace("vscode-tc", socket)
        recorder, token = with_recorder("review")
        recorder.sets[("vscode", "vscode-tc", None)] = {"files": [{"path": "/a.ts", "status": "pending"},
                                                               {"path": "/b.ts", "status": "applied"}]}
        try:
            task = asyncio.create_task(dispatch_project_tool(make_context(bridge), "run_toolchain_action", RUN_ARGS))
            await wait_sent(socket)
            respond(bridge, socket.sent[0], {"success": True, "status": "completed"})
            result = await task
        finally:
            current_recorder.reset(token)
        assert result["pendingReviewFiles"] == 1

    asyncio.run(scenario())


def test_run_waits_for_approval_beyond_default_timeout():
    async def scenario():
        bridge = VSCodeBridgeClient(timeout_seconds=0.05)
        socket = FakeSocket()
        bridge.register_workspace("vscode-tc", socket)
        task = asyncio.create_task(dispatch_project_tool(make_context(bridge), "run_toolchain_action", RUN_ARGS))
        await asyncio.sleep(0.2)  # 远超默认超时，模拟用户正在阅读审阅卡片
        assert not task.done()
        respond(bridge, socket.sent[0], {"success": False, "status": "user_cancelled"})
        assert (await task)["status"] == "user_cancelled"

    assert TOOLCHAIN_RUN_TIMEOUT_SECONDS >= 1200
    asyncio.run(scenario())


def test_stopping_the_round_sends_cancel_for_the_same_run():
    async def scenario():
        bridge = VSCodeBridgeClient(timeout_seconds=0.5)
        socket = FakeSocket()
        bridge.register_workspace("vscode-tc", socket)
        task = asyncio.create_task(dispatch_project_tool(make_context(bridge), "run_toolchain_action", RUN_ARGS))
        await wait_sent(socket)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        await wait_sent(socket, 2)
        assert socket.sent[1]["method"] == "toolchain.cancel"
        assert socket.sent[1]["params"]["runId"] == socket.sent[0]["params"]["runId"]
        respond(bridge, socket.sent[1], {"cancelled": True})
        await asyncio.sleep(0)

    asyncio.run(scenario())


def test_list_forwards_and_invalid_arguments_never_reach_extension():
    async def scenario():
        bridge = VSCodeBridgeClient(timeout_seconds=0.5)
        socket = FakeSocket()
        bridge.register_workspace("vscode-tc", socket)
        for args in ({"toolchain": "node"}, {"toolchain": "node", "action": "test", "params": "x"},
                     {"toolchain": "node", "action": "test", "cwd": 3}):
            with pytest.raises(ProjectAPIError):
                await dispatch_project_tool(make_context(bridge), "run_toolchain_action", args)
        assert socket.sent == []
        task = asyncio.create_task(dispatch_project_tool(make_context(bridge), "list_toolchains", {}))
        await wait_sent(socket)
        assert socket.sent[0]["method"] == "toolchain.list"
        respond(bridge, socket.sent[0], {"toolchains": []})
        assert (await task)["toolchains"] == []

    asyncio.run(scenario())


def test_web_preview_provider_cannot_dispatch_toolchain():
    from services.preview.workspace import PreviewProjectWorkspace
    from project_api.preview_context import create_current_preview_project_api

    workspace = PreviewProjectWorkspace.from_request({"id": "web-1", "template": "html", "files": {"/index.html": "<div></div>"},
                                                 "revision": 1})
    context = create_current_preview_project_api(workspace)

    async def scenario():
        for tool in TOOLCHAIN_TOOLS:
            with pytest.raises(ProjectAPIError) as error:
                await dispatch_project_tool(context, tool, {"toolchain": "node", "action": "test"})
            assert error.value.code == "UNSUPPORTED_OPERATION"

    asyncio.run(scenario())


def test_routing_exposes_toolchain_only_to_registered_vscode_workspace():
    caps = {"listFiles": True, "rangeRead": True, "toolchain": True}
    plugin = route_request("帮我跑一下插件测试", vscode_client_mode=True, vscode_workspace_id="ws-1", project_capabilities=caps)
    assert TOOLCHAIN_TOOLS <= set(plugin.tool_names)
    assert TOOLCHAIN_PROMPT in plugin.system_prompt
    assert "workspace_toolchain" in plugin.selected_skills
    # 工作区测试不应被引到隔离 Python 沙箱
    assert "execute_python" not in plugin.tool_names
    assert not TOOLCHAIN_TOOLS & set(route_request("帮我跑一下测试", vscode_client_mode=True).tool_names)
    assert not TOOLCHAIN_TOOLS & set(route_request("帮我跑一下测试", has_preview=True).tool_names)
    # 普通聊天仍可发现工具，但不注入执行规则卡
    chat = route_request("解释一下这个函数", vscode_client_mode=True, vscode_workspace_id="ws-1", project_capabilities=caps)
    assert TOOLCHAIN_PROMPT not in chat.system_prompt


def test_thinking_titles_and_status_words_follow_receipts():
    args = {"toolchain": "node", "action": "run_script", "params": {"name": "test"}}
    assert tool_presentation("run_toolchain_action", args)["title"] == "运行 npm run test"
    assert "静候施行" in tool_presentation("run_toolchain_action", args)["summary"]
    cases = {
        "completed": ("已施行", "ok"), "user_cancelled": ("未施行", "cancelled"), "approval_timeout": ("逾时未施", "cancelled"),
        "cancelled": ("中道而止", "cancelled"), "timed_out": ("逾时而止", "fail"), "plan_changed": ("内容有异", "fail"),
        "not_enabled": ("此令未开", "fail"), "rejected": ("不可施行", "fail"), "workspace_untrusted": ("未得信任", "fail"),
    }
    for status, (word, state) in cases.items():
        presented = tool_presentation("run_toolchain_action", args, json.dumps({"success": status == "completed", "status": status,
                                                                              "command": "npm run test", "summary": "说明"}), True)
        assert presented["summary"].startswith(word + "：") and presented["status"] == state, status
    failed = {"success": False, "status": "failed", "summary": "48 项中失败 2 项"}
    assert tool_presentation("run_toolchain_action", args, json.dumps({**failed, "diagnostics": {"failed": 2}}), True)["summary"].startswith("见疏漏")
    assert tool_presentation("run_toolchain_action", args, json.dumps(failed), True)["summary"].startswith("未施成")
    assert tool_presentation("run_toolchain_action", {"action": "typecheck"})["title"] == "类型检查"
    final = final_presentation([{"name": "patch_project_file", "status": "ok", "summary": "改了"},
                                {"name": "run_toolchain_action", "status": "ok", "summary": "已施行"}])
    assert final["title"] == "汇总施行结果"


@pytest.mark.parametrize("text", ["运行项目", "帮我把项目跑起来", "启动一下前端", "安装依赖", "npm run dev", "本地预览一下"])
def test_run_project_and_install_requests_load_the_toolchain_card(text):
    caps = {"listFiles": True, "rangeRead": True, "toolchain": True}
    route = route_request(text, vscode_client_mode=True, vscode_workspace_id="ws-1", project_capabilities=caps)
    assert TOOLCHAIN_PROMPT in route.system_prompt
    # 规则卡明确“运行项目”是 dev，不用 build 代替；依赖缺失先说明再 install
    assert "不要用 build 代替" in TOOLCHAIN_PROMPT and "install" in TOOLCHAIN_PROMPT


def test_unrelated_open_requests_do_not_load_the_toolchain_card():
    caps = {"listFiles": True, "rangeRead": True, "toolchain": True}
    for text in ("打开这个文件", "解释一下这个函数"):
        route = route_request(text, vscode_client_mode=True, vscode_workspace_id="ws-1", project_capabilities=caps)
        assert TOOLCHAIN_PROMPT not in route.system_prompt


def test_background_install_and_management_presentation():
    dev = {"toolchain": "node", "action": "run_script", "params": {"name": "dev"}}
    background = tool_presentation("run_toolchain_action", dev, json.dumps({
        "success": True, "status": "background", "command": "npm run dev", "url": "http://localhost:5173/",
        "summary": "已在后台运行 · http://localhost:5173/"}), True)
    assert background["summary"].startswith("常驻施行：npm run dev") and "localhost:5173" in background["summary"]
    assert background["status"] == "ok"
    stopped = tool_presentation("run_toolchain_action", {"action": "stop", "params": {"runId": "r"}},
                                json.dumps({"success": True, "status": "stopped", "summary": "已收令，后台进程已结束"}), True)
    assert stopped["title"] == "止令" and stopped["summary"].startswith("已收令")
    assert tool_presentation("run_toolchain_action", {"action": "install"})["title"] == "安装依赖"
    assert tool_presentation("run_toolchain_action", {"action": "logs"})["summary"] == "正在查看运行输出。"
    missing = tool_presentation("run_toolchain_action", {"action": "typecheck"}, json.dumps({
        "success": False, "code": "DEPENDENCIES_NOT_INSTALLED", "error": "尚未安装依赖（没有找到 node_modules）"}), True)
    assert "尚未安装依赖" in missing["summary"] and missing["status"] == "fail"


@pytest.mark.parametrize("text", ["跑一下 pytest", "运行 main.py", "帮我启动 uvicorn", "创建虚拟环境", "python manage.py runserver", "运行 scripts/seed.py 看看"])
def test_python_workspace_requests_use_the_toolchain_not_the_sandbox(text):
    caps = {"listFiles": True, "rangeRead": True, "toolchain": True}
    route = route_request(text, vscode_client_mode=True, vscode_workspace_id="ws-1", project_capabilities=caps)
    assert TOOLCHAIN_PROMPT in route.system_prompt
    assert TOOLCHAIN_TOOLS <= set(route.tool_names)
    assert "execute_python" not in route.tool_names
    assert "toolchain 为 node、python 或 git" in TOOLCHAIN_PROMPT and "create_venv" in TOOLCHAIN_PROMPT


def test_pasted_python_snippets_still_use_the_sandbox():
    caps = {"listFiles": True, "rangeRead": True, "toolchain": True}
    pasted = "帮我运行这段 python 代码\n```python\nprint(1)\n```"
    assert "execute_python" in route_request(pasted, vscode_client_mode=True, vscode_workspace_id="ws-1", project_capabilities=caps).tool_names
    # Web 端没有工具链，原有沙箱路由不变
    assert "execute_python" in route_request("运行这段 Python 代码").tool_names
    assert not TOOLCHAIN_TOOLS & set(route_request("运行 main.py", has_preview=True).tool_names)


def test_python_thinking_titles():
    py = lambda action, **params: tool_presentation("run_toolchain_action", {"toolchain": "python", "action": action, "params": params})["title"]
    assert py("run_file", file="src/app/main.py") == "运行 main.py"
    assert py("run_module", module="uvicorn") == "运行 python -m uvicorn"
    assert py("create_venv") == "创建虚拟环境"
    assert py("env") == "查看 Python 环境"
    assert py("install") == "安装 Python 依赖"
    assert py("test", path="tests/test_a.py") == "运行测试 test_a.py"
    assert py("lint") == "代码检查"
    assert tool_presentation("run_toolchain_action", {"toolchain": "node", "action": "env"})["title"] == "查看 Node 版本"
