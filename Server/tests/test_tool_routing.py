from agent.tool_routing import route_request
from agent.prompts import SYSTEM_PROMPT
from agent.tool_routing import PRESENTATION_PROMPT
from agent.agent import execute_tool
from project_api.types import ProjectRef
from langchain_core.messages import AIMessage
import asyncio
import json
from agent.project_reply import summarize_project_changes


def test_project_operations_use_current_provider_and_shared_source_free_summary():
    for request in ['新建一个3D模型', '生成一个简单react-demo', '创建一个文件 src/test.jsx', '改回原来的标题']:
        web = route_request(request, has_preview=True)
        assert web.tool_names, request
        assert not set(web.tool_names) & {'create_project_file', 'delete_project_file'}, request
        assert not any('_preview_' in name for name in web.tool_names)
        plugin = route_request(request, has_preview=True, vscode_client_mode=True, vscode_workspace_id='ws')
        assert plugin.tool_names, request
        assert 'set_3d_scene' not in plugin.tool_names
        assert not any('_preview_' in name for name in plugin.tool_names)
    for request in ['创建目录', '删除文件', '改回原来的标题', '更新按钮']:
        text = summarize_project_changes(request, ['/src/App.jsx'])
        assert 'Diff' in text
        assert '/src/App.jsx' not in text and '```' not in text and '<h1>' not in text
    assert 'GLB' in summarize_project_changes('生成一个3D模型', ['/src/scene.json'], scene=True)


def test_vscode_session_id_answer_uses_request_identity_without_workspace_or_model(monkeypatch):
    import agent.agent as agent_module

    def unexpected_model_call(_names):
        raise AssertionError('session identity does not require LLM or workspace tools')

    monkeypatch.setattr(agent_module, 'get_model_for_tools', unexpected_model_call)
    monkeypatch.setattr(agent_module, 'TYPING_DELAY_MS', 0)
    for question in ['目前会话ID是多少', '请问当前会话 ID 是什么？', '我的会话编号是多少', '当前session ID']:
        events = []
        asyncio.run(agent_module.run_agent([
            {'role': 'assistant', 'content': '旧会话 ID：old-session'},
            {'role': 'user', 'content': question},
        ], events.append, vscode_client_mode=True, session_id='current-session'))
        text = ''.join(event.get('content', '') for event in events if event.get('type') == 'token')
        assert text == '当前会话 ID：current-session'
    events = []
    asyncio.run(agent_module.run_agent([{'role': 'user', 'content': '目前会话ID是多少'}],
        events.append, vscode_client_mode=True))
    assert '无法准确获取' in ''.join(event.get('content', '') for event in events)


COMMON = {"web_search", "search_images", "request_tools"}
GENERATORS = {"create_word", "create_excel", "create_pdf", "create_ppt", "generate_xiaoyunque_video"}
PREVIEW_FILES = {"list_project_files", "search_project_code", "read_project_file",
                 "write_project_file", "patch_project_file", "batch_patch_project_files"}
PLUGIN_FILES = PREVIEW_FILES | {"create_project_file", "create_project_directory",
                                "delete_project_file", "delete_project_directory"}
# 真实 Git 操作只属于已注册的 VS Code 工作区；Web 默认工具集合中不得出现。
PLUGIN_GIT = {"git_status", "git_commit", "git_push"}
# 工具链同样只属于已注册的 VS Code 工作区，是否执行由扩展审阅决定。
PLUGIN_TOOLCHAIN = {"list_toolchains", "run_toolchain_action"}
WEB_DEFAULTS = COMMON | GENERATORS | PREVIEW_FILES | {"set_3d_scene"}
PLUGIN_DEFAULTS = COMMON | GENERATORS | PLUGIN_FILES | PLUGIN_GIT | PLUGIN_TOOLCHAIN
UNREGISTERED_DEFAULTS = COMMON | GENERATORS | {"list_project_files", "search_project_code", "read_project_file"}


def test_static_chat_keeps_search_and_images_without_loading_task_prompts():
    route = route_request("revision 是什么？")
    assert route.profile == "chat"
    assert set(route.tool_names) == COMMON
    assert not route.requires_web_search


def test_vscode_followups_preserve_authorization_context_with_default_tools():
    history = [
        {"role": "user", "content": "把 src/App.jsx 的标题从 React Demo 改成待办清单"},
        {"role": "assistant", "content": "本轮没有工具，你可以手动修改这个标题。"},
    ]
    for text in ["就按上面的改", "按这个来", "好，执行", "继续", "好的", "改回原来的", "再大一点"]:
        route = route_request(text, vscode_workspace_id="vscode-current", conversation_context=history)
        assert set(route.tool_names) == PLUGIN_DEFAULTS
        assert route.profile == "vscode_project_edit"
        assert "历史助手" in route.system_prompt
    for text in ["你好", "不用改了", "先不要执行", "怎么改回原来的？", "今天怎么样"]:
        route = route_request(text, vscode_workspace_id="vscode-current", conversation_context=history)
        assert set(route.tool_names) == PLUGIN_DEFAULTS
        assert "vscode_project_edit" not in route.profile
    unrelated = history + [{"role": "user", "content": "讲个笑话"}]
    assert route_request("好的", vscode_workspace_id="vscode-current", conversation_context=unrelated).profile == "chat"


def test_weather_and_search_intents_keep_their_existing_instructions():
    web = route_request("帮我查一下 Python 3.14 的最新发布信息")
    assert set(web.tool_names) == COMMON | {"web_reader"}
    assert "联网检索" in web.system_prompt
    assert "web_reader" in web.system_prompt
    weather = route_request("查一下广州今天的天气")
    assert set(weather.tool_names) == COMMON | {"get_weather"}
    assert weather.profile == "weather"


def test_preview_tasks_receive_supported_defaults_without_legacy_or_disk_tools():
    for request in ["把 Preview 页面标题改成清单", "生成一个React demo", "新建一个3D模型",
                    "把当前 3D 模型改成紫色", "把当前 3D 场景导出为 GLB", "你好"]:
        route = route_request(request, has_preview=True)
        assert set(route.tool_names) == WEB_DEFAULTS
    assert "3D 模型任务" in route_request("帮我建一个 3D 模型", has_preview=True).system_prompt
    assert "不要重新生成或修改场景" in route_request("把当前 3D 场景导出为 GLB", has_preview=True).system_prompt


def test_explicit_document_format_rule_remains_outside_project_modes():
    assert set(route_request("请把以下内容生成 Word 文档").tool_names) == COMMON | {"create_word"}
    assert set(route_request("帮我制作一个简单的标题正文型 PPT").tool_names) == COMMON | {"create_ppt"}
    assert "Motion Schema" in route_request("帮我制作一个简单的标题正文型 PPT").system_prompt
    assert set(route_request("标题再大点", presentation_context={"title": "old deck"}).tool_names) == COMMON | {"create_ppt"}
    assert set(route_request("你好", presentation_context={"title": "old deck"}).tool_names) == COMMON
    assert len(route_request("继续优化这份演示文稿", presentation_context={"title": "demo"}).system_prompt) < len(SYSTEM_PROMPT)
    assert "Preview Project 源码工具" not in PRESENTATION_PROMPT


def test_server_disk_access_still_requires_explicit_legacy_authorization():
    assert set(route_request("修改当前项目的按钮颜色").tool_names) == COMMON
    authorized = route_request("修改当前项目的按钮颜色", allow_workspace_edit=True)
    assert set(authorized.tool_names) == COMMON | {
        "create_project_file", "edit_project_file", "read_project_file", "search_project_files",
    }
    assert set(route_request("帮我查看本地项目源码", allow_workspace_edit=True).tool_names) == COMMON | {
        "read_project_file", "search_project_files",
    }


def test_project_inspection_preserves_readonly_instructions_but_does_not_hide_supported_tools():
    for question in ["这个项目有哪些主要文件？", "帮我找到 App.tsx 里的计数器代码",
                     "PetTransportDetail.jsx 你能看到这里面的代码是干嘛的不",
                     "你能读到我本地文件吗", "能读下这个项目是干嘛的不"]:
        route = route_request(question, vscode_workspace_id="workspace")
        assert set(route.tool_names) == PLUGIN_DEFAULTS
        assert "只读" in route.system_prompt
    route = route_request("你能读到我本地文件吗", vscode_workspace_id="workspace")
    assert "不要把完整文件列表倾倒给用户" in route.system_prompt


def test_workspace_unregistered_only_offers_state_checks_and_generators():
    for question in ["你能读到我本地文件吗", "把计数器改成计次器", "新建 /src/New.tsx"]:
        route = route_request(question, vscode_client_mode=True)
        assert set(route.tool_names) == UNREGISTERED_DEFAULTS
        assert "工作区尚未成功注册" in route.system_prompt


def test_natural_edit_and_crud_requests_keep_existing_instructions_with_full_defaults():
    for request in [
        "把计数器改成计次器", "将待办清单改回原来标题", "把标题恢复成原来的标题",
        "还原待办清单的原标题", "Vite + React 18 · 一个简单的待办清单改成待办清单",
        "帮我再 page 增加个页面关于代办列表", "新建 /src/components/Header.tsx",
        "帮我创建一个 TodoList 应用", "新建 /src/components/Header.tsx 并在 App.tsx 中使用",
        "创建目录 /src/components/demo", "删除 /src/OldComponent.tsx", "删除空目录 /src/old",
        "删掉 OldWidget.tsx", "删掉页面上的旧按钮",
    ]:
        route = route_request(request, vscode_workspace_id="workspace")
        assert set(route.tool_names) == PLUGIN_DEFAULTS, request
        assert route.profile == "vscode_project_edit", request
        assert "不要再向用户请求手动确认" in route.system_prompt
        assert "默认用 write_project_file 直接覆盖" in route.system_prompt
        assert "绝不递归删除" in route.system_prompt
    how_to = route_request("怎么把当前页面标题改成待办清单？", vscode_workspace_id="workspace")
    assert "vscode_project_edit" not in how_to.profile
    assert set(how_to.tool_names) == PLUGIN_DEFAULTS


def test_stale_preview_cannot_supply_scene_or_legacy_tools_to_plugin():
    route = route_request("把页面标题改回来", has_preview=True, vscode_workspace_id="workspace")
    assert set(route.tool_names) == PLUGIN_DEFAULTS
    assert "set_3d_scene" not in route.tool_names
    assert not any("_preview_" in name for name in route.tool_names)


def test_provider_capabilities_filter_the_default_surface():
    route = route_request("你好", has_preview=True, project_capabilities={"listFiles": True, "rangeRead": True})
    assert set(route.tool_names) == COMMON | GENERATORS | {"list_project_files", "read_project_file"}
    route = route_request("你好", vscode_workspace_id="workspace", project_capabilities={"write": True})
    assert set(route.tool_names) == COMMON | GENERATORS | {"write_project_file"}


def test_other_specialist_rules_stay_opt_in():
    for question in ["你好", "revision 是什么？", "这个页面能再漂亮点吗"]:
        route = route_request(question, has_preview=True)
        assert not set(route.tool_names) & {"get_weather", "vector_search", "execute_python"}
    assert "execute_python" in route_request("运行这段 Python 代码").tool_names
    assert "vector_search" in route_request("查询我上传的文档").tool_names


def test_execution_layer_enforces_selected_tool_allowlist():
    result = asyncio.run(execute_tool("get_weather", {"city": "广州"}, allowed_tool_names=set()))
    assert "未开放工具" in result


def test_vscode_unregistered_edit_stops_before_model_can_offer_manual_source(monkeypatch):
    import agent.agent as agent_module

    def unexpected_model_call(_names):
        raise AssertionError("unregistered VS Code requests must not be sent to the LLM")

    monkeypatch.setattr(agent_module, "get_model_for_tools", unexpected_model_call)
    monkeypatch.setattr(agent_module, "TYPING_DELAY_MS", 0)
    events = []
    asyncio.run(agent_module.run_agent(
        [{"role": "user", "content": "把标题改回原来的"}],
        events.append,
        vscode_client_mode=True,
    ))

    text = "".join(event.get("content", "") for event in events if event.get("type") == "token")
    assert "工作区桥接尚未就绪" in text
    assert "源码" not in text


def test_vscode_contextual_restore_receives_real_tools_and_recovers_stale_capability_denial(monkeypatch):
    import agent.agent as agent_module

    bound_tools = []
    prompts = []

    class Model:
        async def ainvoke(self, messages, config=None):
            prompts.append(list(messages))
            if len(prompts) == 1:
                return AIMessage(content="本轮没有文件编辑工具，只能手动修改。")
            if len(prompts) == 2:
                return AIMessage(content="", tool_calls=[{"id": "read", "name": "read_project_file", "args": {"path": "/src/App.jsx"}}])
            if len(prompts) == 3:
                return AIMessage(content="", tool_calls=[{"id": "write", "name": "write_project_file", "args": {"path": "/src/App.jsx", "content": "<h1>React Demo</h1>", "expected_file_version": 5}}])
            return AIMessage(content="改好了，代码如下……")

    model = Model()
    monkeypatch.setattr(agent_module, "get_model_for_tools", lambda names: bound_tools.append(names) or model)
    monkeypatch.setattr(agent_module, "TYPING_DELAY_MS", 0)
    operations = []

    async def execute(name, args, *extra):
        operations.append((name, args))
        if name == "read_project_file":
            return json.dumps({"success": True, "path": "/src/App.jsx", "content": "<h1>待办清单</h1>", "fileVersion": 5})
        assert args["expected_file_version"] == 5
        return json.dumps({"success": True, "path": "/src/App.jsx", "changed": True, "diff": "-<h1>待办清单</h1>\n+<h1>React Demo</h1>"})

    monkeypatch.setattr(agent_module, "execute_tool", execute)
    events = []
    asyncio.run(agent_module.run_agent([
        {"role": "user", "content": "把 src/App.jsx 的 React Demo 改成待办清单"},
        {"role": "assistant", "content": "变更文件：src/App.jsx", "project_changes": [{"path": "/src/App.jsx", "diff": "-<h1>React Demo</h1>\n+<h1>待办清单</h1>"}]},
        {"role": "user", "content": "改回来"},
    ], events.append, vscode_client_mode=True, vscode_project_context=(object(), ProjectRef("vscode-context", "vscode"))))
    assert all("write_project_file" in names for names in bound_tools)
    assert [operation[0] for operation in operations] == ["read_project_file", "write_project_file"]
    context = "\n".join(str(message.content) for message in prompts[0])
    assert "最近工具已确认的工作区变更数据" in context
    assert "-<h1>React Demo</h1>" in context
    visible = "".join(event.get("content", "") for event in events if event.get("type") == "token")
    assert visible == summarize_project_changes('改回来', ['/src/App.jsx'], provider='vscode')


def test_vscode_deleted_file_appears_in_diff_without_deleted_source():
    import agent.agent as agent_module

    changes = agent_module._vscode_project_file_changes(
        "delete_project_file",
        {"success": True, "deleted": True, "path": "/src/OldWidget.tsx"},
        {},
    )
    assert changes == [{
        "path": "/src/OldWidget.tsx",
        "diff": "--- a/src/OldWidget.tsx\n+++ /dev/null\n[文件已删除]",
    }]


def test_vscode_edit_reply_only_lists_changed_files(monkeypatch):
    import agent.agent as agent_module

    class FakeModel:
        def __init__(self):
            self.calls = 0

        async def ainvoke(self, _messages, config=None):
            self.calls += 1
            if self.calls == 1:
                return AIMessage(content="", tool_calls=[{
                    "name": "write_project_file",
                    "args": {"path": "/src/App.tsx", "content": "export const value = 2;"},
                    "id": "write-1",
                }])
            return AIMessage(content="文件已修改，源码如下：export const value = 2;")

    model = FakeModel()
    monkeypatch.setattr(agent_module, "get_model_for_tools", lambda _names: model)
    monkeypatch.setattr(agent_module, "TYPING_DELAY_MS", 0)

    async def fake_execute_tool(*_args, **_kwargs):
        return json.dumps({
            "success": True,
            "path": "/src/App.tsx",
            "changed": True,
            "diff": "+export const value = 2;",
        })

    monkeypatch.setattr(agent_module, "execute_tool", fake_execute_tool)
    events = []
    asyncio.run(agent_module.run_agent(
        [{"role": "user", "content": "把当前工作区页面代码调整一下"}],
        events.append,
        vscode_project_context=(object(), ProjectRef("vscode-test", "vscode")),
        vscode_client_mode=True,
    ))

    visible = "".join(event.get("content", "") for event in events if event.get("type") == "token")
    assert 'Diff' in visible and '/src/App.tsx' not in visible
    tool_end = next(event for event in events if event.get("type") == "tool_end")
    assert tool_end["result"] == "变更文件：\n- /src/App.tsx"
    assert "export const" not in visible
    assert "export const" not in tool_end["result"]


def test_project_api_tool_dispatch_uses_the_request_project_ref():
    class FakeProjectAPI:
        async def list_files(self, project_ref):
            return {"success": True, "project_id": project_ref.project_id, "root": project_ref.root}

        async def search_code(self, project_ref, query, path, max_results):
            return {"query": query, "path": path, "root": project_ref.root, "max_results": max_results}

        async def read_file(self, project_ref, path, start_line, end_line):
            return {"path": path, "startLine": start_line, "endLine": end_line, "root": project_ref.root}

        async def patch_file(self, project_ref, path, old_text, new_text, expected_version):
            return {"path": path, "old_text": old_text, "new_text": new_text, "expected_version": expected_version, "root": project_ref.root}

        async def apply_patches(self, project_ref, patches, expected_version):
            return {"patches": patches, "expected_version": expected_version, "root": project_ref.root}

        async def write_file(self, project_ref, path, content, expected_version):
            return {"path": path, "content": content, "expected_version": expected_version, "root": project_ref.root}

        async def create_file(self, project_ref, path, content):
            return {"path": path, "content_chars": len(content), "root": project_ref.root, "created": True}

        async def create_directory(self, project_ref, path):
            return {"path": path, "root": project_ref.root, "created": True}

        async def delete_file(self, project_ref, path, expected_version):
            return {"path": path, "expected_version": expected_version, "root": project_ref.root, "deleted": True}

        async def delete_directory(self, project_ref, path, recursive):
            return {"path": path, "recursive": recursive, "root": project_ref.root, "deleted": True}

    api = FakeProjectAPI()
    context = (api, ProjectRef("vscode-test", "vscode"))
    listed = asyncio.run(execute_tool(
        "list_project_files", {"root": "root-2"}, allowed_tool_names={"list_project_files"},
        vscode_project_context=context,
    ))
    assert '"root": "root-2"' in listed

    read = asyncio.run(execute_tool(
        "read_project_file", {"path": "/src/App.tsx", "start_line": 8, "end_line": 14},
        allowed_tool_names={"read_project_file"}, vscode_project_context=context,
    ))
    assert '"startLine": 8' in read
    assert '"root": null' in read

    patched = asyncio.run(execute_tool(
        "patch_project_file", {
            "path": "/src/App.tsx", "old_text": "计数器", "new_text": "计次器",
            "expected_file_version": 12,
        }, allowed_tool_names={"patch_project_file"}, vscode_project_context=context,
    ))
    assert '"expected_version": 12' in patched
    assert '"root": null' in patched

    batch = asyncio.run(execute_tool(
        "batch_patch_project_files", {
            "root": "root-1", "patches": [{"path": "/src/App.tsx", "old_text": "x", "new_text": "y"}],
        }, allowed_tool_names={"batch_patch_project_files"}, vscode_project_context=context,
    ))
    assert '"root": "root-1"' in batch

    written = asyncio.run(execute_tool(
        "write_project_file", {
            "path": "/src/test.ts", "content": "export {};", "expected_file_version": 3,
        }, allowed_tool_names={"write_project_file"}, vscode_project_context=context,
    ))
    assert '"expected_version": 3' in written

    created = asyncio.run(execute_tool(
        "create_project_file", {
            "path": "/src/New.tsx", "content": "secret source", "root": "root-1",
        }, allowed_tool_names={"create_project_file"}, vscode_project_context=context,
    ))
    assert '"content_chars": 13' in created
    assert '"secret source"' not in created

    directory = asyncio.run(execute_tool(
        "create_project_directory", {"path": "/src/demo"},
        allowed_tool_names={"create_project_directory"}, vscode_project_context=context,
    ))
    assert '"created": true' in directory

    deleted_file = asyncio.run(execute_tool(
        "delete_project_file", {"path": "/src/Old.tsx", "expected_file_version": 9},
        allowed_tool_names={"delete_project_file"}, vscode_project_context=context,
    ))
    assert '"expected_version": 9' in deleted_file

    deleted_directory = asyncio.run(execute_tool(
        "delete_project_directory", {"path": "/src/empty", "recursive": True},
        allowed_tool_names={"delete_project_directory"}, vscode_project_context=context,
    ))
    assert '"recursive": false' in deleted_directory
