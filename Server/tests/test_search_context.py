import asyncio
import json

import pytest
from langchain_core.messages import AIMessage, ToolMessage

import agent.agent as agent_module
from agent.search_context import SearchContext, compact_reader
from project_api.types import ProjectRef
from tools.web_search import _SEARCH_RESULT_MARKER


def envelope(text="[S1] 官方资料\n   正文证据\n   来源：https://example.com/a", **updates):
    payload = {"results": [{"url": "https://example.com/a", "title": "官方资料", "sourceId": "S1"}], "trace": []}
    payload.update(updates)
    return _SEARCH_RESULT_MARKER + json.dumps({"text": text, "payload": payload}, ensure_ascii=False)


def test_exact_query_conditions_and_run_isolation():
    context = SearchContext()
    args = {"query": "site:example.com 官方资料", "user_language": "zh", "original_query": "用户原文"}
    key = context.key("web_search", args)
    context.remember(key, envelope())
    assert context.get(context.key("web_search", dict(reversed(list(args.items()))))) == envelope()
    for field, value in (("query", "site:other.com 官方资料"), ("user_language", "en"), ("original_query", "不同问题")):
        assert context.get(context.key("web_search", {**args, field: value})) is None
    assert context.get(context.key("search_github_code", args)) is None
    assert SearchContext().get(key) is None


@pytest.mark.parametrize("result", ["网络错误", envelope(results=[]), envelope(success=False),
                                  envelope(trace=[{"status": "error"}]), envelope(github_code_search_status="error")])
def test_empty_failed_and_partial_searches_are_not_cached(result):
    context = SearchContext()
    key = context.key("web_search", {"query": "retry"})
    context.remember(key, result)
    assert context.get(key) is None


def test_only_identical_evidence_is_referenced_new_facts_are_preserved():
    context = SearchContext()
    first = "【搜索源】官方\n[S1] 公告\n价格100元，日期2026-10-14\n来源：https://example.com/a\n"
    assert context.compact_search(first) == first
    duplicate = context.compact_search(first)
    assert "参阅前文" in duplicate and "【搜索源】官方" in duplicate
    updated = first.replace("价格100元", "价格120元，学生半价")
    assert context.compact_search(updated) == updated
    assert context.compact_search(first.replace("2026-10-14", "2026-10-15")) != duplicate


def test_reader_keeps_complete_evidence_metadata_and_original_payload():
    payload = {"success": True, "pages": [{"url": "https://example.com/a", "published_at": "2026-10-14",
               "author": "官方", "sourceId": "S1", "body": "事实A\n\n事实A\n\n事实B",
               "key_paragraphs": ["事实A", "事实B", "正文限长之外的关键事实C"]}], "failures": []}
    raw = json.dumps(payload, ensure_ascii=False)
    result = json.loads(compact_reader(raw))
    assert payload["pages"][0]["body"] == "事实A\n\n事实A\n\n事实B"
    assert result["pages"][0]["body"] == "事实A\n\n事实B"
    assert result["pages"][0]["key_paragraphs"] == ["正文限长之外的关键事实C"]
    for field in ("url", "published_at", "author", "sourceId"):
        assert result["pages"][0][field] == payload["pages"][0][field]
    assert compact_reader("网络错误") == "网络错误"


def test_a_failed_attempt_can_be_retried_and_then_cached():
    context = SearchContext()
    key = context.key("web_search", {"query": "官方资料"})
    context.remember(key, envelope(trace=[{"status": "error"}]))
    assert context.get(key) is None
    context.remember(key, envelope(trace=[{"status": "success"}]))
    assert context.get(key) == envelope(trace=[{"status": "success"}])


@pytest.mark.parametrize("plugin", [False, True])
def test_agent_reuses_search_keeps_sources_and_finishes_generation(monkeypatch, plugin):
    operations, model_inputs, events = [], [], []
    class Model:
        async def ainvoke(self, messages, config=None):
            model_inputs.append(list(messages))
            step = len(model_inputs)
            if step == 1:
                return AIMessage(content="", tool_calls=[{"name": "web_search", "args": {"query": "杭州景点"}, "id": f"q{i}"} for i in (1, 2)])
            if step == 2:
                return AIMessage(content="", tool_calls=[{"name": "web_search", "args": {"query": "杭州景点补充"}, "id": "q3"}])
            if step == 3:
                return AIMessage(content="", tool_calls=[{"name": "create_word", "args": {"title": "行程", "sections": []}, "id": "doc"}])
            return AIMessage(content="文档已生成，包含补充资料[S1]。")
    async def execute(name, args, *rest):
        operations.append(name)
        if name == "web_search":
            text = "[S1] 官方资料\n   正文证据" + ("与新增重要事实" if "补充" in args["query"] else "") + "\n   来源：https://example.com/a"
            return envelope(text, results=[{"sourceId": "S1", "url": "https://example.com/a", "title": "官方资料",
                                          "snippet": "新增重要事实" if "补充" in args["query"] else "正文证据"}])
        return json.dumps({"success": True, "fileType": "word", "displayName": "行程.docx", "downloadUrl": "/api/download/test.docx"})
    monkeypatch.setattr(agent_module, "get_model_for_tools", lambda names: Model())
    monkeypatch.setattr(agent_module, "execute_tool", execute)
    monkeypatch.setattr(agent_module, "TYPING_DELAY_MS", 0)
    request = [{"role": "user", "content": "请搜索杭州景点资料，再生成Word文件"}]
    def run():
        asyncio.run(agent_module.run_agent(request, events.append, vscode_client_mode=plugin,
                    vscode_project_context=(object(), ProjectRef("ws", "vscode")) if plugin else None))
    run()
    assert operations == ["web_search", "web_search", "create_word"]
    sources = [event for event in events if event["type"] == "search_sources"]
    assert len(sources) == 3 and sources[0]["sources"] == sources[1]["sources"]
    assert sources[1]["searchTrace"]["cacheHit"] is True
    assert sources[1]["searchTrace"]["trace"] == []
    assert sources[2]["sources"][0]["sourceId"] == sources[0]["sources"][0]["sourceId"]
    assert sources[2]["sources"][0]["snippet"] == "新增重要事实"
    tools = [m for m in model_inputs[-1] if isinstance(m, ToolMessage)]
    assert "正文证据" in tools[0].content
    assert "参阅前文" in tools[1].content
    assert "新增重要事实" in tools[2].content
    assert any(event["type"] == "file_ready" for event in events)
    # Another user turn, even in the same chat, must search again.
    model_inputs.clear()
    run()
    assert operations.count("web_search") == 4


def test_cancellation_does_not_replay_cached_sources(monkeypatch):
    signal = asyncio.Event()
    events, network_calls = [], []
    class Model:
        async def ainvoke(self, messages, config=None):
            return AIMessage(content="", tool_calls=[{"name": "web_search", "args": {"query": "公开资料"}, "id": str(i)} for i in (1, 2)])
    async def execute(name, args, *rest):
        if signal.is_set():
            return json.dumps({"success": False, "code": "OPERATION_CANCELLED"})
        network_calls.append(name)
        return envelope()
    def send(event):
        events.append(event)
        if event["type"] == "tool_end":
            signal.set()
    monkeypatch.setattr(agent_module, "get_model_for_tools", lambda names: Model())
    monkeypatch.setattr(agent_module, "execute_tool", execute)
    asyncio.run(agent_module.run_agent([{"role": "user", "content": "搜索公开资料"}], send, signal=signal))
    assert network_calls == ["web_search"]
    assert len([e for e in events if e["type"] == "search_sources"]) == 1
    assert any("OPERATION_CANCELLED" in e.get("result", "") for e in events)
