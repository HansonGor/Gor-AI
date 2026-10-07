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
        assert not set(web.tool_names) & {'write_project_file', 'create_project_file', 'delete_project_file'}, request
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


def test_static_question_gets_no_tools():
    route = route_request("revision 是什么？")
    assert route.profile == "chat"
    assert route.tool_names == ()


def test_vscode_followups_use_recent_user_edit_context_without_replaying_unrelated_history():
    history = [
        {"role": "user", "content": "把 src/App.jsx 的标题从 React Demo 改成待办清单"},
        {"role": "assistant", "content": "本轮没有工具，你可以手动修改这个标题。"},
    ]
    for text in ["就按上面的改", "按这个来", "好，执行", "继续", "好的", "改回原来的", "再大一点"]:
        route = route_request(text, vscode_workspace_id="vscode-current", conversation_context=history)
        assert "write_project_file" in route.tool_names, text
        assert "历史助手" in route.system_prompt
    for text in ["你好", "不用改了", "先不要执行", "怎么改回原来的？", "今天怎么样"]:
        route = route_request(text, vscode_workspace_id="vscode-current", conversation_context=history)
        assert "write_project_file" not in route.tool_names, text
    assert route_request("好的", vscode_workspace_id="vscode-current").tool_names == ()
    unrelated = history + [{"role": "user", "content": "讲个笑话"}]
    assert route_request("好的", vscode_workspace_id="vscode-current", conversation_context=unrelated).tool_names == ()
    # CRUD continuations inherit their target/category, not just generic writes.
    for task, tool in [("创建 src/New.jsx 文件", "create_project_file"), ("删除 src/Old.jsx 文件", "delete_project_file"), ("创建 src/demo 文件夹", "create_project_directory")]:
        route = route_request("按上面的来", vscode_workspace_id="vscode-current", conversation_context=[{"role": "user", "content": task}])
        assert tool in route.tool_names
    # Stale browser project state cannot steal the extension's tools.
    route = route_request("把页面标题改回来", has_preview=True, vscode_workspace_id="vscode-current")
    assert "write_project_file" in route.tool_names
    assert "write_preview_file" not in route.tool_names


def test_web_search_is_not_bound_to_other_tools():
    route = route_request("帮我查一下 Python 3.14 的最新发布信息")
    assert route.tool_names == ("web_search",)
    assert "联网检索" in route.system_prompt


def test_weather_does_not_also_bind_web_search():
    route = route_request("查一下广州今天的天气")
    assert route.tool_names == ("get_weather",)


def test_preview_edit_only_gets_preview_tools():
    route = route_request("把 Preview 页面标题改成清单", has_preview=True)
    assert set(route.tool_names) == {
        "batch_patch_preview_files",
        "list_preview_files",
        "patch_preview_file",
        "read_preview_file",
        "search_preview_code",
        "write_preview_file",
    }
    assert "web_search" not in route.tool_names
    assert "create_ppt" not in route.tool_names


def test_web_3d_model_requests_select_scene_tool_without_preview_keyword():
    route = route_request("帮我生成一个低多边形地球 3D 模型", has_preview=True)
    assert route.tool_names == ("set_3d_scene",)
    assert "3D 模型任务" in route.system_prompt

    glb_request = route_request("帮我创建一个可以导出 GLB 的 3D 模型", has_preview=True)
    assert glb_request.tool_names == ("set_3d_scene",)
    assert route_request("帮我建一个 3D 模型", has_preview=True).tool_names == ("set_3d_scene",)

    edit_request = route_request("把当前 3D 模型改成紫色", has_preview=True)
    assert set(edit_request.tool_names) == {"list_preview_files", "read_preview_file", "set_3d_scene"}

    export_only = route_request("把当前 3D 场景导出为 GLB", has_preview=True)
    assert export_only.tool_names == ()
    assert "不要重新生成或修改场景" in export_only.system_prompt

    # The VS Code extension has no Preview Worker; 3D Preview routing is web-only.
    plugin_route = route_request(
        "帮我生成一个低多边形地球 3D 模型",
        has_preview=True,
        vscode_client_mode=True,
    )
    assert "set_3d_scene" not in plugin_route.tool_names


def test_document_generation_uses_matching_format_only():
    route = route_request("请把以下内容生成 Word 文档")
    assert route.tool_names == ("create_word",)


def test_local_project_tools_require_explicit_authorization():
    text = "修改当前项目的按钮颜色"
    assert route_request(text, allow_workspace_edit=False).tool_names == ()
    route = route_request(text, allow_workspace_edit=True)
    assert set(route.tool_names) == {
        "create_project_file",
        "edit_project_file",
        "read_project_file",
        "search_project_files",
    }


def test_local_project_read_is_read_only_and_permission_gated():
    text = "帮我查看本地项目源码"
    assert route_request(text, allow_workspace_edit=False).tool_names == ()
    route = route_request(text, allow_workspace_edit=True)
    assert route.tool_names == ("read_project_file", "search_project_files")


def test_presentation_context_forces_presentation_tool():
    route = route_request("继续优化这份演示文稿", presentation_context={"title": "demo"})
    assert "create_ppt" in route.tool_names
    assert len(route.system_prompt) < len(SYSTEM_PROMPT)
    assert "Preview Project 源码工具" not in PRESENTATION_PROMPT


def test_simple_presentation_uses_the_unified_presentation_tool():
    route = route_request("帮我制作一个简单的标题正文型 PPT")
    assert route.tool_names == ("create_ppt",)
    assert route.profile == "presentation"
    assert "Motion Schema" in route.system_prompt


def test_unrelated_presentation_history_does_not_enable_tools():
    route = route_request("你好，今天怎么样？", presentation_context={"title": "old deck"})
    assert route.tool_names == ()


def test_short_presentation_revision_uses_recent_schema_without_web_tools():
    route = route_request("标题再大点", presentation_context={"title": "old deck"})
    assert route.tool_names == ("create_ppt",)


def test_question_about_local_latest_code_does_not_route_to_web():
    route = route_request("后台是否启用最新代码")
    assert route.tool_names == ()


def test_current_recommendations_get_web_only():
    route = route_request("推荐几家东京餐厅")
    assert route.tool_names == ("web_search",)


def test_execution_layer_enforces_selected_tool_allowlist():
    result = asyncio.run(execute_tool("get_weather", {"city": "广州"}, allowed_tool_names=set()))
    assert "未开放工具" in result


def test_vscode_project_requests_get_only_readonly_project_tools():
    workspace_id = "vscode-test-workspace"
    route = route_request("这个项目有哪些主要文件？", vscode_workspace_id=workspace_id)
    assert route.tool_names == ("list_project_files",)
    assert "只读" in route.system_prompt
    assert not ({"edit_project_file", "create_project_file", "patch_preview_file"} & set(route.tool_names))

    search_route = route_request("帮我找到 App.tsx 里的计数器代码", vscode_workspace_id=workspace_id)
    assert set(search_route.tool_names) == {"search_project_code", "read_project_file"}
    file_question = route_request(
        "PetTransportDetail.jsx 你能看到这里面的代码是干嘛的不",
        vscode_workspace_id=workspace_id,
    )
    assert set(file_question.tool_names) == {"list_project_files", "read_project_file"}
    access_question = route_request(
        "你能读到我本地文件吗",
        vscode_workspace_id=workspace_id,
    )
    assert access_question.tool_names == ("list_project_files",)
    assert "不要把完整文件列表倾倒给用户" in access_question.system_prompt
    project_question = route_request(
        "能读下这个项目是干嘛的不",
        vscode_workspace_id=workspace_id,
    )
    assert set(project_question.tool_names) == {
        "list_project_files", "search_project_code", "read_project_file",
    }
    assert route_request("你好", vscode_workspace_id=workspace_id).tool_names == ()


def test_vscode_local_file_access_question_reports_missing_workspace_registration():
    route = route_request("你能读到我本地文件吗", vscode_client_mode=True)
    assert route.tool_names == ("list_project_files",)
    assert "工作区尚未成功注册" in route.system_prompt


def test_vscode_counter_rename_routes_to_project_read_and_write_tools():
    route = route_request("把计数器改成计次器", vscode_workspace_id="vscode-current")
    assert set(route.tool_names) == {
        "search_project_code", "read_project_file", "patch_project_file",
        "batch_patch_project_files", "write_project_file",
    }
    assert "expected_file_version" in route.system_prompt
    assert "不要再向用户请求手动确认" in route.system_prompt
    assert "默认用 write_project_file 直接覆盖" in route.system_prompt
    assert route_request("你好", vscode_workspace_id="vscode-current").tool_names == ()

    unregistered = route_request("把计数器改成计次器", vscode_client_mode=True)
    assert unregistered.tool_names == ()
    assert "工作区桥接未就绪" in unregistered.system_prompt


def test_vscode_edit_intent_uses_connected_workspace_without_explicit_file_words():
    workspace_id = "vscode-react-demo"
    route = route_request(
        "Vite + React 18 · 一个简单的待办清单改成待办清单",
        vscode_workspace_id=workspace_id,
    )
    assert route.profile == "vscode_project_edit"
    assert {
        "search_project_code", "read_project_file", "patch_project_file",
        "batch_patch_project_files", "write_project_file",
    }.issubset(set(route.tool_names))

    add_page = route_request(
        "帮我再 page 增加个页面关于代办列表",
        vscode_workspace_id=workspace_id,
    )
    assert add_page.profile == "vscode_project_edit"
    assert {
        "create_project_file", "create_project_directory", "search_project_code",
        "read_project_file", "patch_project_file", "write_project_file",
    }.issubset(set(add_page.tool_names))

    # A question about how to make a change remains a normal informational turn.
    how_to = route_request("怎么把当前页面标题改成待办清单？", vscode_workspace_id=workspace_id)
    assert how_to.tool_names == ()


def test_vscode_crud_tools_require_explicit_create_or_delete_intent():
    workspace_id = "vscode-crud"
    create_file = route_request("新建 /src/components/Header.tsx", vscode_workspace_id=workspace_id)
    assert set(create_file.tool_names) == {"create_project_file", "create_project_directory"}
    assert "create_project_file" in create_file.system_prompt

    create_app = route_request("帮我创建一个 TodoList 应用", vscode_workspace_id=workspace_id)
    assert set(create_app.tool_names) == {"create_project_file", "create_project_directory"}

    create_and_use = route_request(
        "新建 /src/components/Header.tsx 并在 App.tsx 中使用",
        vscode_workspace_id=workspace_id,
    )
    assert {"create_project_file", "search_project_code", "read_project_file", "patch_project_file"}.issubset(
        set(create_and_use.tool_names)
    )

    create_dir = route_request("创建目录 /src/components/demo", vscode_workspace_id=workspace_id)
    assert create_dir.tool_names == ("create_project_directory",)

    delete_file = route_request("删除 /src/OldComponent.tsx", vscode_workspace_id=workspace_id)
    assert delete_file.tool_names == ("delete_project_file",)

    delete_dir = route_request("删除空目录 /src/old", vscode_workspace_id=workspace_id)
    assert delete_dir.tool_names == ("delete_project_directory",)
    assert "绝不递归删除" in delete_dir.system_prompt

    unregistered = route_request("新建 /src/New.tsx", vscode_client_mode=True)
    assert unregistered.tool_names == ()


def test_vscode_action_verbs_select_matching_workspace_tools():
    workspace_id = "vscode-action-verbs"
    code_tools = {
        "search_project_code", "read_project_file", "patch_project_file",
        "batch_patch_project_files", "write_project_file",
    }

    # Natural-language restore/update verbs must take the same write route as “改成”.
    for request in (
        "将待办清单改回原来标题",
        "把标题恢复成原来的标题",
        "还原待办清单的原标题",
    ):
        route = route_request(request, vscode_workspace_id=workspace_id)
        assert route.profile == "vscode_project_edit"
        assert code_tools.issubset(set(route.tool_names))

    create = route_request("新建 /src/components/Badge.tsx", vscode_workspace_id=workspace_id)
    assert set(create.tool_names) == {"create_project_file", "create_project_directory"}

    read = route_request("读一下 App.tsx", vscode_workspace_id=workspace_id)
    assert set(read.tool_names) == {"list_project_files", "read_project_file"}

    search = route_request("查找计数器在哪里定义", vscode_workspace_id=workspace_id)
    assert set(search.tool_names) == {"search_project_code", "read_project_file"}

    delete_path = route_request("删除 /src/OldWidget.tsx", vscode_workspace_id=workspace_id)
    assert delete_path.tool_names == ("delete_project_file",)

    # If only a basename is provided, expose discovery tools alongside delete so
    # the agent can resolve a unique workspace-relative path instead of guessing.
    delete_basename = route_request("删掉 OldWidget.tsx", vscode_workspace_id=workspace_id)
    assert set(delete_basename.tool_names) == {
        "list_project_files", "search_project_code", "read_project_file", "delete_project_file",
    }

    # Removing a UI element is a source edit, not deletion of a project file.
    remove_button = route_request("删掉页面上的旧按钮", vscode_workspace_id=workspace_id)
    assert code_tools.issubset(set(remove_button.tool_names))
    assert "delete_project_file" not in remove_button.tool_names

    # A how-to question is still informational and must not activate writes.
    how_to = route_request("怎么把当前页面标题改成待办清单？", vscode_workspace_id=workspace_id)
    assert how_to.tool_names == ()


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
