"""Default tool availability, host isolation and actual search execution."""

import asyncio
import json

import pytest
from langchain_core.messages import AIMessage, SystemMessage, ToolMessage

import agent.agent as agent_module
from agent.tool_routing import route_request
from project_api.types import ProjectRef
from tools.index import TOOLS
from tools.web_search import _SEARCH_RESULT_MARKER


HOSTS = [{}, {"has_preview": True}, {"vscode_client_mode": True},
         {"vscode_client_mode": True, "vscode_workspace_id": "workspace"}]


@pytest.mark.parametrize("host", [{}, {"vscode_client_mode": True}])
def test_news_keeps_three_to_four_independent_items_without_padding(host):
    prompt = route_request("整理今日热点新闻", **host).system_prompt
    # 2026-10-19 提速：条数由 5–8 条逐步收紧为 3–4 条，每条 2～3 句、全文约 600～800 字，段尾来源不写网址
    assert "3–4 条最重要的独立资讯" in prompt and "不超过 4 条" in prompt
    assert "全文合计约 600～800 字" in prompt
    assert "（来源：媒体/机构名称，发布日期）[S#]”，不写网址" in prompt
    assert "5–8 条" not in prompt and "3–5 条" not in prompt
    assert "同一事件时合并成一条资讯" in prompt
    assert "来源篇数不等于独立资讯条数" in prompt
    assert "单一事件、型号或聚焦问题只回答所问" in prompt
    assert "不能为了凑够" in prompt
    assert "不编造热搜排名" in prompt


@pytest.mark.parametrize("host", HOSTS)
@pytest.mark.parametrize("question", [
    "你好", "好的", "现在继续", "讲个笑话", "revision 是什么？", "1+2是多少？",
    "总结这段话：今天发布新模型", "翻译：a new model was released",
    "不要联网，Grok发布新模型了吗", "这座城市的公共交通方便吗",
    "我上传的文档有最新消息吗", "后台是否启用最新代码",
    "grok有发布什么新模型吗", "搜索 GitHub 代码 HanUI",
])
def test_every_chat_always_discovers_web_search_and_images(question, host):
    route = route_request(question, **host)
    assert {"web_search", "search_images"}.issubset(route.tool_names)
    assert "web_fallback" not in route.profile


@pytest.mark.parametrize("host", HOSTS)
@pytest.mark.parametrize("question", [
    "搜索 GitHub 代码 HanUI", "GitHub代码搜索 HanUI", "GitHub Code Search HanUI",
    "查找 GitHub 上 HanUI 的源码", "找几个 HanUI 开源实现",
])
def test_github_is_an_independent_skill_on_both_hosts(question, host):
    route = route_request(question, **host)
    assert "search_github_code" in route.tool_names
    assert "github_code" in route.selected_skills
    assert "必须调用 web_search。该统一入口" not in route.system_prompt
    github = next(tool for tool in TOOLS if tool.name == "search_github_code")
    assert "query" in github.args


def test_public_github_research_does_not_become_workspace_edit_and_private_code_stays_local():
    public = route_request("搜索 GitHub 代码 HanUI", vscode_client_mode=True, vscode_workspace_id="ws")
    assert "vscode_project_edit" not in public.profile
    assert "github_code" in public.selected_skills
    private = route_request("搜索当前工作区代码", vscode_client_mode=True, vscode_workspace_id="ws")
    assert "search_project_code" in private.tool_names
    assert "search_github_code" not in private.tool_names
    assert not private.requires_web_search


def test_short_followup_inherits_topic_without_losing_default_tools():
    history = [
        {"role": "user", "content": "grok有发布什么新模型吗"},
        {"role": "assistant", "content": "我没有联网工具，不能查询最新信息。"},
    ]
    assert route_request("那最近呢", conversation_context=history).requires_web_search
    history.append({"role": "user", "content": "本地代码更新了"})
    assert not route_request("那最近呢", conversation_context=history).requires_web_search
    assert set(route_request("好的", conversation_context=history).tool_names) == {"web_search", "search_images", "request_tools"}


def test_multitask_news_and_code_keep_both_skills():
    route = route_request("看看最近 MCP 的新闻，再找几个 GitHub 实现")
    assert {"news_research", "github_code"}.issubset(route.selected_skills)
    assert {"web_search", "web_reader", "search_github_code", "search_images"}.issubset(route.tool_names)


@pytest.mark.parametrize("question", [
    "Python 最新版本是什么", "Vite 当前版本是多少", "What is the latest Node version?",
])
def test_current_version_routes_to_search_and_body_reader(question):
    route = route_request(question)
    assert {"web_search", "web_reader"}.issubset(route.tool_names)
    assert "新闻与最新版本检索规则" in route.system_prompt


@pytest.mark.parametrize("host", HOSTS)
def test_news_answer_uses_article_cards_without_search_process_commentary(host):
    route = route_request("grok有发布什么新模型吗", **host)
    prompt = route.system_prompt

    assert "news_research" in route.selected_skills
    assert "## 序号. 标题" in prompt
    assert "没有页面发布日期但正文可信相关时仍可列出，只省略日期" in prompt
    assert "没有页面发布日期但正文可信相关时仍可列出" in prompt
    assert "不解释缺失原因" in prompt
    assert "不设固定 3 天截止" in prompt
    assert "官方/官网优先用于核实事实，但不是唯一来源" in prompt
    assert "技术博客" in prompt
    assert "按实际发布时间由新到旧排列，最新一篇在最前" in prompt
    assert "将名称做成 Markdown 可点击链接" in prompt
    assert "不得猜造、拼接或替换目标地址" in prompt
    assert "禁止出现检索轮数/次数" in prompt
    assert "旧闻排除清单" in prompt
    assert "只有确实有帮助时才用一行" in prompt


@pytest.mark.parametrize("plugin", [False, True])
@pytest.mark.parametrize("first_answer", ["我无法联网，没有联网工具。", "凭记忆，现在没有新模型。"])
@pytest.mark.parametrize("published_at", ["2026-10-08", ""])
def test_agent_corrects_unverified_answer_then_searches_and_emits_real_sources(monkeypatch, plugin, first_answer, published_at):
    calls, bindings, operations = [], [], []
    payload = {"query": "xAI 新模型 官方发布", "results": [
        {"title": "测试官方公告", "url": "https://example.com/release", "source_id": "S1"},
    ]}

    class Model:
        async def ainvoke(self, messages, config=None):
            calls.append(list(messages))
            if len(calls) == 1:
                return AIMessage(content=first_answer)
            if len(calls) == 2:
                return AIMessage(content="", tool_calls=[{
                    "id": "search", "name": "web_search", "args": {"query": payload["query"]},
                }])
            # 2026-10-19 起：新闻搜索后程序直接读网址，第 3 次模型调用即写回答
            date_label = f"，{published_at}" if published_at else ""
            return AIMessage(content=f"## 一、测试官方公告\n官方发布正文摘要。（来源：官方团队{date_label}）[S1]")

    async def execute(name, args, *extra):
        operations.append((name, args))
        if name == "web_reader":
            return json.dumps({"success": True, "requested_pages": 1, "pages": [{
                "title": "测试官方公告", "body": "官方发布正文。" * 30,
                "published_at": published_at, "author": "官方团队",
                "url": "https://example.com/release", "key_paragraphs": ["官方发布正文。" * 8],
                "sourceId": "S1",
            }], "failures": []}, ensure_ascii=False)
        return _SEARCH_RESULT_MARKER + json.dumps({"text": "[S1] 测试公告数据", "payload": payload})

    monkeypatch.setattr(agent_module, "get_model_for_tools", lambda names: bindings.append(names) or Model())
    monkeypatch.setattr(agent_module, "execute_tool", execute)
    monkeypatch.setattr(agent_module, "TYPING_DELAY_MS", 0)
    monkeypatch.setattr(agent_module, "MAX_ITERATIONS", 4)
    events = []
    asyncio.run(agent_module.run_agent([
        {"role": "assistant", "content": "之前没有联网工具。"},
        {"role": "user", "content": "grok有发布什么新模型吗"},
    ], events.append, vscode_client_mode=plugin,
        vscode_project_context=(object(), ProjectRef("ws", "vscode")) if plugin else None))
    assert all({"web_search", "search_images"}.issubset(names) for names in bindings)
    assert [name for name, _ in operations] == ["web_search", "web_reader"]
    systems = "\n".join(str(message.content) for message in calls[0] if isinstance(message, SystemMessage))
    assert "Asia/Shanghai" in systems and "已实际绑定 web_search" in systems
    assert "历史回复" in systems
    assert any(isinstance(message, ToolMessage) and "官方发布正文" in message.content for message in calls[-1])
    assert any(isinstance(message, ToolMessage) and "published_at" in message.content for message in calls[-1])
    assert any(event.get("type") == "search_sources" for event in events)
    visible = "".join(event.get("content", "") for event in events if event.get("type") == "token")
    assert first_answer not in visible
    assert "[S1]" in visible
    if not published_at:
        assert "发布时间未确认" not in visible
        assert "没有时间" not in visible
        assert "无法核实日期" not in visible
    assert not any(event.get("type", "").startswith("preview_") for event in events)


def test_negotiated_news_skill_enforces_search_then_reader_before_final(monkeypatch):
    calls, bindings, operations = [], [], []
    url = "https://example.com/current-release"

    class Model:
        async def ainvoke(self, messages, config=None):
            calls.append(list(messages))
            turn = len(calls)
            if turn == 1:
                return AIMessage(content="", tool_calls=[{
                    "id": "request", "name": "request_tools",
                    "args": {"tool_names": ["news_research"], "reason": "核实当前发布情况"},
                }])
            if turn == 2:
                return AIMessage(content="我会先确认信息。")
            if turn == 3:
                return AIMessage(content="", tool_calls=[{
                    "id": "search", "name": "web_search", "args": {"query": "当前发布信息"},
                }])
            if turn == 4:
                return AIMessage(content="我已看到搜索摘要，发布内容如下。")
            if turn == 5:
                return AIMessage(content="", tool_calls=[{
                    "id": "read", "name": "web_reader", "args": {"urls": [url], "query": "当前发布信息"},
                }])
            return AIMessage(content="根据官方页面正文，当前发布情况如下。[S1]")

    async def execute(name, args, *extra):
        operations.append(name)
        if name == "web_reader":
            return json.dumps({"success": True, "requested_pages": 1, "pages": [{
                "title": "官方发布", "body": "官方正文内容。" * 30,
                "published_at": "2026-10-08", "author": "官方团队", "url": url,
                "key_paragraphs": ["官方正文内容。" * 8],
            }], "failures": []}, ensure_ascii=False)
        return _SEARCH_RESULT_MARKER + json.dumps({"text": "[S1] 官方发布摘要", "payload": {
            "query": args.get("query", ""), "results": [{
                "title": "官方发布", "url": url, "sourceId": "S1",
            }],
        }})

    monkeypatch.setattr(agent_module, "get_model_for_tools", lambda names: bindings.append(names) or Model())
    monkeypatch.setattr(agent_module, "execute_tool", execute)
    monkeypatch.setattr(agent_module, "TYPING_DELAY_MS", 0)
    monkeypatch.setattr(agent_module, "MAX_ITERATIONS", 8)
    events = []
    asyncio.run(agent_module.run_agent([{"role": "user", "content": "帮我了解一下这个主题的内容"}], events.append))

    assert "web_reader" not in bindings[0]
    assert "web_reader" in bindings[1]
    assert operations == ["web_search", "web_reader"]
    assert len(calls) == 6
    assert any(isinstance(message, ToolMessage) and "官方正文内容" in message.content for message in calls[-1])


def test_reader_failure_keeps_user_reply_short_and_hides_provider_diagnostics(monkeypatch):
    calls, operations = [], []
    url = "https://example.com/news"

    class Model:
        async def ainvoke(self, messages, config=None):
            calls.append(list(messages))
            turn = len(calls)
            if turn == 1:
                return AIMessage(content="", tool_calls=[{
                    "id": "search", "name": "web_search", "args": {"query": "Grok 最新资讯"},
                }])
            # 搜索后程序先自动读一次（失败）；模型直接作答会被要求先读正文，第 3 次再读一次
            if turn == 3:
                return AIMessage(content="", tool_calls=[{
                    "id": f"reader-{turn}", "name": "web_reader", "args": {"urls": [url], "query": "Grok 最新资讯"},
                }])
            return AIMessage(content="根据这些结果整理资讯。")

    async def execute(name, args, *extra):
        operations.append(name)
        if name == "web_reader":
            return json.dumps({"success": False, "requested_pages": 1, "pages": [],
                               "failures": [{"url": url, "error": "403 Forbidden"}]}, ensure_ascii=False)
        return _SEARCH_RESULT_MARKER + json.dumps({"text": "[S1] Grok 新闻摘要", "payload": {
            "query": args["query"], "results": [{"title": "Grok 资讯", "url": url, "sourceId": "S1"}],
        }})

    monkeypatch.setattr(agent_module, "get_model_for_tools", lambda names: Model())
    monkeypatch.setattr(agent_module, "execute_tool", execute)
    monkeypatch.setattr(agent_module, "TYPING_DELAY_MS", 0)
    monkeypatch.setattr(agent_module, "MAX_ITERATIONS", 8)
    events = []
    asyncio.run(agent_module.run_agent([{"role": "user", "content": "grok有发布什么新模型吗"}], events.append))

    visible = "".join(event.get("content", "") for event in events if event.get("type") == "token")
    assert operations == ["web_search", "web_reader", "web_reader"]
    assert visible == "目前没有足够可引用的正文内容，无法整理成可靠资讯。"
    assert "403" not in visible
    assert "搜索" not in visible
    assert "读取失败" not in visible


@pytest.mark.parametrize("plugin", [False, True])
def test_web_result_unlocks_independent_github_skill_and_keeps_citations_unique(monkeypatch, plugin):
    calls, bindings, operations = [], [], []

    class Model:
        async def ainvoke(self, messages, config=None):
            calls.append(list(messages))
            if len(calls) == 1:
                return AIMessage(content="", tool_calls=[{
                    "id": "web", "name": "web_search", "args": {"query": "HanUI"},
                }])
            if len(calls) == 2:
                assert "search_github_code" in bindings[-1]
                return AIMessage(content="", tool_calls=[{
                    "id": "code", "name": "search_github_code", "args": {"query": "HanUI"},
                }])
            return AIMessage(content="官方介绍与源码实现可供参考。[S1][S2]")

    async def execute(name, args, *extra):
        operations.append((name, args))
        is_github = name == "search_github_code"
        payload = {
            "query": args["query"], "intent": "code_example" if is_github else "technical_docs",
            "github_skill_used": is_github, "github_skill_status": "success" if is_github else "not_requested",
            "results": [{"title": "HanUI", "url": "https://github.com/example/hanui/blob/main/src/index.ts" if is_github
                         else "https://hanui.example/docs", "sourceId": "S1"}],
        }
        return _SEARCH_RESULT_MARKER + json.dumps({"text": "[S1] 有界参考摘要", "payload": payload})

    monkeypatch.setattr(agent_module, "get_model_for_tools", lambda names: bindings.append(names) or Model())
    monkeypatch.setattr(agent_module, "execute_tool", execute)
    monkeypatch.setattr(agent_module, "TYPING_DELAY_MS", 0)
    events = []
    asyncio.run(agent_module.run_agent(
        [{"role": "user", "content": "帮我查一下 HanUI"}], events.append, vscode_client_mode=plugin,
        vscode_project_context=(object(), ProjectRef("ws", "vscode")) if plugin else None,
    ))
    assert "search_github_code" not in bindings[0]
    assert [name for name, _ in operations] == ["web_search", "search_github_code"]
    source_events = [event for event in events if event.get("type") == "search_sources"]
    assert [event["sources"][0]["sourceId"] for event in source_events] == ["S1", "S2"]
    assert source_events[1]["searchTrace"]["githubSkillUsed"]
    assert any(isinstance(message, ToolMessage) and "[S2]" in message.content for message in calls[-1])
    assert not any(event.get("type", "").startswith("preview_") for event in events)


@pytest.mark.parametrize("tool_name", ["web_search", "web_reader", "search_images", "search_github_code"])
@pytest.mark.parametrize("question,query", [
    ("不要联网，只解释这段文字", "public topic"),
    ("查下当前项目", "D:\\\\Private\\\\App.jsx"),
])
def test_available_public_tools_do_not_execute_offline_or_private_queries(monkeypatch, tool_name, question, query):
    class Model:
        def __init__(self):
            self.calls = 0
        async def ainvoke(self, messages, config=None):
            self.calls += 1
            if self.calls == 1:
                return AIMessage(content="", tool_calls=[{
                    "id": "request", "name": tool_name, "args": {"query": query},
                }])
            return AIMessage(content="按当前要求处理。")
    model = Model()
    async def unexpected(*args, **kwargs):
        raise AssertionError("private/offline search must not reach external providers")
    monkeypatch.setattr(agent_module, "get_model_for_tools", lambda names: model)
    monkeypatch.setattr(agent_module, "execute_tool", unexpected)
    monkeypatch.setattr(agent_module, "TYPING_DELAY_MS", 0)
    events = []
    asyncio.run(agent_module.run_agent([{"role": "user", "content": question}], events.append))
    end = next(event for event in events if event["type"] == "tool_end")
    assert "PUBLIC_SEARCH_NOT_ALLOWED" in end["result"]


@pytest.mark.parametrize("budget", [1, 4])
def test_search_guard_retries_at_most_once_and_reports_not_executed(monkeypatch, budget):
    calls = []

    class Model:
        async def ainvoke(self, messages, config=None):
            calls.append(list(messages))
            return AIMessage(content="无法联网，所以没有新发布。")

    monkeypatch.setattr(agent_module, "get_model_for_tools", lambda names: Model())
    monkeypatch.setattr(agent_module, "TYPING_DELAY_MS", 0)
    monkeypatch.setattr(agent_module, "MAX_ITERATIONS", budget)
    events = []
    asyncio.run(agent_module.run_agent([{"role": "user", "content": "grok有发布什么新模型吗"}], events.append))
    assert len(calls) == min(2, budget)
    visible = "".join(event.get("content", "") for event in events if event.get("type") == "token")
    assert "目前无法提供有来源支持的最新资讯。" in visible
    assert "模型没有完成查询" not in visible
    assert "所以没有新发布" not in visible


def test_unknown_route_does_not_force_search_for_clarification(monkeypatch):
    class Model:
        async def ainvoke(self, messages, config=None):
            return AIMessage(content="你指的是哪座城市？")

    monkeypatch.setattr(agent_module, "get_model_for_tools", lambda names: Model())
    monkeypatch.setattr(agent_module, "TYPING_DELAY_MS", 0)
    events = []
    asyncio.run(agent_module.run_agent([{"role": "user", "content": "这座城市的公共交通方便吗"}], events.append))
    assert "".join(event.get("content", "") for event in events if event.get("type") == "token") == "你指的是哪座城市？"
    assert not any(event.get("type") == "tool_start" for event in events)


@pytest.mark.parametrize("plugin", [False, True])
@pytest.mark.parametrize("query", ["HanUI", "repo:facebook/react filename:App.tsx"])
def test_model_can_choose_independent_github_directly_without_web_search(monkeypatch, plugin, query):
    class Model:
        def __init__(self):
            self.calls = 0
        async def ainvoke(self, messages, config=None):
            self.calls += 1
            if self.calls == 1:
                return AIMessage(content="", tool_calls=[{
                    "id": "code", "name": "search_github_code", "args": {"query": query},
                }])
            return AIMessage(content="找到了源码参考，实现方式见链接。[S1]")
    model, operations = Model(), []
    async def execute(name, args, *extra):
        operations.append(name)
        return _SEARCH_RESULT_MARKER + json.dumps({
            "text": "[S1] path: src/index.ts",
            "payload": {"query": "HanUI", "intent": "code_example", "github_skill_used": True,
                        "github_skill_status": "success", "results": [
                            {"sourceId": "S1", "url": "https://github.com/example/hanui/blob/main/src/index.ts"},
                        ]},
        })
    def bind(names):
        assert "search_github_code" in names
        return model
    monkeypatch.setattr(agent_module, "get_model_for_tools", bind)
    monkeypatch.setattr(agent_module, "execute_tool", execute)
    monkeypatch.setattr(agent_module, "TYPING_DELAY_MS", 0)
    events = []
    asyncio.run(agent_module.run_agent([{"role": "user", "content": "搜索 GitHub 代码 " + query}], events.append,
        vscode_client_mode=plugin, vscode_project_context=(object(), ProjectRef("ws", "vscode")) if plugin else None))
    assert operations == ["search_github_code"]
    assert model.calls == 2
    assert "[S1]" in "".join(event.get("content", "") for event in events if event["type"] == "token")


@pytest.mark.parametrize("plugin", [False, True])
def test_model_can_generate_document_from_default_project_tools_without_keyword_match(monkeypatch, plugin):
    from services.preview.workspace import PreviewProjectWorkspace
    class Model:
        def __init__(self):
            self.calls = 0
        async def ainvoke(self, messages, config=None):
            self.calls += 1
            if self.calls == 1:
                return AIMessage(content="", tool_calls=[{
                    "id": "doc", "name": "create_word", "args": {"title": "项目说明", "sections": []},
                }])
            return AIMessage(content="已把说明整理成文档，可从附件查看。")
    model, operations = Model(), []
    def bind(names):
        assert {"create_word", "create_excel", "create_ppt", "create_pdf", "web_search", "search_images"} <= set(names)
        return model
    async def execute(name, args, *extra):
        operations.append(name)
        return json.dumps({"success": True, "fileType": "word", "displayName": "项目说明.docx", "downloadUrl": "/api/download/test.docx"})
    monkeypatch.setattr(agent_module, "get_model_for_tools", bind)
    monkeypatch.setattr(agent_module, "execute_tool", execute)
    monkeypatch.setattr(agent_module, "TYPING_DELAY_MS", 0)
    events = []
    asyncio.run(agent_module.run_agent([{"role": "user", "content": "把我下面的说明整理成便于分享的报告"}], events.append,
        vscode_client_mode=plugin,
        vscode_project_context=(object(), ProjectRef("ws", "vscode")) if plugin else None,
        preview_workspace=None if plugin else PreviewProjectWorkspace("web", "react", {})))
    assert operations == ["create_word"]
    assert any(event["type"] == "file_ready" for event in events)
    assert not any(event["type"].startswith("preview_") for event in events)
