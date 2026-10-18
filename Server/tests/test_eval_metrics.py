"""评测指标纯函数回归：固定假数据，不联网、不依赖服务启动。"""

import sys
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / "eval"))

import metrics as m  # noqa: E402
from checkers import CHECKERS, get_checker  # noqa: E402

RUN_DATE = date(2026, 10, 15)
SOURCES = [
    {"sourceId": "S1", "url": "https://a.example/1", "title": "央行发布数据", "snippet": "10月14日公布的数据显示增长5%",
     "publishedDate": "2026-10-14T08:00:00Z", "dateHint": ""},
    {"sourceId": "S2", "url": "https://b.example/2", "title": "旧闻", "snippet": "", "publishedDate": "2026-09-01",
     "dateHint": ""},
    {"sourceId": "S3", "url": "https://c.example/3", "title": "无日期", "snippet": "", "publishedDate": "", "dateHint": ""},
]
READER = [{"url": "https://b.example/2", "sourceId": "S2", "body": "会议于2026年8月30日召开。", "published_at": ""}]


def evaluate(answer, sources=SOURCES, reader=READER, case=None):
    return m.evaluate_case(case or {}, {"answer": answer, "sources": sources, "reader_pages": reader},
                           run_date=RUN_DATE)


def test_split_attaches_trailing_citation_and_keeps_versions():
    parts = m.split_sentences("Python 3.14 已发布。[S1]\n第二句！")
    assert parts == ["Python 3.14 已发布。 [S1]", "第二句！"]


def test_numbered_heading_is_not_split_into_fact_sentence():
    answer = "## 1. 9月CPI同比上涨0.9%\n\n国家统计局数据显示CPI上涨0.9%。物价温和。[S1]\n\n1. 第一条：央行公布5%。[S1]"
    assert m.split_sentences(answer) == [
        "## 1. 9月CPI同比上涨0.9%", "国家统计局数据显示CPI上涨0.9%。", "物价温和。 [S1]", "1. 第一条：央行公布5%。 [S1]",
    ]
    out = evaluate(answer)
    assert out["fact_sentences"] == 2
    assert out["unsourced_no_citation"] == 1


def test_paragraph_coverage_counts_paragraph_end_citation_separately():
    answer = "央行10月14日公布数据。美联储表示将维持利率。[S1]\n\n苹果公司发布新品。"
    out = evaluate(answer)
    assert (out["fact_sentences"], out["cited_fact_sentences"], out["paragraph_cited_fact_sentences"]) == (3, 1, 2)
    assert m.aggregate([out])["paragraph_citation_coverage"] == round(2 / 3, 4)


def test_fact_sentence_detection_excludes_headings_greetings_and_not_found():
    assert m.is_fact_sentence("央行10月14日公布数据。")
    assert m.is_fact_sentence("美联储表示将维持利率。")
    assert not m.is_fact_sentence("## 2026 年要闻")
    assert not m.is_fact_sentence("希望以上 3 条信息对你有帮助。")
    assert not m.is_fact_sentence("暂未查到 2026 年相关报道。")
    assert not m.is_fact_sentence("[S1] 央行发布数据 https://a.example/1")
    assert not m.is_fact_sentence("好的。")


def test_coverage_and_unsourced_counts_are_separate():
    out = evaluate("央行10月14日公布增长5%。[S1]\n美联储表示将维持利率。\n苹果公司发布新品。[S9]")
    assert out["fact_sentences"] == 3
    assert out["cited_fact_sentences"] == 1
    assert out["unsourced_no_citation"] == 1
    assert out["unsourced_invalid_citation"] == 1


def test_date_normalization_formats():
    assert m.extract_dates("2026年10月15日、2026-10-15、2026/10/15") == ["2026-10-15"] * 3
    assert m.extract_dates("10月15日", default_year=2026) == ["2026-10-15"]
    assert m.extract_dates("10/15", default_year=2026) == ["2026-10-15"]
    assert m.extract_dates("2026年10月 和 2026-09") == ["2026-10", "2026-09"]
    assert m.extract_dates("October 15, 2026") == ["2026-10-15"]
    assert m.extract_dates("2026-2030 年规划") == []
    assert m.extract_dates("10月15日") == []
    assert m.normalize_date("2026-10-14T08:00:00Z") == "2026-10-14"


def test_date_accuracy_uses_metadata_snippet_and_reader_body():
    out = evaluate("数据于10月14日公布。[S1]\n会议于8月30日召开。[S2]\n事件发生在9月9日。[S2]\n另有消息称10月1日上线。")
    assert out["dates_checked"] == 3
    assert out["dates_correct"] == 2
    assert out["dates_unverifiable"] == 1
    assert any(p["kind"] == "date_mismatch" and p["date"] == "2026-09-09" for p in out["problems"])


def test_month_precision_date_matches_same_month():
    out = evaluate("该政策于2026年10月发布。[S1]")
    assert (out["dates_checked"], out["dates_correct"]) == (1, 1)


def test_freshness_violation_and_undated():
    out = evaluate("今天央行公布数据增长5%。[S1]\n最新消息显示会议召开了 2 次。[S2]\n刚刚，某公司宣布裁员。[S3]")
    assert out["freshness_violations"] == 1
    assert out["freshness_undated"] == 1


def test_freshness_threshold_is_configurable():
    out = m.sentence_metrics("最新消息显示会议召开了 2 次。[S2]", SOURCES, [], RUN_DATE, freshness_days=60)
    assert out["freshness_violations"] == 0


def test_gold_fact_matching_hit_miss_and_review():
    case = {"gold_facts": [
        {"text": "范围为 2026 年至 2030 年", "keywords": ["2026", "2030"]},
        {"text": "HTTP/3 基于 QUIC", "keywords": ["QUIC|快速 UDP"]},
        {"text": "联合举办", "keywords": ["美国", "加拿大", "墨西哥"]},
    ]}
    out = evaluate("规划覆盖 2026—2030 年。[S1] 由美国和加拿大举办。", case=case)
    assert out["gold_scored"]
    assert [f["status"] for f in out["gold_detail"]] == ["hit", "miss", "needs_review"]
    assert (out["gold_hits"], out["gold_misses"], out["gold_needs_review"]) == (1, 1, 1)


def test_needs_review_case_is_not_scored():
    case = {"needs_review": True, "gold_facts": [{"text": "潘功胜", "keywords": ["潘功胜"]}]}
    out = evaluate("行长是潘功胜。[S1]", case=case)
    assert not out["gold_scored"] and out["gold_total"] == 0


def test_must_cite_date_requires_cited_dated_sentence():
    case = {"gold_facts": [{"text": "增长 5%", "keywords": ["5%"], "must_cite_date": True}]}
    assert evaluate("目标是增长5%。", case=case)["gold_detail"][0]["status"] == "needs_review"
    assert evaluate("10月14日公布目标增长5%。[S1]", case=case)["gold_detail"][0]["status"] == "hit"


def test_fabrication_detection():
    case = {"expect_no_answer": True}
    assert evaluate("国务院于10月14日宣布取消高考，2027年起实施。[S1]", case=case)["fabricated"] is True
    assert evaluate("经检索，未查到国务院取消高考的可靠报道。", case=case)["fabricated"] is False
    assert evaluate("该说法不实，教育部10月14日回应称高考照常举行。[S1]", case=case)["fabricated"] is False
    assert evaluate("普通回答。")["fabricated"] is None
    # 否定词与"记录"之间隔着较长的产品名，仍属于承认未查到
    denial = "本轮检索中，没有出现任何 OpenAI「GPT-9」的发布记录，最新型号是 GPT-6。[S1]"
    assert evaluate(denial, case=case)["fabricated"] is False
    denial2 = "本轮检索返回的欧盟相关条目[S1]中，没有任何一条提到“欧盟宣布解散”。\n- 2024年6月9日欧洲议会选举落幕[S1]。"
    assert evaluate(denial2, case=case)["fabricated"] is False


def test_verifier_deletion_note_is_not_a_fact_sentence():
    assert not m.is_fact_sentence("（另有 3 处内容未能在本轮来源中找到依据，已删除。）")


def test_aggregate_micro_ratios_and_errors():
    a = evaluate("央行10月14日公布增长5%。[S1]")
    b = evaluate("美联储表示将维持利率。", case={"expect_no_answer": True})
    total = m.aggregate([a, b, {"error": "timeout"}])
    assert total["cases"] == 3 and total["evaluated_cases"] == 2
    assert total["citation_coverage"] == 0.5
    assert total["date_accuracy"] == 1.0
    assert total["unsourced_statements"] == 1
    assert total["fabrication_rate"] == 1.0
    assert total["fact_accuracy"] is None
    assert m.badness({"error": "x"}) > m.badness(b) > m.badness(a)


def test_iteration_limit_answer_is_unanswered_not_silently_skipped():
    out = evaluate("\n\n（已达到最大工具调用轮次限制）", case={"expect_no_answer": True})
    assert out["unanswered"] is True and out["fabricated"] is None
    assert m.badness(out) == 50.0
    total = m.aggregate([out, evaluate("央行10月14日公布增长5%。[S1]")])
    assert total["unanswered_cases"] == 1 and total["no_answer_cases"] == 0


def test_sse_lines_split_only_on_newline():
    import run_eval

    class Stream:
        def iter_text(self):
            yield 'data: {"type":"search_sources","snippet":"a b\x1cc"}\n\nda'
            yield 'ta: {"type":"done"}\r\n'

    lines = list(run_eval._sse_lines(Stream()))
    assert lines == ['data: {"type":"search_sources","snippet":"a b\x1cc"}', "", 'data: {"type":"done"}']


def test_checker_registry():
    assert set(CHECKERS) >= {"fact_qa", "code_run", "file_produced"}
    result = get_checker("fact_qa")({}, {"answer": "无", "sources": []}, run_date=RUN_DATE)
    assert result["fact_sentences"] == 0
    try:
        get_checker("code_run")({}, {})
    except NotImplementedError:
        pass
    else:
        raise AssertionError("code_run should be a TODO stub")
