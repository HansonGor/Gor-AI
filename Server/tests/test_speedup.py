"""回答提速：最终回答不再逐段等待、同轮多个搜索并行执行并命中缓存。"""
import asyncio
import json
import time

import agent.agent as agent_module
from langchain_core.messages import AIMessage

from tools.web_search import _SEARCH_RESULT_MARKER


def _payload(name):
    return {
        "intent": "news", "query": name,
        "results": [{"sourceId": "S1", "title": name, "url": f"https://example.com/{name}", "domain": "example.com",
                     "snippet": name, "provider": "tavily", "providers": ["tavily"], "publishedAt": "2026-10-18"}],
        "providers_used": [["tavily", "preferred"]], "trace": [], "fallback_used": False,
    }


def test_final_answer_is_sent_without_per_chunk_delay(monkeypatch):
    events = []
    text = "广州新闻摘要。[S1]" * 200          # 约 1600 字
    started = time.perf_counter()
    asyncio.run(agent_module.stream_content(text, events.append))
    elapsed = time.perf_counter() - started
    chunks = [e["content"] for e in events if e.get("type") == "token"]
    assert "".join(chunks) == text
    assert len(chunks) == -(-len(text) // agent_module.TYPING_CHUNK_SIZE)
    assert agent_module.TYPING_DELAY_MS == 0
    assert elapsed < 0.2                     # 旧实现每段 20ms，约 16 秒


def test_two_searches_in_one_round_run_concurrently_and_are_reused(monkeypatch):
    calls = []
    in_flight = {"now": 0, "peak": 0}

    class Model:
        def __init__(self, step):
            self.step = step

        async def ainvoke(self, messages, config=None):
            if self.step == 1:
                return AIMessage(content="", tool_calls=[
                    {"id": "a", "name": "web_search", "args": {"query": "国内新闻 A"}},
                    {"id": "b", "name": "web_search", "args": {"query": "国内新闻 B"}},
                ])
            return AIMessage(content="## 国内要闻\n今天有两条要闻。[S1]")

    model_calls = {"n": 0}

    def factory(names, **kwargs):
        model_calls["n"] += 1
        return Model(model_calls["n"])

    readers = []

    async def execute(name, args, *extra):
        if name == "web_reader":
            readers.append(args["urls"])
            return json.dumps({"success": True, "requested_pages": len(args["urls"]), "failures": [], "pages": [
                {"url": url, "title": "要闻", "body": "今天有两条要闻。" * 20} for url in args["urls"]]}, ensure_ascii=False)
        calls.append(args["query"])
        in_flight["now"] += 1
        in_flight["peak"] = max(in_flight["peak"], in_flight["now"])
        await asyncio.sleep(0.2)
        in_flight["now"] -= 1
        return _SEARCH_RESULT_MARKER + json.dumps({"text": "[S1] 要闻", "payload": _payload(args["query"])}, ensure_ascii=False)

    monkeypatch.setattr(agent_module, "get_model_for_tools", factory)
    monkeypatch.setattr(agent_module, "execute_tool", execute)
    events = []
    asyncio.run(agent_module.run_agent([{"role": "user", "content": "最近一周国内有什么重要新闻"}], events.append))

    # 两次搜索同时在途，且每个查询只真正执行一次（循环命中预取缓存）
    assert in_flight["peak"] == 2
    assert sorted(calls) == ["国内新闻 A", "国内新闻 B"]
    # 新闻搜索这一轮结束后，程序按排名轮流取两个查询的结果直接读，不再让模型挑网址
    assert readers == [["https://example.com/国内新闻 A", "https://example.com/国内新闻 B"]]
    assert model_calls["n"] == 2
    assert [e["type"] for e in events if e.get("type") == "search_sources"]
    # 2026-10-19 用户要求：并行检索期间不再发"正在并行检索 N 个查询…"进度文字
    assert not [e for e in events if "并行检索" in str(e.get("status", ""))]


# ---------------------------------------------------------------- 第 4～6 点
def test_news_prompt_limits_search_rounds_pages_and_requires_per_sentence_citations():
    from agent.tool_routing import route_request
    prompt = route_request("整理今日热点新闻").system_prompt
    assert "检索只做一轮" in prompt and "才补搜一次" in prompt
    assert "3–5 篇（最多 5 篇）" in prompt and "综合咨询优先读取 5–8 篇" not in prompt
    assert "在该句末尾标注 [S#]（不能只在段尾统一标注一次）" in prompt


def _run_news_answer(monkeypatch, answers):
    payload = {
        "intent": "news", "query": "国内新闻",
        "results": [
            {"sourceId": "S1", "title": "人民网要闻", "url": "https://example.com/1", "domain": "example.com",
             "snippet": "CPI", "provider": "tavily", "providers": ["tavily"], "publishedAt": "2026-10-18"},
            {"sourceId": "S2", "title": "央行发布", "url": "https://example.com/2", "domain": "example.com",
             "snippet": "M2", "provider": "tavily", "providers": ["tavily"], "publishedAt": "2026-10-18"},
        ],
        "providers_used": [["tavily", "preferred"]], "trace": [], "fallback_used": False,
    }
    calls = []

    class Model:
        async def ainvoke(self, messages, config=None):
            calls.append(1)
            if len(calls) == 1:
                return AIMessage(content="", tool_calls=[{"id": "s", "name": "web_search", "args": {"query": "国内新闻"}}])
            if len(calls) == 2:
                return AIMessage(content="", tool_calls=[{"id": "r", "name": "web_reader", "args": {
                    "urls": ["https://example.com/1", "https://example.com/2"], "query": "国内新闻"}}])
            return AIMessage(content=answers[min(len(calls) - 3, len(answers) - 1)])

    async def execute(name, args, *extra):
        if name == "web_search":
            return _SEARCH_RESULT_MARKER + json.dumps({"text": "[S1] 人民网要闻\n[S2] 央行发布", "payload": payload})
        return json.dumps({"success": True, "requested_pages": 2, "failures": [], "pages": [
            {"url": "https://example.com/1", "title": "人民网要闻", "body": "9月CPI同比上涨0.9%。" * 20},
            {"url": "https://example.com/2", "title": "央行发布", "body": "M2余额同比增长7.2%。" * 20},
        ]}, ensure_ascii=False)

    monkeypatch.setattr(agent_module, "get_model_for_tools", lambda names, **kwargs: Model())
    monkeypatch.setattr(agent_module, "execute_tool", execute)
    monkeypatch.setattr(agent_module, "MAX_ITERATIONS", 6)
    events = []
    asyncio.run(agent_module.run_agent([{"role": "user", "content": "最近一周国内有什么重要新闻"}], events.append))
    visible = "".join(e.get("content", "") for e in events if e.get("type") == "token")
    verification = [e for e in events if e.get("type") == "answer_verification"]
    return calls, visible, verification


def test_mostly_cited_draft_is_cleaned_without_a_rewrite(monkeypatch):
    # 5 个事实句里 4 句有来源（覆盖率 80% ≥ 60%）：删掉 1 句，不再调用模型重写
    draft = ("## 国内要闻\n9月CPI同比上涨0.9%。[S1]\nM2余额同比增长7.2%。[S2]\n"
             "社融规模增长8.1%。[S2]\n居民存款增加3.4万亿元。[S1]\n另据统计进出口增长18.8%。")
    calls, visible, verification = _run_news_answer(monkeypatch, [draft, "不应被调用"])
    assert len(calls) == 3
    assert "18.8%" not in visible and "0.9%" in visible and "不应被调用" not in visible
    assert verification[0]["revised"] is False and verification[0]["removedSentences"] == 1


def test_mostly_uncited_draft_still_gets_one_rewrite(monkeypatch):
    # 覆盖率 1/3 < 60%：仍整篇重写一次，避免删到只剩零星几句
    draft = "## 国内要闻\n9月CPI同比上涨0.9%。M2余额同比增长7.2%。[S2]\n另据统计进出口增长18.8%。"
    revised = "## 国内要闻\n9月CPI同比上涨0.9%。[S1]\nM2余额同比增长7.2%。[S2]"
    calls, visible, verification = _run_news_answer(monkeypatch, [draft, revised])
    assert len(calls) == 4
    assert visible == revised and verification[0]["revised"] is True


# ---------------------------------------------------------------- 搜索并行批次、强制先搜索、首句时刻
def test_supporting_batch_starts_together_with_the_first_batch(monkeypatch):
    import threading
    from unittest.mock import patch
    from tools.search_orchestrator import SearchOrchestrator
    starts, lock = {}, threading.Lock()

    def provider(name, query, max_results, sites=None, **_kwargs):
        with lock:
            starts.setdefault(tuple(sites or ()), time.perf_counter())
        time.sleep(0.3)
        return ([{"title": name, "url": f"https://{name}.example/{len(sites or ())}", "content": name, "source": name}], None)

    with (patch("tools.search_orchestrator._provider_configured", return_value=True),
          patch("tools.search_orchestrator._call_provider", side_effect=provider)):
        started = time.perf_counter()
        SearchOrchestrator().run("广州新闻", original_query="广州新闻")
        elapsed = time.perf_counter() - started
    batches = sorted(starts.values())
    assert len(batches) >= 2
    assert batches[1] - batches[0] < 0.15          # 官方域名批与补充媒体批同时发出，而不是一前一后
    assert elapsed < 0.3 * len(batches)            # 总耗时少于各批相加


def test_first_required_search_call_must_use_a_tool_and_later_calls_are_free(monkeypatch):
    bound, calls = [], []

    class Model:
        def __init__(self, choice=None):
            self.choice = choice

        def bind(self, **kwargs):
            bound.append(kwargs)
            return Model(kwargs.get("tool_choice"))

        async def ainvoke(self, messages, config=None):
            calls.append(self.choice)
            if len(calls) == 1:
                return AIMessage(content="", tool_calls=[{"id": "s", "name": "web_search", "args": {"query": "国内新闻"}}])
            return AIMessage(content="暂无更多。")

    async def execute(name, args, *extra):
        if name == "web_search":
            return _SEARCH_RESULT_MARKER + json.dumps({"text": "[S1] 要闻", "payload": _payload("国内新闻")}, ensure_ascii=False)
        return json.dumps({"success": True, "requested_pages": 1, "failures": [], "pages": [
            {"url": args["urls"][0], "title": "要闻", "body": "今天有一条要闻。" * 20}]}, ensure_ascii=False)

    monkeypatch.setattr(agent_module, "get_model_for_tools", lambda names, **kwargs: Model())
    monkeypatch.setattr(agent_module, "execute_tool", execute)
    events = []
    asyncio.run(agent_module.run_agent([
        {"role": "user", "content": "广州新闻"}, {"role": "assistant", "content": "## 1. 上一轮的回答"},
        {"role": "user", "content": "广州新闻"},
    ], events.append))
    assert calls[0] == "required"                  # 还没搜索过：这次必须调用工具
    assert all(choice is None for choice in calls[1:])
    assert bound == [{"tool_choice": "required"}]


def test_streaming_filter_records_when_the_first_text_was_pushed():
    from agent.answer_stream import StreamingAnswerFilter
    stream = StreamingAnswerFilter({"S1"}, lambda text: None)
    stream.feed("## 要闻\n9月CPI")
    assert stream.first_sent_at is None            # 还没有能推送的完整句子
    stream.feed("同比上涨0.9%。[S1] 下一句")
    assert stream.first_sent_at is not None
