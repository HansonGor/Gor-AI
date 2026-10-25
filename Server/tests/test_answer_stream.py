"""边写边显示：逐句核验通过后再推送，已显示的内容不会再被删除或替换。"""
import asyncio
import json

import pytest
from langchain_core.messages import AIMessage, AIMessageChunk
from langchain_core.outputs import ChatGenerationChunk

import agent.agent as agent_module
from agent import answer_verifier
from agent.answer_stream import StreamingAnswerFilter
from tools.web_search import _SEARCH_RESULT_MARKER

IDS = {"S1", "S2"}
ANSWER = (
    "## 国内要闻\n9月CPI同比上涨0.9%。[S1] M2余额同比增长7.2%。[S2]\n另据统计进出口增长18.8%。\n\n"
    "## 空节\n没有来源的数字123。\n\n"
    "## 列表\n- 列表项事实5%。[S1]\n- 列表项无来源6%。\n\n"
    "| 指标 | 数值 |\n|---|---|\n| CPI | 0.9% [S1] |\n| PPI | -2.3% |\n\n"
    "以上要闻供参考。"
)


def run_filter(text, step):
    sent = []
    stream = StreamingAnswerFilter(IDS, sent.append)
    for i in range(0, len(text), step):
        stream.feed(text[i:i + step])
    return stream, sent, stream.finish(text)


@pytest.mark.parametrize("step", [1, 2, 5, 13, 1000])
def test_any_chunking_shows_the_same_cleaned_answer(step):
    stream, sent, shown = run_filter(ANSWER, step)
    assert "".join(sent).strip() == shown
    # 与整篇核验删除的句子一致，且被删内容从未发给前端
    assert stream.removed == answer_verifier.cleanup(ANSWER, IDS)[1] == 4
    for dropped in ("18.8%", "123", "6%", "PPI", "## 空节"):
        assert dropped not in "".join(sent)
    for kept in ("## 国内要闻", "0.9%。[S1]", "7.2%。[S2]", "## 列表", "- 列表项事实5%。[S1]", "| CPI | 0.9% [S1] |", "以上要闻供参考。"):
        assert kept in shown


def test_sentence_waits_for_its_trailing_citation_before_showing():
    sent = []
    stream = StreamingAnswerFilter(IDS, sent.append)
    stream.feed("## 要闻\n9月CPI同比上涨0.9%。[S")
    assert sent == []                                   # 编号还没写完，不能判定
    stream.feed("1] M2余额")
    assert "".join(sent).rstrip() == "## 要闻\n9月CPI同比上涨0.9%。[S1]"   # 下一句已开始，上一句完整
    stream.feed("同比增长7.2%。[S2]\n")
    assert "".join(sent).endswith("M2余额同比增长7.2%。[S2]\n")


def test_tool_call_preamble_is_never_shown():
    sent = []
    stream = StreamingAnswerFilter(IDS, sent.append)
    stream.on_llm_new_token("我再查一下最新情况。", chunk=ChatGenerationChunk(message=AIMessageChunk(content="我再查一下最新情况。")))
    stream.on_llm_new_token("", chunk=ChatGenerationChunk(message=AIMessageChunk(
        content="", tool_call_chunks=[{"name": "web_search", "args": "{}", "id": "x", "index": 0}])))
    assert sent == []
    assert stream.finish("我再查一下最新情况。") is None


def test_non_streaming_model_falls_back_to_whole_answer_verification():
    stream = StreamingAnswerFilter(IDS, lambda text: None)
    assert stream.finish("9月CPI同比上涨0.9%。[S1]") is None


# ---------------------------------------------------------------- 接入 Agent
PAYLOAD = {
    "intent": "news", "query": "国内新闻",
    "results": [
        {"sourceId": "S1", "title": "人民网要闻", "url": "https://example.com/1", "domain": "example.com",
         "snippet": "CPI", "provider": "tavily", "providers": ["tavily"], "publishedAt": "2026-10-18"},
        {"sourceId": "S2", "title": "央行发布", "url": "https://example.com/2", "domain": "example.com",
         "snippet": "M2", "provider": "tavily", "providers": ["tavily"], "publishedAt": "2026-10-18"},
    ],
    "providers_used": [["tavily", "preferred"]], "trace": [], "fallback_used": False,
}


def run_streaming_news(monkeypatch, answer):
    calls = []

    class Model:
        async def ainvoke(self, messages, config=None):
            calls.append(1)
            if len(calls) == 1:
                return AIMessage(content="", tool_calls=[{"id": "s", "name": "web_search", "args": {"query": "国内新闻"}}])
            # 像真实流式模型一样逐段触发回调
            for i in range(0, len(answer), 6):
                piece = answer[i:i + 6]
                for callback in (config or {}).get("callbacks", []):
                    handler = getattr(callback, "on_llm_new_token", None)
                    if handler:
                        handler(piece, chunk=ChatGenerationChunk(message=AIMessageChunk(content=piece)))
            return AIMessage(content=answer)

    async def execute(name, args, *extra):
        if name == "web_search":
            return _SEARCH_RESULT_MARKER + json.dumps({"text": "[S1] 人民网要闻\n[S2] 央行发布", "payload": PAYLOAD})
        return json.dumps({"success": True, "requested_pages": 2, "failures": [], "pages": [
            {"url": "https://example.com/1", "title": "人民网要闻", "body": "9月CPI同比上涨0.9%。" * 20},
            {"url": "https://example.com/2", "title": "央行发布", "body": "M2余额同比增长7.2%。" * 20},
        ]}, ensure_ascii=False)

    monkeypatch.setattr(agent_module, "get_model_for_tools", lambda names, **kwargs: Model())
    monkeypatch.setattr(agent_module, "execute_tool", execute)
    monkeypatch.setattr(agent_module, "MAX_ITERATIONS", 6)
    events = []
    asyncio.run(agent_module.run_agent([{"role": "user", "content": "最近一周国内有什么重要新闻"}], events.append))
    tokens = [e["content"] for e in events if e.get("type") == "token"]
    verification = [e for e in events if e.get("type") == "answer_verification"]
    return calls, tokens, verification


def test_agent_streams_verified_sentences_and_never_rewrites(monkeypatch):
    # 覆盖率只有 1/3（以前会整篇重写）：流式模式下逐句过滤，不重写、不替换已显示内容
    answer = "## 国内要闻\n9月CPI同比上涨0.9%。M2余额同比增长7.2%。[S2]\n另据统计进出口增长18.8%。"
    calls, tokens, verification = run_streaming_news(monkeypatch, answer)
    assert len(calls) == 2                                   # 搜索 → 程序读网页 → 写回答，没有重写
    assert len(tokens) >= 2                                  # 分多次推送，而不是写完再一次性输出
    shown = "".join(tokens)
    assert shown.strip() == "## 国内要闻\nM2余额同比增长7.2%。[S2]"
    assert "0.9%" not in shown and "18.8%" not in shown
    assert verification == [{"type": "answer_verification", "revised": False, "removedSentences": 2,
                             "factSentences": 3, "citedFactSentences": 1, "uncited": 2,
                             "invalidCitations": 0, "coverage": 0.3333}]


def test_agent_streaming_all_sentences_removed_shows_short_notice(monkeypatch):
    calls, tokens, _ = run_streaming_news(monkeypatch, "据统计进出口增长18.8%。")
    assert "".join(tokens) == "本轮检索到的来源不足以支持可靠的回答，请换个问法或稍后重试。"
