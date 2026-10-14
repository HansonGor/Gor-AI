import asyncio
import json

import pytest
from langchain_core.messages import AIMessage, ToolMessage

import agent.agent as agent_module
from agent.search_context import ReaderContext
from project_api.types import ProjectRef
from tools.web_search import _SEARCH_RESULT_MARKER


def page(url, fingerprint="v1"):
    return {"url": url, "body": "完整正文。" * 30, "body_fingerprint": fingerprint,
            "published_at": "2026-10-14", "author": "官方", "title": "新闻标题"}


def test_reader_reuses_pages_across_batches_and_preserves_order_and_conditions():
    async def run():
        context, calls = ReaderContext(), []
        async def fetch(args):
            calls.append(args)
            return json.dumps({"success": True, "pages": [page(url) for url in args["urls"]], "failures": []})
        args = {"urls": ["https://example.com/a", "https://example.com/b"], "query": "发布", "max_pages": 5}
        first = json.loads(await context.invoke(args, fetch, lambda: True))
        second = json.loads(await context.invoke({**args, "urls": list(reversed(args["urls"]))}, fetch, lambda: True))
        assert len(calls) == 1
        assert [p["url"] for p in second["pages"]] == list(reversed(args["urls"]))
        assert all(p["cache_hit"] for p in second["pages"])
        assert first["pages"][0]["body"] == second["pages"][1]["body"]
        for updates in ({"query": "另一重点"}, {"start_char": 8000}, {"max_pages": 1}):
            await context.invoke({**args, **updates}, fetch, lambda: True)
        assert len(calls) == 4
        await ReaderContext().invoke(args, fetch, lambda: True)
        assert len(calls) == 5  # another Agent Run must download again
        await context.invoke(args, fetch, lambda: False)
        assert len(calls) == 6  # no permission/cancel bypass
    asyncio.run(run())


def test_failed_page_retries_without_redownloading_successful_independent_source():
    async def run():
        context, calls = ReaderContext(), []
        urls = ["https://example.com/a", "https://other.com/b"]
        async def fetch(args):
            calls.append(args["urls"])
            if len(calls) == 1:
                return json.dumps({"pages": [page(urls[0])], "failures": [{"url": urls[1], "error": "timeout"}]})
            return json.dumps({"pages": [page(urls[1])], "failures": []})
        first = json.loads(await context.invoke({"urls": urls}, fetch, lambda: True))
        second = json.loads(await context.invoke({"urls": urls}, fetch, lambda: True))
        assert first["failures"]
        assert calls == [urls, [urls[1]]]
        assert len(second["pages"]) == 2 and not second["failures"]
    asyncio.run(run())


def test_changed_article_snapshot_marks_continuation_and_invalidates_old_pages():
    async def run():
        context, calls = ReaderContext(), []
        url = "https://example.com/a"
        async def fetch(args):
            calls.append(args)
            return json.dumps({"pages": [page(url, "v1" if len(calls) == 1 else "v2")], "failures": []})
        await context.invoke({"urls": [url]}, fetch, lambda: True)
        changed = json.loads(await context.invoke({"urls": [url], "start_char": 8000}, fetch, lambda: True))
        assert changed["pages"][0]["snapshot_changed"]
        assert "不能" in changed["pages"][0]["reading_note"]
        await context.invoke({"urls": [url]}, fetch, lambda: True)
        assert len(calls) == 3
    asyncio.run(run())


def test_default_eight_page_cache_limit_and_explicit_smaller_read():
    async def run():
        context, calls = ReaderContext(), []
        urls = [f"https://example.com/{i}" for i in range(10)]
        async def fetch(args):
            calls.append(args["urls"])
            return json.dumps({"pages": [page(url) for url in args["urls"]], "failures": []})
        result = json.loads(await context.invoke({"urls": urls}, fetch, lambda: True))
        assert len(result["pages"]) == 8 and result["max_pages"] == 8
        cached = json.loads(await context.invoke({"urls": urls}, fetch, lambda: True))
        assert len(calls) == 1 and all(p["cache_hit"] for p in cached["pages"])
        small = json.loads(await context.invoke({"urls": urls, "max_pages": 3}, fetch, lambda: True))
        assert len(small["pages"]) == 3
    asyncio.run(run())


@pytest.mark.parametrize("plugin", [False, True])
def test_agent_reads_all_eight_authorized_sources_without_losing_citations(monkeypatch, plugin):
    urls = [f"https://example.com/news/{i}" for i in range(8)]
    calls, read_urls, events = [], [], []
    class Model:
        async def ainvoke(self, messages, config=None):
            calls.append(list(messages))
            if len(calls) == 1:
                return AIMessage(content="", tool_calls=[{"id": "search", "name": "web_search", "args": {"query": "今日热点"}}])
            if len(calls) == 2:
                return AIMessage(content="", tool_calls=[{"id": "reader", "name": "web_reader", "args": {"urls": urls + ["https://unknown.com/other"]}}])
            return AIMessage(content="八条不同事件的资讯：" + " ".join(f"[S{i}]" for i in range(1, 9)))
    async def execute(name, args, *rest):
        if name == "web_search":
            return _SEARCH_RESULT_MARKER + json.dumps({"text": "\n".join(f"[S{i+1}] 新闻{i}" for i in range(8)),
                   "payload": {"results": [{"url": url, "sourceId": f"S{i+1}"} for i, url in enumerate(urls)]}})
        read_urls.extend(args["urls"])
        return json.dumps({"success": True, "pages": [page(url) for url in args["urls"]], "failures": []})
    monkeypatch.setattr(agent_module, "get_model_for_tools", lambda names: Model())
    monkeypatch.setattr(agent_module, "execute_tool", execute)
    monkeypatch.setattr(agent_module, "TYPING_DELAY_MS", 0)
    asyncio.run(agent_module.run_agent([{"role": "user", "content": "整理今日热点新闻"}], events.append,
                vscode_client_mode=plugin, vscode_project_context=(object(), ProjectRef("ws", "vscode")) if plugin else None))
    assert read_urls == urls
    result = next(m for m in calls[-1] if isinstance(m, ToolMessage) and m.tool_call_id == "reader")
    assert [p["sourceId"] for p in json.loads(result.content)["pages"]] == [f"S{i}" for i in range(1, 9)]


@pytest.mark.parametrize("plugin", [False, True])
def test_agent_reader_reuse_keeps_source_ids_and_complete_final_answer(monkeypatch, plugin):
    calls, operations, events = [], [], []
    url = "https://example.com/release"
    class Model:
        async def ainvoke(self, messages, config=None):
            calls.append(list(messages))
            if len(calls) == 1:
                return AIMessage(content="", tool_calls=[{"id": "search", "name": "web_search", "args": {"query": "官方最新发布"}}])
            if len(calls) in (2, 3):
                return AIMessage(content="", tool_calls=[{"id": str(len(calls)), "name": "web_reader", "args": {"urls": [url], "query": "发布"}}])
            return AIMessage(content="官方发布事实已核实[S1]。")
    async def execute(name, args, *rest):
        operations.append(name)
        if name == "web_search":
            return _SEARCH_RESULT_MARKER + json.dumps({"text": "[S1] 官方公告", "payload": {"results": [{"url": url, "sourceId": "S1"}]}})
        return json.dumps({"success": True, "pages": [page(url)], "failures": [], "requested_pages": 1})
    monkeypatch.setattr(agent_module, "get_model_for_tools", lambda names: Model())
    monkeypatch.setattr(agent_module, "execute_tool", execute)
    monkeypatch.setattr(agent_module, "TYPING_DELAY_MS", 0)
    asyncio.run(agent_module.run_agent([{"role": "user", "content": "查询最新新闻发布"}], events.append,
                vscode_client_mode=plugin, vscode_project_context=(object(), ProjectRef("ws", "vscode")) if plugin else None))
    assert operations == ["web_search", "web_reader"]
    readers = [m for m in calls[-1] if isinstance(m, ToolMessage) and m.tool_call_id in ("2", "3")]
    assert all(json.loads(m.content)["pages"][0]["sourceId"] == "S1" for m in readers)
    assert json.loads(readers[-1].content)["pages"][0]["cache_hit"]
    assert "事实已核实[S1]" in "".join(event.get("content", "") for event in events if event["type"] == "token")
