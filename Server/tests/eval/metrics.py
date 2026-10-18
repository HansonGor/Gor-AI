"""Gor 评测指标（纯函数，不联网、不读写文件）。

所有指标都是**启发式**：切句、事实句识别、日期解析和事实匹配都基于规则，
可能漏判或误判，只用于在同一题库上做前后对比，不等于人工逐句核验。

输入（单题结果 result）：
    answer          完整回答文本
    sources         本题全部 search_sources（每项含 sourceId/url/title/snippet/publishedDate/dateHint）
    reader_pages    web_reader 读取到的页面（每项含 sourceId/url/body/key_paragraphs/published_at）
输入（题目 case）：gold_facts / expect_no_answer / needs_review。

指标定义：
1. 引用覆盖率 = 带有效 [S#] 的事实句数 ÷ 事实句总数。
   - 切句：按 。？！?! 、换行，以及后跟空白的英文句点切分；只含 [S#] 的片段并入前一句。
   - 事实句：含数字、日期、百分比、金额、版本号、引号内容、机构名或人名线索的句子。
     标题（Markdown #）、寒暄、"未查到"类说明、参考来源列表行不算。
   - 有效 [S#]：编号确实出现在本题的 search_sources 中。
   - 辅助指标"段落级覆盖率"：事实句所在段落（空行分隔；Markdown 标题单独成段）内任一句带有效引用即算覆盖。
     它反映"整段末尾统一标注来源"的写法，不能说明段内每句都被该来源支持，主指标仍以逐句为准。
2. 日期正确率 = 正确日期数 ÷ 带有效引用的日期总数。
   - 支持 2026年10月15日 / 10月15日 / 2026-10-15 / 2026/10/15 / 2026-10 / 2026年10月 / 10/15 / October 15, 2026；
     统一为 YYYY-MM-DD 或 YYYY-MM，缺年份时用所引来源年份补全，来源无年份时用运行日期年份。
   - 正确：与所引来源 publishedDate / dateHint / 页面 published_at 一致，或出现在该来源 snippet、
     web_reader 正文中。只有月份精度的日期按月份比较。
   - 句中有日期但没有有效引用的，不计入分母，单独计为"无法核对的日期"。
3. 无来源陈述数：无 [S#] 的事实句数（unsourced_no_citation）与引用了不存在编号的句子数
   （unsourced_invalid_citation）分开计数。
4. 事实正确率（只对 gold_facts 已填写且 needs_review=false 的题）= 命中数 ÷ gold_facts 总数。
   - 规则匹配：每个 keywords 组（"a|b" 表示任一即可）都出现在回答中即命中；全部不出现计为未命中；
     部分出现或无 keywords 且数字不全匹配时标记 needs_review，交人工复核，不自动判错。
   - must_cite_date：命中还要求含关键词的句子带有效引用和日期，否则降为 needs_review。
5. 新鲜度违规数：含"最新/今天/今日/昨天/昨日/刚刚"的事实句，所引来源中有日期者都早于阈值
   （默认 3 天）则计 1 次；所引来源都无发布日期的单独计为 freshness_undated。
6. 编造率（只对 expect_no_answer 题）= 给出具体事实而未承认未查到/指出不实的题数 ÷ 该类题数。
   未作答的题不计入编造率分母。
7. 未作答题数：回答为空或只有"已达到最大工具调用轮次限制"的题目数，单独报告。
"""

from __future__ import annotations

import re
from datetime import date, datetime
from typing import Any, Iterable

CITATION_RE = re.compile(r"\[(S\d+(?:\s*[,，、]\s*S\d+)*)\]")
CITATION_ONLY_RE = re.compile(r"^[\s\W]*(?:\[S\d+(?:\s*[,，、]\s*S\d+)*\][\s\W]*)+$")
SPLIT_RE = re.compile(r"(?<=[。？！?!])|\n|(?<=\.)\s+")

NOT_FOUND_RE = re.compile(
    r"未查到|没有查到|未找到|没有找到|暂无|无法确认|无法核实|未能核实|没有可靠|未检索到|未能检索|"
    r"没有检索到|查无|未见|未发现|没有发现|未能在本轮来源中找到依据"
)
DENIAL_RE = re.compile(
    r"并未|并没有|没有宣布|未宣布|不存在|未发布|尚未发布|没有发布|虚构|不实|谣言|假消息|误传|"
    r"没有.{0,30}(?:官方|消息|报道|证据|记录|信息|提到|公告|声明)|不属实|并非事实|no (?:credible|reliable) "
)
GREETING_RE = re.compile(r"^(?:你好|您好|希望|如需|如果您|如有|欢迎|以上是|下面是|以下是|总结|小结)")
FRESH_WORD_RE = re.compile(r"最新|今天|今日|昨天|昨日|刚刚")

ORG_RE = re.compile(
    r"[一-鿿]{1,12}(?:公司|集团|银行|部|委员会|委|局|署|政府|大学|研究院|研究所|协会|组织|基金|交易所|法院|议会|国会|"
    r"联盟|央行|美联储|联合国|安理会|国务院|人大|政协)|"
    r"(?:Inc|Corp|Ltd|LLC|Group|Bank|Agency|Commission|Reserve|Council|Ministry|University)\b"
)
PERSON_RE = re.compile(r"[一-鿿·]{2,6}(?:表示|称|指出|宣布|说|透露|强调)|[A-Z][a-z]+ [A-Z][a-z]+")
NUMBER_RE = re.compile(r"\d")
QUOTE_RE = re.compile(r"[“「『\"].{2,}?[”」』\"]")
VERSION_RE = re.compile(r"\b[vV]?\d+\.\d+(?:\.\d+)?\b")

MONTHS_EN = {m: i for i, m in enumerate(
    ["january", "february", "march", "april", "may", "june", "july", "august",
     "september", "october", "november", "december"], 1)}
MONTHS_EN.update({k[:3]: v for k, v in list(MONTHS_EN.items())})

DATE_PATTERNS = [
    ("ymd", re.compile(r"(?<!\d)(20\d{2})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]")),
    ("ymd", re.compile(r"(?<!\d)(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})(?!\d)")),
    ("ym", re.compile(r"(?<!\d)(20\d{2})\s*年\s*(\d{1,2})\s*月(?!\s*\d{1,2}\s*[日号])")),
    ("ym", re.compile(r"(?<!\d)(20\d{2})-(\d{1,2})(?![-\d/.])")),
    ("md", re.compile(r"(?<![\d年])(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]")),
    ("md", re.compile(r"(?<![\d/.\-])(\d{1,2})/(\d{1,2})(?![\d/])")),
    ("en", re.compile(r"\b([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(20\d{2})\b")),
]


# ---------------------------------------------------------------- 文本切分

LIST_MARKER_RE = re.compile(r"^\s*(?:[-*+]|\d+[.)、])\s+")


def split_paragraphs(text: str) -> list[list[str]]:
    """按空行分段，再段内切句。Markdown 标题行单独成段且整行保留，列表序号 "1. " 不作为句点切分。"""
    paragraphs: list[list[str]] = []
    current: list[str] = []
    for line in (text or "").split("\n"):
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            if current:
                paragraphs.append(current)
                current = []
            if stripped:
                paragraphs.append([stripped])
            continue
        marker = LIST_MARKER_RE.match(stripped)
        prefix, body = (marker.group(0), stripped[marker.end():]) if marker else ("", stripped)
        for i, piece in enumerate(p.strip() for p in SPLIT_RE.split(body)):
            if not piece:
                continue
            if i == 0 and prefix:
                piece = prefix + piece
            if current and CITATION_ONLY_RE.match(piece):
                current[-1] = f"{current[-1]} {piece}"
                continue
            current.append(piece)
    if current:
        paragraphs.append(current)
    return paragraphs


def split_sentences(text: str) -> list[str]:
    """按句号/问号/感叹号/换行切句；纯 [S#] 片段并入前一句。"""
    return [s for para in split_paragraphs(text) for s in para]


def citations(sentence: str) -> list[str]:
    ids: list[str] = []
    for group in CITATION_RE.findall(sentence):
        ids.extend(re.findall(r"S\d+", group))
    return ids


def _strip_markup(sentence: str) -> str:
    text = re.sub(r"^\s*(?:[-*+]|\d+[.)、])\s+", "", sentence)
    text = text.replace("**", "").replace("__", "")
    return CITATION_RE.sub("", text).strip()


def is_heading(sentence: str) -> bool:
    raw = sentence.strip()
    if raw.startswith("#"):
        return True
    plain = raw.strip("*_ ")
    return bool(raw.startswith("**") and raw.rstrip().endswith("**") and not citations(raw) and len(plain) <= 40)


def is_reference_line(sentence: str) -> bool:
    raw = re.sub(r"^\s*(?:[-*+]|\d+[.)、])\s+", "", sentence.strip())
    return bool(re.match(r"^\[S\d+\]", raw)) or raw.startswith(("来源：", "来源:", "参考来源", "参考资料")) \
        or bool(re.fullmatch(r"\W*https?://\S+\W*", raw))


def is_not_found(sentence: str) -> bool:
    return bool(NOT_FOUND_RE.search(sentence))


def is_fact_sentence(sentence: str) -> bool:
    if is_heading(sentence) or is_reference_line(sentence) or is_not_found(sentence):
        return False
    text = _strip_markup(sentence)
    if len(text) < 4 or GREETING_RE.match(text):
        return False
    return bool(
        NUMBER_RE.search(text) or QUOTE_RE.search(text) or VERSION_RE.search(text)
        or ORG_RE.search(text) or PERSON_RE.search(text)
    )


# ---------------------------------------------------------------- 日期

def _fmt(y: int, m: int, d: int | None = None) -> str | None:
    if not (1 <= m <= 12) or (d is not None and not 1 <= d <= 31):
        return None
    return f"{y:04d}-{m:02d}" if d is None else f"{y:04d}-{m:02d}-{d:02d}"


def extract_dates(text: str, default_year: int | None = None) -> list[str]:
    """抽取日期并规范化为 YYYY-MM-DD / YYYY-MM；缺年份且无 default_year 时跳过。"""
    found: list[tuple[int, str]] = []
    taken: list[tuple[int, int]] = []
    for kind, pattern in DATE_PATTERNS:
        for match in pattern.finditer(text or ""):
            span = match.span()
            if any(span[0] < end and start < span[1] for start, end in taken):
                continue
            value = None
            if kind == "ymd":
                value = _fmt(int(match[1]), int(match[2]), int(match[3]))
            elif kind == "ym":
                value = _fmt(int(match[1]), int(match[2]))
            elif kind == "md" and default_year:
                value = _fmt(default_year, int(match[1]), int(match[2]))
            elif kind == "en":
                month = MONTHS_EN.get(match[1].lower())
                value = _fmt(int(match[3]), month, int(match[2])) if month else None
            if value:
                taken.append(span)
                found.append((span[0], value))
    return [value for _, value in sorted(found)]


def normalize_date(value: Any) -> str | None:
    """来源日期（ISO、带时间、中文等）规范化为 YYYY-MM-DD / YYYY-MM。"""
    if not value:
        return None
    text = str(value).strip()
    iso = re.match(r"^(20\d{2})-(\d{2})-(\d{2})", text)
    if iso:
        return _fmt(int(iso[1]), int(iso[2]), int(iso[3]))
    dates = extract_dates(text)
    return dates[0] if dates else None


def _parse_day(value: str | None) -> date | None:
    if not value:
        return None
    try:
        return datetime.strptime(value[:10], "%Y-%m-%d").date() if len(value) >= 10 \
            else datetime.strptime(value + "-01", "%Y-%m-%d").date()
    except ValueError:
        return None


def _dates_match(claim: str, known: str) -> bool:
    if len(claim) == 7 or len(known) == 7:
        return claim[:7] == known[:7]
    return claim == known


# ---------------------------------------------------------------- 来源索引

def build_source_index(sources: Iterable[dict], reader_pages: Iterable[dict] = ()) -> dict[str, dict]:
    """sourceId → {dates: [...], texts: [...], year}。reader 页面按 sourceId 或 url 关联。"""
    index: dict[str, dict] = {}
    by_url: dict[str, str] = {}
    for src in sources or []:
        sid = src.get("sourceId")
        if not sid:
            continue
        entry = index.setdefault(sid, {"dates": [], "texts": []})
        for key in ("publishedDate", "dateHint"):
            norm = normalize_date(src.get(key))
            if norm:
                entry["dates"].append(norm)
        entry["texts"].append(" ".join(str(src.get(k) or "") for k in ("title", "snippet")))
        if src.get("url"):
            by_url[src["url"]] = sid
    for page in reader_pages or []:
        sid = page.get("sourceId") or by_url.get(page.get("url", ""))
        if not sid or sid not in index:
            continue
        norm = normalize_date(page.get("published_at"))
        if norm:
            index[sid]["dates"].append(norm)
        paragraphs = page.get("key_paragraphs") or []
        index[sid]["texts"].append(" ".join([str(page.get("body") or "")] + [str(p) for p in paragraphs]))
    for entry in index.values():
        years = [int(d[:4]) for d in entry["dates"]]
        entry["year"] = max(years) if years else None
    return index


# ---------------------------------------------------------------- 单题指标

def sentence_metrics(answer: str, sources: list[dict], reader_pages: list[dict] | None = None,
                     run_date: date | None = None, freshness_days: int = 3) -> dict:
    run_date = run_date or date.today()
    index = build_source_index(sources, reader_pages or [])
    valid_ids = set(index)
    out = {
        "fact_sentences": 0, "cited_fact_sentences": 0,
        "unsourced_no_citation": 0, "unsourced_invalid_citation": 0,
        "dates_checked": 0, "dates_correct": 0, "dates_unverifiable": 0,
        "freshness_violations": 0, "freshness_undated": 0,
        "paragraph_cited_fact_sentences": 0,
        "problems": [],
    }
    for paragraph in split_paragraphs(answer):
        paragraph_cited = any(i in valid_ids for s in paragraph for i in citations(s))
        for sentence in paragraph:
            _score_sentence(sentence, paragraph_cited, index, valid_ids, run_date, freshness_days, out)
    return out


def _score_sentence(sentence: str, paragraph_cited: bool, index: dict, valid_ids: set,
                    run_date: date, freshness_days: int, out: dict) -> None:
    ids = citations(sentence)
    valid = [i for i in ids if i in valid_ids]
    invalid = [i for i in ids if i not in valid_ids]
    if invalid:
        out["unsourced_invalid_citation"] += 1
        out["problems"].append({"kind": "invalid_citation", "sentence": sentence, "ids": invalid})
    if not is_fact_sentence(sentence):
        return
    out["fact_sentences"] += 1
    if paragraph_cited:
        out["paragraph_cited_fact_sentences"] += 1
    if valid:
        out["cited_fact_sentences"] += 1
    elif not ids:
        out["unsourced_no_citation"] += 1
        out["problems"].append({"kind": "no_citation", "sentence": sentence})

    text = _strip_markup(sentence)
    source_year = next((index[i]["year"] for i in valid if index[i]["year"]), None)
    claim_dates = extract_dates(text, default_year=source_year or run_date.year)
    if claim_dates and not valid:
        out["dates_unverifiable"] += len(claim_dates)
    elif claim_dates:
        for claim in claim_dates:
            out["dates_checked"] += 1
            ok = False
            for sid in valid:
                entry = index[sid]
                if any(_dates_match(claim, known) for known in entry["dates"]):
                    ok = True
                else:
                    year = entry["year"] or int(claim[:4])
                    mentioned = [d for t in entry["texts"] for d in extract_dates(t, default_year=year)]
                    ok = any(_dates_match(claim, known) for known in mentioned)
                if ok:
                    break
            if ok:
                out["dates_correct"] += 1
            else:
                out["problems"].append({"kind": "date_mismatch", "sentence": sentence, "date": claim})

    if valid and FRESH_WORD_RE.search(text):
        ages = []
        for sid in valid:
            days = [_parse_day(d) for d in index[sid]["dates"]]
            days = [d for d in days if d]
            if days:
                ages.append((run_date - max(days)).days)
        if not ages:
            out["freshness_undated"] += 1
        elif min(ages) > freshness_days:
            out["freshness_violations"] += 1
            out["problems"].append({"kind": "stale_freshness_claim", "sentence": sentence, "age_days": min(ages)})


def _norm(text: str) -> str:
    table = {ord(c): ord(c) - 0xFEE0 for c in "０１２３４５６７８９％．"}
    return re.sub(r"\s+", "", (text or "").translate(table)).casefold()


def match_gold_fact(fact: dict, answer: str, sources: list[dict]) -> str:
    """返回 hit / miss / needs_review。"""
    norm_answer = _norm(answer)
    groups = fact.get("keywords") or []
    if groups:
        flags = [any(_norm(alt) in norm_answer for alt in str(g).split("|") if alt) for g in groups]
        if not any(flags):
            return "miss"
        if not all(flags):
            return "needs_review"
    else:
        numbers = re.findall(r"\d+(?:\.\d+)?", fact.get("text", ""))
        if not numbers or not all(n in norm_answer for n in numbers):
            return "needs_review"
    if fact.get("must_cite_date"):
        valid_ids = {s.get("sourceId") for s in sources or []}
        alts = [alt for g in groups for alt in str(g).split("|") if alt] or re.findall(r"\d+(?:\.\d+)?", fact.get("text", ""))
        supported = any(
            any(_norm(a) in _norm(s) for a in alts)
            and any(i in valid_ids for i in citations(s))
            and extract_dates(s, default_year=date.today().year)
            for s in split_sentences(answer)
        )
        if not supported:
            return "needs_review"
    return "hit"


def admits_no_answer(answer: str) -> bool:
    return bool(NOT_FOUND_RE.search(answer or "") or DENIAL_RE.search(answer or ""))


def evaluate_case(case: dict, result: dict, run_date: date | None = None, freshness_days: int = 3) -> dict:
    answer = result.get("answer") or ""
    sources = result.get("sources") or []
    metrics = sentence_metrics(answer, sources, result.get("reader_pages") or [], run_date, freshness_days)
    gold = case.get("gold_facts") or []
    scored = bool(gold) and not case.get("needs_review")
    facts = [{"text": f.get("text", ""), "status": match_gold_fact(f, answer, sources)} for f in gold] if gold else []
    metrics.update({
        "gold_scored": scored,
        "gold_total": len(gold) if scored else 0,
        "gold_hits": sum(f["status"] == "hit" for f in facts) if scored else 0,
        "gold_misses": sum(f["status"] == "miss" for f in facts) if scored else 0,
        "gold_needs_review": sum(f["status"] == "needs_review" for f in facts) if scored else 0,
        "gold_detail": facts,
        "expect_no_answer": bool(case.get("expect_no_answer")),
        "fabricated": None,
    })
    # 没有给出任何回答（空文本或只有"已达到最大工具调用轮次限制"）单独计数，不能当作"没有事实句"跳过
    stripped = re.sub(r"[（(]已达到最大工具调用轮次限制[）)]", "", answer).strip()
    metrics["unanswered"] = not stripped
    if case.get("expect_no_answer") and not result.get("error") and not metrics["unanswered"]:
        metrics["fabricated"] = bool(metrics["fact_sentences"]) and not admits_no_answer(answer)
    return metrics


# ---------------------------------------------------------------- 汇总

SUM_KEYS = ("fact_sentences", "cited_fact_sentences", "paragraph_cited_fact_sentences","unsourced_no_citation", "unsourced_invalid_citation",
            "dates_checked", "dates_correct", "dates_unverifiable", "freshness_violations", "freshness_undated",
            "gold_total", "gold_hits", "gold_misses", "gold_needs_review")


def _ratio(num: int, den: int) -> float | None:
    return round(num / den, 4) if den else None


def aggregate(items: list[dict]) -> dict:
    """items: evaluate_case 的输出列表（失败题可传 {"error": ...}）。"""
    scored = [m for m in items if "fact_sentences" in m]
    total = {key: sum(m.get(key, 0) for m in scored) for key in SUM_KEYS}
    no_answer = [m for m in scored if m.get("fabricated") is not None]
    total.update({
        "cases": len(items),
        "evaluated_cases": len(scored),
        "citation_coverage": _ratio(total["cited_fact_sentences"], total["fact_sentences"]),
        "paragraph_citation_coverage": _ratio(total["paragraph_cited_fact_sentences"], total["fact_sentences"]),
        "date_accuracy": _ratio(total["dates_correct"], total["dates_checked"]),
        "unsourced_statements": total["unsourced_no_citation"] + total["unsourced_invalid_citation"],
        "fact_accuracy": _ratio(total["gold_hits"], total["gold_total"]),
        "fact_accuracy_decided": _ratio(total["gold_hits"], total["gold_hits"] + total["gold_misses"]),
        "unanswered_cases": sum(bool(m.get("unanswered")) for m in scored),
        "no_answer_cases": len(no_answer),
        "fabricated_cases": sum(bool(m["fabricated"]) for m in no_answer),
        "fabrication_rate": _ratio(sum(bool(m["fabricated"]) for m in no_answer), len(no_answer)),
    })
    return total


def badness(metrics: dict) -> float:
    """用于挑选"最差题目"的排序分，越大越差。"""
    if "fact_sentences" not in metrics:
        return 100.0
    if metrics.get("unanswered"):
        return 50.0
    score =metrics["unsourced_no_citation"] + 2 * metrics["unsourced_invalid_citation"]
    score += (metrics["dates_checked"] - metrics["dates_correct"]) + metrics["freshness_violations"]
    score += 3 * metrics.get("gold_misses", 0) + (10 if metrics.get("fabricated") else 0)
    if metrics["fact_sentences"]:
        score += 3 * (1 - metrics["cited_fact_sentences"] / metrics["fact_sentences"])
    return round(score, 3)
