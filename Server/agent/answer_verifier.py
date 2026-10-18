"""联网回答的引用核验（阶段一：逐句引用覆盖）。

纯函数，不联网、不调用模型。规则：
- 事实句（含数字、日期、百分比、金额、版本号、引号内容、机构名或人名线索）必须在本句带有效 [S#]；
  有效 = 编号属于本轮证据账本。只在段末统一标注不算本句有引用。
- 引用不存在的编号视为无效引用。
- 标题、寒暄、"未查到"类说明、问句、参考来源列表、代码块不检查。
cleanup() 删除无效编号，再删除仍没有有效引用的事实句，并清理因此变空的列表项、表格和标题。
这些规则是启发式的，与 tests/eval 中的评测指标相互独立实现。
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

CITATION_RE = re.compile(r"\[(S\d+(?:\s*[,，、]\s*S\d+)*)\]")
ONLY_CITATIONS_RE = re.compile(r"^(?:\s*\[S\d+(?:\s*[,，、]\s*S\d+)*\])+[\s。.，,;；]*$")
LEADING_CITATIONS_RE = re.compile(r"^(\s*(?:\[S\d+(?:\s*[,，、]\s*S\d+)*\]\s*)+)")
SOURCE_NOTE_RE =re.compile(r"^[（(]\s*(?:来源|出处|source)", re.I)
SENTENCE_END_RE = re.compile(r"(?<=[。！？!?])|(?<=\.)(?=\s)")
LIST_PREFIX_RE = re.compile(r"^(\s*(?:[-*+]|\d+[.)、])\s+)")
TABLE_SEPARATOR_RE = re.compile(r"^\s*\|?\s*:?-{2,}:?\s*(?:\|\s*:?-{2,}:?\s*)*\|?\s*$")
NOT_FOUND_RE = re.compile(r"未查到|没有查到|未找到|没有找到|暂无|无法确认|无法核实|未能核实|没有可靠|未检索到|未能检索|"
                          r"没有检索到|查无|未发现|没有发现|not found|no reliable", re.I)
GREETING_RE = re.compile(r"^(?:你好|您好|希望|如需|如果您|如有|欢迎|以上是|下面是|以下是|总结|小结|注意|提示)")
ORG_RE = re.compile(
    r"[一-鿿]{1,12}(?:公司|集团|银行|部|委员会|局|署|政府|大学|研究院|研究所|协会|组织|基金|交易所|法院|议会|国会|"
    r"联盟|央行|美联储|联合国|安理会|国务院|人大|政协|统计局|海关)|"
    r"\b(?:Inc|Corp|Ltd|LLC|Group|Bank|Agency|Commission|Reserve|Council|Ministry|University)\b")
PERSON_RE = re.compile(r"[一-鿿·]{2,6}(?:表示|称|指出|宣布|说|透露|强调)|\b[A-Z][a-z]+ [A-Z][a-z]+\b")
QUOTE_RE = re.compile(r"[“「『\"][^“”「」『』\"]{2,}[”」』\"]")


def citation_ids(text: str) -> list[str]:
    ids: list[str] = []
    for group in CITATION_RE.findall(text):
        ids.extend(re.findall(r"S\d+", group))
    return ids


def _plain(text: str) -> str:
    text = LIST_PREFIX_RE.sub("", text)
    text = re.sub(r"\[([^\]]+)\]\((?:https?://)[^)]+\)", r"\1", text)  # Markdown 链接只保留文字
    text = re.sub(r"https?://\S+", "", text)
    text = text.replace("**", "").replace("__", "").replace("`", "")
    return CITATION_RE.sub("", text).strip(" |")


def is_fact_sentence(sentence: str) -> bool:
    text = _plain(sentence)
    if len(text) < 4 or NOT_FOUND_RE.search(text) or GREETING_RE.match(text):
        return False
    if text.endswith(("？", "?")):
        return False
    return bool(re.search(r"\d", text) or QUOTE_RE.search(text) or ORG_RE.search(text) or PERSON_RE.search(text))


@dataclass
class Sentence:
    text: str
    fact: bool
    valid: list[str]
    invalid: list[str]


@dataclass
class Line:
    raw: str
    kind: str  # blank / code / heading / table_sep / table_head / text / reference
    prefix: str = ""
    sentences: list[Sentence] = field(default_factory=list)


@dataclass
class VerificationReport:
    fact_sentences: int = 0
    cited_fact_sentences: int = 0
    uncited: list[str] = field(default_factory=list)
    invalid: list[tuple[str, list[str]]] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return not self.uncited and not self.invalid

    @property
    def coverage(self) -> float | None:
        return round(self.cited_fact_sentences / self.fact_sentences, 4) if self.fact_sentences else None

    def counts(self) -> dict:
        return {"factSentences": self.fact_sentences, "citedFactSentences": self.cited_fact_sentences,
                "uncited": len(self.uncited), "invalidCitations": len(self.invalid), "coverage": self.coverage}


def _split_sentences(body: str) -> list[str]:
    parts: list[str] = []
    for piece in SENTENCE_END_RE.split(body):
        if not piece or not piece.strip():
            if parts and piece:
                parts[-1] += piece
            continue
        stripped = piece.strip()
        # 纯引用片段、"（来源：…）"说明归属前一句
        if parts and (ONLY_CITATIONS_RE.match(stripped) or SOURCE_NOTE_RE.match(stripped)):
            parts[-1] += piece
            continue
        # "……上涨0.9%。[S1] 下一句……"：句号后紧跟的引用属于前一句
        leading = LEADING_CITATIONS_RE.match(piece)
        if parts and leading:
            parts[-1] += leading.group(1)
            piece = piece[leading.end(1):]
            if not piece.strip():
                continue
        parts.append(piece)
    return parts


def _sentence(text: str, valid_ids: set[str]) -> Sentence:
    ids = citation_ids(text)
    return Sentence(text=text, fact=is_fact_sentence(text),
                    valid=[i for i in ids if i in valid_ids], invalid=[i for i in ids if i not in valid_ids])


def parse(answer: str, valid_ids: set[str]) -> list[Line]:
    lines: list[Line] = []
    in_code = False
    raw_lines = answer.split("\n")
    for index, raw in enumerate(raw_lines):
        stripped = raw.strip()
        if stripped.startswith("```"):
            in_code = not in_code
            lines.append(Line(raw, "code"))
            continue
        if in_code:
            lines.append(Line(raw, "code"))
            continue
        if not stripped:
            lines.append(Line(raw, "blank"))
        elif stripped.startswith("#"):
            lines.append(Line(raw, "heading"))
        elif TABLE_SEPARATOR_RE.match(stripped) and "|" in stripped:
            lines.append(Line(raw, "table_sep"))
        elif stripped.startswith("|"):
            next_line = raw_lines[index + 1].strip() if index + 1 < len(raw_lines) else ""
            if TABLE_SEPARATOR_RE.match(next_line) and "|" in next_line:
                lines.append(Line(raw, "table_head"))
            else:
                # 表格行整体作为一句，不在单元格内切分
                lines.append(Line(raw, "text", sentences=[_sentence(raw, valid_ids)]))
        else:
            match = LIST_PREFIX_RE.match(raw)
            prefix = match.group(1) if match else ""
            body = raw[len(prefix):]
            plain = _plain(body)
            if re.match(r"^\[S\d+\]", body.strip()) or plain.startswith(("来源：", "来源:", "参考来源", "参考资料")):
                lines.append(Line(raw, "reference"))
                continue
            sentences = [_sentence(part, valid_ids) for part in _split_sentences(body)]
            lines.append(Line(raw, "text", prefix=prefix, sentences=sentences))
    return lines


def verify(answer: str, valid_ids: set[str]) -> VerificationReport:
    report = VerificationReport()
    for line in parse(answer or "", valid_ids):
        for sentence in line.sentences:
            if sentence.invalid:
                report.invalid.append((sentence.text.strip(), sentence.invalid))
            if not sentence.fact:
                continue
            report.fact_sentences += 1
            if sentence.valid:
                report.cited_fact_sentences += 1
            else:
                report.uncited.append(sentence.text.strip())
    return report


def _strip_invalid(text: str, valid_ids: set[str]) -> str:
    def replace(match: re.Match) -> str:
        kept = [i for i in re.findall(r"S\d+", match.group(1)) if i in valid_ids]
        return "".join(f"[{i}]" for i in kept)
    return CITATION_RE.sub(replace, text)


def _heading_level(raw: str) -> int:
    return len(raw.strip()) - len(raw.strip().lstrip("#"))


def cleanup(answer: str, valid_ids: set[str]) -> tuple[str, int]:
    """删除无效编号与无有效引用的事实句，返回 (清理后的回答, 删除的事实句数)。"""
    removed = 0
    out: list[Line] = []
    for line in parse(answer or "", valid_ids):
        if line.kind != "text":
            out.append(line)
            continue
        kept = []
        for sentence in line.sentences:
            if sentence.fact and not sentence.valid:
                removed += 1
                continue
            kept.append(_strip_invalid(sentence.text, valid_ids) if sentence.invalid else sentence.text)
        body = "".join(kept).strip()
        if line.sentences and not re.search(r"[\w一-鿿]", body):
            continue  # 整行被删除，或只剩 "**"、"：" 之类的标记和标点
        text = (line.prefix + body) if line.prefix else (line.raw if body == line.raw.strip() else body)
        out.append(Line(text, "text"))

    # 表头、分隔行后已无数据行时整表删除
    cleaned: list[Line] = []
    for index, line in enumerate(out):
        if line.kind in {"table_head", "table_sep"}:
            following = out[index + 1:]
            rows = next((i for i, l in enumerate(following) if l.kind not in {"table_head", "table_sep"}), len(following))
            data = following[rows:] if rows < len(following) else []
            if not data or not data[0].raw.strip().startswith("|"):
                continue
        cleaned.append(line)

    # 标题下（直到同级或更高级标题）没有任何正文时删除标题
    result: list[str] = []
    for index, line in enumerate(cleaned):
        if line.kind == "heading":
            level = _heading_level(line.raw)
            has_body = False
            for later in cleaned[index + 1:]:
                if later.kind == "heading" and _heading_level(later.raw) <= level:
                    break
                if later.kind not in {"blank", "heading"}:
                    has_body = True
                    break
            if not has_body:
                continue
        result.append(line.raw)
    text = re.sub(r"\n{3,}", "\n\n", "\n".join(result)).strip()
    return text, removed
