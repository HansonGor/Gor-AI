"""阶段一：联网回答逐句引用核验、修订一轮、删除无依据事实句。"""

import asyncio
import json

import pytest
from langchain_core.messages import AIMessage, SystemMessage

import agent.agent as agent_module
from agent.answer_verifier import cleanup, is_fact_sentence, verify
from agent.evidence import EvidenceLedger
from project_api.types import ProjectRef
from tools.web_search import _SEARCH_RESULT_MARKER

IDS = {"S1", "S2"}


# ---------------------------------------------------------------- 纯函数

def test_fact_sentence_detection():
    assert is_fact_sentence("国家统计局称9月CPI同比上涨0.9%。")
    assert is_fact_sentence("美联储表示将维持利率不变。")
    assert is_fact_sentence("Python 3.15 已发布。")
    assert not is_fact_sentence("这对理解经济走势很重要。")
    assert not is_fact_sentence("经检索，暂未查到 2026 年相关报道。")
    assert not is_fact_sentence("需要我继续查 2027 年的数据吗？")
    assert not is_fact_sentence("希望以上 3 条信息对你有帮助。")


def test_sentence_level_citation_is_required():
    answer = "9月CPI同比上涨0.9%。前三季度进出口增长18.8%。[S1]\n\n这对判断景气很关键。"
    report = verify(answer, IDS)
    assert report.fact_sentences == 2 and report.cited_fact_sentences == 1
    assert report.uncited == ["9月CPI同比上涨0.9%。"]
    assert not report.ok


def test_source_note_and_trailing_citation_belong_to_previous_sentence():
    answer = "央行9月末M2余额同比增长7.2%。（来源：[中国人民银行](https://www.pbc.gov.cn/a.html)，2026-10-14）[S2]"
    report = verify(answer, IDS)
    assert report.ok and report.fact_sentences == 1


def test_citation_after_period_belongs_to_previous_sentence():
    report = verify("9月CPI同比上涨0.9%。[S1] M2余额同比增长7.2%。[S2]", IDS)
    assert report.ok and report.fact_sentences == 2
    report = verify("9月CPI同比上涨0.9%。[S1] M2余额同比增长7.2%。", IDS)
    assert report.uncited == ["M2余额同比增长7.2%。"]


def test_invalid_citation_is_reported_and_removed():
    report = verify("新鸭绿江大桥10月15日开通。[S9]", IDS)
    assert report.invalid == [("新鸭绿江大桥10月15日开通。[S9]", ["S9"])]
    text, removed = cleanup("新鸭绿江大桥10月15日开通。[S1][S9]", IDS)
    assert text == "新鸭绿江大桥10月15日开通。[S1]" and removed == 0


def test_headings_code_tables_and_reference_lines():
    answer = "\n".join([
        "## 1. 9月CPI同比上涨0.9%",
        "```python",
        "print(2026)",
        "```",
        "| 指标 | 数值 |",
        "|---|---|",
        "| CPI | 0.9% [S1] |",
        "| PPI | -2.3% |",
        "- [S1] 人民网 https://example.com/1",
    ])
    report = verify(answer, IDS)
    assert report.fact_sentences == 2 and report.uncited == ["| PPI | -2.3% |"]
    text, removed = cleanup(answer, IDS)
    assert removed == 1
    assert "PPI" not in text and "| CPI | 0.9% [S1] |" in text
    assert "## 1. 9月CPI同比上涨0.9%" in text and "print(2026)" in text


def test_cleanup_drops_emptied_list_items_tables_and_headings():
    answer = "\n".join([
        "## 一、国内",
        "- 9月CPI上涨0.9%。",
        "- 进出口增长18.8%。[S1]",
        "",
        "## 二、国际",
        "联合国称冲突已达60多场。",
        "",
        "| 项目 | 数值 |",
        "|---|---|",
        "| 金价 | 2400 美元 |",
        "",
        "## 三、结语",
        "以上内容供参考。",
    ])
    text, removed = cleanup(answer, IDS)
    assert removed == 3
    # 二、国际 下的段落和表格都被删除后，标题一并删除；结语不是事实句，保留
    assert text == "## 一、国内\n- 进出口增长18.8%。[S1]\n\n## 三、结语\n以上内容供参考。"
    assert verify(text, IDS).ok


def test_cleanup_does_not_leave_orphan_markdown_markers():
    # 评测中出现过：加粗句被删除后只剩下行首的 "**"
    answer = "**结论：欧盟于10月10日宣布解散。**\n\n欧洲议会选举于2024年6月9日结束。[S1]"
    text, removed = cleanup(answer, IDS)
    assert removed == 1
    assert text == "欧洲议会选举于2024年6月9日结束。[S1]"


def test_ledger_registers_only_numbered_sources_and_linked_pages():
    ledger = EvidenceLedger()
    ledger.add_source({"sourceId": "S1", "url": "https://a", "snippet": "abc", "publishedDate": "2026-10-14"})
    ledger.add_source({"url": "https://no-id"})
    ledger.add_page({"sourceId": "S1", "body": "正文", "key_paragraphs": ["段落"], "published_at": "2026-10-14"})
    ledger.add_page({"sourceId": "S7", "body": "未登记来源的页面"})
    assert ledger.source_ids == {"S1"}
    assert ledger.get("S1").page_text == ["正文\n段落"]


# ---------------------------------------------------------------- Agent 集成

PAYLOAD = {"query": "最近国内新闻", "results": [
    {"title": "人民网要闻", "url": "https://example.com/1", "source_id": "S1", "snippet": "9月CPI同比上涨0.9%"},
    {"title": "央行发布", "url": "https://example.com/2", "source_id": "S2", "snippet": "M2余额同比增长7.2%"},
]}
FIRST = "## 国内要闻\n9月CPI同比上涨0.9%。M2余额同比增长7.2%。[S2]\n另据统计进出口增长18.8%。"


def run(monkeypatch, answers, *, plugin=False, extra_tool=None):
    calls = []

    class Model:
        async def ainvoke(self, messages, config=None):
            calls.append(list(messages))
            step = len(calls)
            if step == 1:
                tool_calls = [{"id": "search", "name": "web_search", "args": {"query": PAYLOAD["query"]}}]
                if extra_tool:
                    tool_calls.append({"id": "extra", "name": extra_tool, "args": {"city": "北京"}})
                return AIMessage(content="", tool_calls=tool_calls)
            if step == 2:  # 新闻类回答按现有规则先读正文
                return AIMessage(content="", tool_calls=[{"id": "read", "name": "web_reader", "args": {
                    "urls": ["https://example.com/1", "https://example.com/2"], "query": "国内新闻"}}])
            return AIMessage(content=answers[min(step - 3, len(answers) - 1)])

    async def execute(name, args, *extra):
        if name == "web_search":
            return _SEARCH_RESULT_MARKER + json.dumps({"text": "[S1] 人民网要闻\n[S2] 央行发布", "payload": PAYLOAD})
        if name == "web_reader":
            return json.dumps({"success": True, "requested_pages": 2, "failures": [], "pages": [
                {"url": "https://example.com/1", "title": "人民网要闻", "body": "9月CPI同比上涨0.9%。" * 20},
                {"url": "https://example.com/2", "title": "央行发布", "body": "M2余额同比增长7.2%。" * 20},
            ]}, ensure_ascii=False)
        return "北京 晴 20℃"

    monkeypatch.setattr(agent_module, "get_model_for_tools", lambda names: Model())
    monkeypatch.setattr(agent_module, "execute_tool", execute)
    monkeypatch.setattr(agent_module, "TYPING_DELAY_MS", 0)
    monkeypatch.setattr(agent_module, "MAX_ITERATIONS", 6)
    events = []
    asyncio.run(agent_module.run_agent([{"role": "user", "content": "最近一周国内有什么重要新闻"}], events.append,
                                       vscode_client_mode=plugin,
                                       vscode_project_context=(object(), ProjectRef("ws", "vscode")) if plugin else None))
    visible = "".join(e.get("content", "") for e in events if e.get("type") == "token")
    verification = [e for e in events if e.get("type") == "answer_verification"]
    return calls, visible, verification, events


@pytest.mark.parametrize("plugin", [False, True])
def test_one_revision_round_then_sends_revised_answer(monkeypatch, plugin):
    revised = "## 国内要闻\n9月CPI同比上涨0.9%。[S1]\nM2余额同比增长7.2%。[S2]"
    calls, visible, verification, events = run(monkeypatch, [FIRST, revised], plugin=plugin)
    assert len(calls) == 4
    prompt = "\n".join(str(m.content) for m in calls[3] if isinstance(m, SystemMessage))
    assert "发送前引用核验未通过" in prompt
    assert "缺少引用：9月CPI同比上涨0.9%。" in prompt and "另据统计进出口增长18.8%。" in prompt
    assert "S1、S2" in prompt
    # 评测中曾出现模型把"按引用核验要求，修订版如下"写进回答
    assert "不要提及核验、修订、删除或本条提示" in prompt
    assert visible == revised
    assert FIRST not in visible
    assert verification == [{"type": "answer_verification", "revised": True, "removedSentences": 0,
                             "factSentences": 2, "citedFactSentences": 2, "uncited": 0, "invalidCitations": 0,
                             "coverage": 1.0}]
    assert any(e.get("type") == "search_sources" for e in events)


@pytest.mark.parametrize("plugin", [False, True])
def test_still_uncited_after_revision_sentences_are_deleted_without_third_call(monkeypatch, plugin):
    still_bad = "## 国内要闻\n9月CPI同比上涨0.9%。[S1]\n另据统计进出口增长18.8%。[S9]"
    calls, visible, verification, _ = run(monkeypatch, [FIRST, still_bad], plugin=plugin)
    assert len(calls) == 4
    assert "18.8%" not in visible and "[S9]" not in visible
    assert visible == "## 国内要闻\n9月CPI同比上涨0.9%。[S1]"
    assert "已删除" not in visible
    assert verification[0]["revised"] is True and verification[0]["removedSentences"] == 1


def test_everything_unsupported_returns_honest_fallback(monkeypatch):
    calls, visible, _, _ = run(monkeypatch, ["9月CPI同比上涨0.9%。", "9月CPI同比上涨0.9%。"])
    assert visible == "本轮检索到的来源不足以支持可靠的回答，请换个问法或稍后重试。"


def test_fully_cited_answer_passes_without_revision(monkeypatch):
    good = "9月CPI同比上涨0.9%。[S1] M2余额同比增长7.2%。[S2]"
    calls, visible, verification, _ = run(monkeypatch, [good])
    assert len(calls) == 3 and visible == good
    assert verification[0]["revised"] is False and verification[0]["coverage"] == 1.0


def test_answers_using_non_research_tools_are_not_verified(monkeypatch):
    calls, visible, verification, _ = run(monkeypatch, [FIRST], extra_tool="get_weather")
    assert len(calls) == 3 and visible == FIRST and verification == []
