"""Real binding/negotiation with model/provider substitutes; no external IO."""

import asyncio
import json

import pytest
from langchain_core.messages import AIMessage, SystemMessage, ToolMessage

import agent.agent as agent
from agent.tool_negotiation import ToolNegotiator
from agent.tool_routing import route_request, PREVIEW_CAPABILITIES
from agent import tool_routing as routing
from config import config
from services.preview.workspace import PreviewProjectWorkspace
from tools.capability_request import request_tools


def negotiator(host="chat", capabilities=None, has_project=False, text="帮我处理这几个任务"):
    active = set(route_request(text).tool_names)
    return ToolNegotiator(active, text, host, capabilities, has_project)


@pytest.mark.parametrize("host", [{}, {"has_preview": True}, {"vscode_client_mode": True}])
def test_negotiation_is_available_without_trigger_keywords(host):
    route = route_request("好的", **host)
    assert "request_tools" in route.tool_names
    assert {"web_search", "search_images"} <= set(route.tool_names)
    assert {"tool_names", "reason", "subtask"} == set(request_tools.args)


@pytest.mark.parametrize("plugin", [False, True])
def test_new_web_react_generation_uses_module_rules_without_affecting_plugin(monkeypatch, plugin):
    captured = []
    class Model:
        async def ainvoke(self, messages, config=None):
            captured.extend(m.content for m in messages if isinstance(m, SystemMessage))
            return AIMessage(content="尚未创建文件。")
    monkeypatch.setattr(agent, "get_model_for_tools", lambda names: Model())
    monkeypatch.setattr(agent, "TYPING_DELAY_MS", 0)
    asyncio.run(agent.run_agent([{"role": "user", "content": "创建一个简单的 react-demo"}], lambda event: None,
        vscode_client_mode=plugin,
        preview_workspace=None if plugin else PreviewProjectWorkspace("new-react", "react", {})))
    policy = "\n".join(captured)
    assert ("Web React 使用 ES modules" in policy) is not plugin
    if not plugin:
        assert "组件通过 import/export" in policy and "CSS 在入口或组件 import" in policy
        assert "文件写入成功不代表构建成功" in policy


def test_catalog_discovers_all_public_tasks_but_not_legacy_disk_adapters():
    state = negotiator()
    catalog = state.catalog()
    for name in ["github_code", "get_weather", "execute_python", "create_ppt", "set_3d_scene", "delete_project_file"]:
        assert name in catalog
    assert "edit_project_file" not in catalog
    assert "search_project_files" not in catalog
    assert "on_request" in catalog


def test_mixed_request_adds_registered_tools_without_rewriting_existing_prompt(monkeypatch):
    monkeypatch.setattr(config.Search, "GITHUB_TOKEN", "test")
    state = negotiator()
    result, rules = state.request({"tool_names": ["github_code", "news_research", "weather"],
                                  "reason": "三个不同子任务", "subtask": "公开信息研究"})
    assert result["added_tools"] == ["search_github_code", "web_reader", "get_weather"]
    assert result["already_available"] == ["web_search"]
    assert result["task_executed"] is False
    assert "request_tools" in state.active and "search_images" in state.active
    assert len(rules) == 4  # Web, news, body reader and weather cards
    repeated, rules = state.request({"tool_names": ["github_code", "news_research", "weather"], "reason": "复用"})
    assert not repeated["added_tools"] and not rules


@pytest.mark.parametrize("name", ["set_3d_scene", "write_preview_file", "edit_project_file", "search_project_files"])
def test_plugin_cannot_load_preview_or_disk_adapters(name):
    state = negotiator("vscode", {"write": True, "rangeRead": True}, True)
    result, rules = state.request({"tool_names": [name], "reason": "需要额外工具"})
    assert not result["success"] and not result["added_tools"] and not rules
    assert name not in state.active


def test_provider_capabilities_and_missing_context_cannot_be_bypassed():
    for state in [negotiator("preview", PREVIEW_CAPABILITIES, True), negotiator("vscode")]:
        result, _ = state.request({"tool_names": ["delete_project_file"], "reason": "删除"})
        assert result["unavailable_tools"] == ["delete_project_file"]
    result, _ = negotiator("preview", PREVIEW_CAPABILITIES, True).request({
        "tool_names": ["write_preview_file"], "reason": "新文件"})
    assert result["added_tools"] == ["write_project_file"]


def test_missing_credentials_and_offline_requests_report_real_denial(monkeypatch):
    monkeypatch.setattr(config.Search, "GITHUB_TOKEN", "")
    state = negotiator()
    result, _ = state.request({"tool_names": ["github_code", "create_pdf"], "reason": "研究并生成报告"})
    assert result["code"] == "TOOLS_PARTIALLY_AVAILABLE"
    assert "凭据" in result["denial_reasons"]["search_github_code"]
    assert result["added_tools"] == ["create_pdf"]
    result, _ = negotiator(text="不要联网").request({"tool_names": ["github_code", "images"], "reason": "研究"})
    assert not result["success"] and not result["added_tools"]
    assert all("不联网" in reason for reason in result["denial_reasons"].values())


@pytest.mark.parametrize("args", [
    {}, {"tool_names": [], "reason": "a"}, {"tool_names": ["weather"], "reason": ""},
    {"tool_names": ["weather"] * 25, "reason": "a"}, {"tool_names": "weather", "reason": "a"},
    {"tool_names": ["weather"], "reason": "a", "subtask": {}},
    {"tool_names": ["```private source```"], "reason": "a"},
])
def test_invalid_requests_do_not_load_any_tools(args):
    state = negotiator()
    before = set(state.active)
    result, rules = state.request(args)
    assert result["code"] == "INVALID_TOOL_REQUEST"
    assert state.active == before and not rules


def test_cancelled_request_and_repeated_denial_preserve_bindings():
    state = negotiator()
    before = set(state.active)
    args = {"tool_names": ["independent_projects", "unknown_tool"], "reason": "复合项目"}
    result, rules = state.request(args, cancelled=True)
    assert result["code"] == "OPERATION_CANCELLED" and state.active == before
    first, _ = state.request(args)
    second, rules = state.request(args)
    assert first == second and not rules and state.active == before
    assert "分轮创建" in state.limitation_note()


@pytest.mark.parametrize("plugin", [False, True])
def test_agent_rebinds_tools_after_request_then_executes_both_subtasks(monkeypatch, plugin):
    monkeypatch.setattr(config.Search, "GITHUB_TOKEN", "test")
    bindings, calls, executed = [], [], []
    class Model:
        async def ainvoke(self, messages, config=None):
            calls.append(list(messages))
            if len(calls) == 1:
                assert "search_github_code" not in bindings[-1]
                return AIMessage(content="", tool_calls=[{"id": "request", "name": "request_tools", "args": {
                    "tool_names": ["github_code", "create_word"], "reason": "参考实现并整理可分享报告", "subtask": "研究与报告",
                }}])
            if len(calls) == 2:
                assert {"search_github_code", "create_word", "search_images", "web_search", "request_tools"} <= set(bindings[-1])
                assert any(isinstance(m, ToolMessage) and '"task_executed": false' in m.content for m in messages)
                return AIMessage(content="", tool_calls=[
                    {"id": "code", "name": "search_github_code", "args": {"query": "HanUI"}},
                    {"id": "doc", "name": "create_word", "args": {"title": "报告", "sections": []}},
                ])
            return AIMessage(content="已查阅参考实现并整理报告，可从附件查看。")
    async def execute(name, args, *extra):
        executed.append(name)
        return json.dumps({"success": True, "fileType": "word", "displayName": "报告.docx", "downloadUrl": "/api/download/test"}) if name == "create_word" else "已检索参考实现。"
    monkeypatch.setattr(agent, "get_model_for_tools", lambda names: bindings.append(names) or Model())
    monkeypatch.setattr(agent, "execute_tool", execute)
    monkeypatch.setattr(agent, "TYPING_DELAY_MS", 0)
    events = []
    asyncio.run(agent.run_agent([{"role": "user", "content": "看看合适的参考资料，再整理便于分享的说明"}], events.append,
                               vscode_client_mode=plugin))
    assert executed == ["search_github_code", "create_word"]
    assert len(calls) == 3 and any(e["type"] == "file_ready" for e in events)
    assert not any(e["type"].startswith("preview_") for e in events)


def test_request_does_not_authorize_unbound_call_in_same_batch(monkeypatch):
    calls, outcomes = [], []
    class Model:
        async def ainvoke(self, messages, config=None):
            calls.append(messages)
            if len(calls) == 1:
                return AIMessage(content="", tool_calls=[
                    {"id": "load", "name": "request_tools", "args": {"tool_names": ["weather"], "reason": "天气"}},
                    {"id": "unsafe", "name": "get_weather", "args": {"city": "广州"}},
                ])
            outcomes.extend(m.content for m in messages if isinstance(m, ToolMessage))
            return AIMessage(content="工具已补充，还未查询天气。")
    monkeypatch.setattr(agent, "get_model_for_tools", lambda names: Model())
    monkeypatch.setattr(agent, "TYPING_DELAY_MS", 0)
    asyncio.run(agent.run_agent([{"role": "user", "content": "你好"}], lambda e: None))
    assert any("本轮任务未开放工具" in outcome for outcome in outcomes)


def test_unknown_capability_falls_back_to_default_answer_without_execution(monkeypatch):
    calls, events = [], []
    class Model:
        async def ainvoke(self, messages, config=None):
            calls.append(messages)
            if len(calls) == 1:
                return AIMessage(content="", tool_calls=[{"id": "load", "name": "request_tools", "args": {
                    "tool_names": ["independent_projects"], "reason": "React 和 3D 分为独立项目",
                }}])
            return AIMessage(content="当前不能同轮创建两个独立项目，可分轮生成，未创建任何文件。")
    async def unexpected(*args):
        raise AssertionError("negotiation must not execute the task")
    monkeypatch.setattr(agent, "get_model_for_tools", lambda names: Model())
    monkeypatch.setattr(agent, "execute_tool", unexpected)
    monkeypatch.setattr(agent, "TYPING_DELAY_MS", 0)
    asyncio.run(agent.run_agent([{"role": "user", "content": "创建简单 React-demo 和 3D 模型"}], events.append,
                               preview_workspace=PreviewProjectWorkspace("new", "react", {})))
    assert len(calls) == 2
    text = "".join(e.get("content", "") for e in events if e["type"] == "token")
    assert "分轮" in text and "未创建" in text
    assert not any(e["type"] == "preview_file_changed" for e in events)


@pytest.mark.parametrize("tool,args,files", [
    ("set_3d_scene", {"scene": {}}, {"/src/App.jsx": "react"}),
    ("write_project_file", {"path": "/src/App.tsx", "content": "react"}, {"/src/scene.json": "{}"}),
    ("write_project_file", {"path": "/src/scene.json", "content": "{}"}, {"/src/main.jsx": "react"}),
    ("batch_patch_project_files", {"patches": [{"path": "/src/App.jsx"}, {"path": "/src/scene.json"}]}, {}),
])
def test_conflicting_project_kinds_do_not_change_workspace(tool, args, files):
    workspace = PreviewProjectWorkspace("existing", "react", dict(files))
    result = json.loads(asyncio.run(agent.execute_tool(tool, args, preview_workspace=workspace,
                                                     allowed_tool_names={tool})))
    assert result["code"] == "INDEPENDENT_PROJECT_CONTEXT_REQUIRED"
    assert workspace.files == files and workspace.revision == 0


def test_legacy_mixed_snapshot_allows_unrelated_edit_and_pure_3d_updates():
    from agent.project_task_boundary import project_kind_conflict
    mixed = PreviewProjectWorkspace("old", "html", {"/src/scene.json": "{}", "/src/App.jsx": "old"})
    assert project_kind_conflict(mixed, "write_project_file", {"path": "/src/styles.css"}) is None
    assert project_kind_conflict(mixed, "patch_project_file", {"path": "/src/App.jsx"}) is None
    pure = PreviewProjectWorkspace("scene", "html", {"/src/scene.json": "{}"})
    assert project_kind_conflict(pure, "set_3d_scene", {}) is None


def test_generation_can_write_then_request_more_tools_and_finish_subtask(monkeypatch):
    calls, bindings, executed, events = [], [], [], []
    workspace = PreviewProjectWorkspace("new", "react", {})
    real_execute = agent.execute_tool
    class Model:
        async def ainvoke(self, messages, config=None):
            calls.append(list(messages))
            if len(calls) == 1:
                return AIMessage(content="", tool_calls=[{"id": "file", "name": "write_project_file", "args": {
                    "path": "/index.html", "content": "<main>demo</main>", "expected_version": 0,
                }}])
            if len(calls) == 2:
                return AIMessage(content="", tool_calls=[{"id": "load", "name": "request_tools", "args": {
                    "tool_names": ["weather"], "reason": "还需要查询天气子任务",
                }}])
            if len(calls) == 3:
                assert "get_weather" in bindings[-1]
                return AIMessage(content="", tool_calls=[{"id": "weather", "name": "get_weather", "args": {"city": "广州"}}])
            return AIMessage(content="页面已生成，天气已查询。")
    async def execute(name, args, *extra):
        executed.append(name)
        if name == "get_weather":
            return "【广州天气】\n当前温度：20°C"
        return await real_execute(name, args, *extra)
    monkeypatch.setattr(agent, "get_model_for_tools", lambda names: bindings.append(names) or Model())
    monkeypatch.setattr(agent, "execute_tool", execute)
    monkeypatch.setattr(agent, "TYPING_DELAY_MS", 0)
    asyncio.run(agent.run_agent([{"role": "user", "content": "创建个简单页面并完成另一个子任务"}], events.append,
                               preview_workspace=workspace))
    assert executed == ["write_project_file", "get_weather"]
    assert len(calls) == 4
    assert workspace.files == {"/index.html": "<main>demo</main>"}
    assert not any(e["type"] == "project_file_changed" for e in events)
    text = "".join(e.get("content", "") for e in events if e["type"] == "token")
    assert "另外完成了天气查询" in text
    assert "<main>" not in text


def test_spaced_group_names_load_news_card_once():
    state = negotiator()
    result, rules = state.request({"tool_names": [" news_research ", "news_research"], "reason": "新闻子任务"})
    assert result["requested_tools"] == ["news_research"]
    assert len(rules) == 3
    assert sum(rule == routing.WEB_READER_PROMPT for rule in rules) == 1


def test_partial_generation_keeps_denial_visible_after_successful_write(monkeypatch):
    calls, events = [], []
    workspace = PreviewProjectWorkspace("new", "react", {})
    class Model:
        async def ainvoke(self, messages, config=None):
            calls.append(list(messages))
            if len(calls) == 1:
                return AIMessage(content="", tool_calls=[{"id": "file", "name": "write_project_file", "args": {
                    "path": "/index.html", "content": "<main>demo</main>", "expected_version": 0,
                }}])
            if len(calls) == 2:
                return AIMessage(content="", tool_calls=[{"id": "load", "name": "request_tools", "args": {
                    "tool_names": ["independent_projects"], "reason": "另外建立独立的模型项目",
                }}])
            return AIMessage(content="<main>demo</main>，全部创建成功。")
    monkeypatch.setattr(agent, "get_model_for_tools", lambda names: Model())
    monkeypatch.setattr(agent, "TYPING_DELAY_MS", 0)
    asyncio.run(agent.run_agent([{"role": "user", "content": "创建个页面并另外创建模型"}], events.append,
                               preview_workspace=workspace))
    text = "".join(e.get("content", "") for e in events if e["type"] == "token")
    assert "分轮创建" in text and "未完成的部分" in text
    assert "全部创建成功" not in text and "<main>" not in text
    assert workspace.files == {"/index.html": "<main>demo</main>"}


@pytest.mark.parametrize("text", [
    '把“计数器”改成“计次器”，再查广州天气',
    '把计数器改成计次器并查询天气',
    '将“Hello”改成“World”，另外生成一份 Word 文档',
    '将所有“Hello”统一改为“World”，然后查 GitHub 示例',
])
def test_compound_literal_edit_is_not_treated_as_single_fast_task(text):
    workspace = PreviewProjectWorkspace("current", "react", {"/src/App.jsx": "计数器"})
    task, fast = agent._classify_preview_task(text, workspace)
    assert task != "SIMPLE_EDIT" and fast is None


def test_quoted_connectors_are_still_valid_literal_replacements():
    parsed = agent._extract_explicit_text_edit('把“同时”改成“另外”')
    assert parsed["old_text"] == "同时" and parsed["new_text"] == "另外"
