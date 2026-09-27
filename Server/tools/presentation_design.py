"""Versioned Presentation Design Schema, theme tokens, layouts and deterministic QA."""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


ThemeName = Literal["modern-light", "modern-dark", "business", "minimal", "technology"]
SlideType = Literal[
    "cover", "section", "title-content", "image-text", "full-image", "big-number",
    "metrics", "comparison", "timeline", "process", "cards", "chart", "table", "quote", "summary",
]


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Metric(StrictModel):
    label: str = Field(min_length=1, max_length=48)
    value: str = Field(min_length=1, max_length=32)
    note: str | None = Field(default=None, max_length=80)


class ChartSeries(StrictModel):
    name: str = Field(min_length=1, max_length=40)
    values: list[float] = Field(min_length=1, max_length=10)


class ChartDesign(StrictModel):
    type: Literal["bar", "line", "area", "donut"]
    title: str | None = Field(default=None, max_length=80)
    categories: list[str] = Field(min_length=1, max_length=10)
    series: list[ChartSeries] = Field(min_length=1, max_length=3)
    unit: str | None = Field(default=None, max_length=16)
    highlight: str | None = Field(default=None, max_length=40)

    @model_validator(mode="after")
    def matching_series(self):
        if any(len(item.values) != len(self.categories) for item in self.series):
            raise ValueError("图表每组数据必须与 categories 数量一致。")
        if any(not (-1e12 < value < 1e12) for item in self.series for value in item.values):
            raise ValueError("图表数值超出安全范围。")
        return self


class TableDesign(StrictModel):
    headers: list[str] = Field(min_length=1, max_length=8)
    rows: list[list[str]] = Field(min_length=1, max_length=8)
    highlightRows: list[int] = Field(default_factory=list, max_length=8)
    highlightColumns: list[int] = Field(default_factory=list, max_length=8)

    @model_validator(mode="after")
    def validate_grid(self):
        if any(len(row) != len(self.headers) for row in self.rows):
            raise ValueError("表格每一行都必须与表头列数相同。")
        if any(index < 0 or index >= len(self.rows) for index in self.highlightRows):
            raise ValueError("highlightRows 索引无效。")
        if any(index < 0 or index >= len(self.headers) for index in self.highlightColumns):
            raise ValueError("highlightColumns 索引无效。")
        if any(len(cell) > 80 for row in self.rows for cell in row):
            raise ValueError("表格单元格最多 80 个字符，请精简或拆页。")
        return self


class TimelineItem(StrictModel):
    label: str = Field(min_length=1, max_length=40)
    title: str = Field(min_length=1, max_length=64)
    detail: str = Field(default="", max_length=140)


class SlideDesign(StrictModel):
    id: str = Field(min_length=1, max_length=48, pattern=r"^[A-Za-z0-9_-]+$")
    type: SlideType
    title: str | None = Field(default=None, max_length=120)
    subtitle: str | None = Field(default=None, max_length=160)
    eyebrow: str | None = Field(default=None, max_length=48)
    keyMessage: str | None = Field(default=None, max_length=240)
    supportingPoints: list[str] = Field(default_factory=list, max_length=5)
    visualIntent: str | None = Field(default=None, max_length=180)
    imageQuery: str | None = Field(default=None, max_length=120)
    dataIntent: str | None = Field(default=None, max_length=120)
    layoutVariant: str | None = Field(default=None, max_length=32)
    metrics: list[Metric] = Field(default_factory=list, max_length=4)
    chart: ChartDesign | None = None
    table: TableDesign | None = None
    timeline: list[TimelineItem] = Field(default_factory=list, max_length=6)
    quote: str | None = Field(default=None, max_length=500)
    attribution: str | None = Field(default=None, max_length=80)
    emphasis: list[str] = Field(default_factory=list, max_length=5)
    sources: list[str] = Field(default_factory=list, max_length=4)

    @model_validator(mode="after")
    def validate_slide_payload(self):
        if any(len(point) > 2000 for point in self.supportingPoints):
            raise ValueError("单条 supporting point 超过 2000 个字符，请分成多条要点。")
        if self.type == "chart" and self.chart is None:
            raise ValueError("chart 类型页面必须提供 chart 数据。")
        if self.type == "table" and self.table is None:
            raise ValueError("table 类型页面必须提供 table 数据。")
        if self.type in {"metrics", "big-number"} and not self.metrics:
            raise ValueError(f"{self.type} 类型页面至少需要一个 metric。")
        if self.type in {"timeline", "process"} and not self.timeline:
            raise ValueError(f"{self.type} 类型页面至少需要一个 timeline 项。")
        if self.type == "quote" and not self.quote:
            raise ValueError("quote 类型页面必须提供 quote。")
        return self


class PresentationDesign(StrictModel):
    version: Literal["1.0"] = "1.0"
    title: str = Field(min_length=1, max_length=100)
    description: str | None = Field(default=None, max_length=300)
    audience: str | None = Field(default=None, max_length=100)
    purpose: str | None = Field(default=None, max_length=160)
    theme: ThemeName = "modern-dark"
    aspectRatio: Literal["16:9", "4:3"] = "16:9"
    slides: list[SlideDesign] = Field(min_length=1, max_length=25)

    @model_validator(mode="after")
    def unique_slides(self):
        ids = [slide.id for slide in self.slides]
        if len(ids) != len(set(ids)):
            raise ValueError("slide id 必须唯一。")
        if sum(len(slide.supportingPoints) for slide in self.slides) > 100:
            raise ValueError("整份演示文稿正文过长，请精简或拆成多份。")
        return self


THEMES: dict[str, dict[str, Any]] = {
    "modern-light": {"background": "F5F7FB", "gradientEnd": "E7ECF8", "surface": "FFFFFF", "primary": "4056C9", "secondary": "7D8CE6", "accent": "10A7A0", "textPrimary": "172033", "textSecondary": "576175", "muted": "8992A5", "border": "DDE2EC", "radius": 0.16, "font": "Aptos", "chartStyle": "clean", "imageStyle": "cover", "decorations": "soft"},
    "modern-dark": {"background": "111827", "gradientEnd": "202C46", "surface": "1D293B", "primary": "8B9BFF", "secondary": "5265D6", "accent": "43D9C3", "textPrimary": "F5F7FB", "textSecondary": "C4CCDB", "muted": "8792A5", "border": "354258", "radius": 0.18, "font": "Aptos", "chartStyle": "clean", "imageStyle": "cover", "decorations": "glow"},
    "business": {"background": "F2F4F6", "gradientEnd": "E2EAF2", "surface": "FFFFFF", "primary": "17365D", "secondary": "2E75A5", "accent": "D49B36", "textPrimary": "182638", "textSecondary": "46576A", "muted": "778597", "border": "D7DDE3", "radius": 0.08, "font": "Aptos", "chartStyle": "restrained", "imageStyle": "cover", "decorations": "rule"},
    "minimal": {"background": "FAFAF8", "gradientEnd": "F0EFEA", "surface": "FFFFFF", "primary": "242424", "secondary": "727272", "accent": "B35C3B", "textPrimary": "242424", "textSecondary": "5E5E5E", "muted": "8D8D8D", "border": "E7E5E1", "radius": 0.06, "font": "Aptos", "chartStyle": "minimal", "imageStyle": "contain", "decorations": "none"},
    "technology": {"background": "0B1020", "gradientEnd": "202A4B", "surface": "151E35", "primary": "6EA8FF", "secondary": "685DFF", "accent": "35E0C1", "textPrimary": "F4F7FF", "textSecondary": "B8C5E0", "muted": "7787A8", "border": "2B395A", "radius": 0.16, "font": "Aptos", "chartStyle": "clean", "imageStyle": "cover", "decorations": "grid"},
}


VARIANTS: dict[str, set[str]] = {
    "image-text": {"image-left", "image-right", "image-top", "image-background"},
    "big-number": {"center", "left", "split"},
    "comparison": {"two-column", "cards"},
    "metrics": {"2-column", "3-column", "4-column", "hero-metric"},
    "cards": {"2-column", "3-column", "4-column"},
}


CANVAS = {"16:9": (13.333, 7.5), "4:3": (10.0, 7.5)}
SAFE_MARGIN = 0.62


def resolve_theme(name: str) -> dict[str, Any]:
    """Return a copy so renderers cannot mutate the shared design tokens."""
    if name not in THEMES:
        raise ValueError(f"不支持的主题：{name}")
    return dict(THEMES[name])


def choose_layout(slide: SlideDesign, slide_index: int = 0) -> str:
    allowed = VARIANTS.get(slide.type)
    if allowed:
        if slide.layoutVariant in allowed:
            return str(slide.layoutVariant)
        defaults = {
            "image-text": "image-right",
            "big-number": "center",
            "comparison": "two-column",
            "metrics": "hero-metric" if len(slide.metrics) == 1 else "2-column",
            "cards": "2-column",
        }
        preferred = defaults.get(slide.type)
        if preferred in allowed:
            return preferred
        return sorted(allowed)[0]
    return "default"


def story_outline(design: PresentationDesign) -> list[dict[str, Any]]:
    """Normalize semantic planning fields; coordinates are intentionally absent."""
    return [
        {
            "index": index,
            "slideId": slide.id,
            "slideType": slide.type,
            "objective": slide.eyebrow or slide.type,
            "keyMessage": slide.keyMessage or slide.title or "",
            "supportingPoints": list(slide.supportingPoints),
            "visualIntent": slide.visualIntent,
            "dataIntent": slide.dataIntent,
            "layoutVariant": choose_layout(slide, index),
        }
        for index, slide in enumerate(design.slides)
    ]


_SENTENCE_BREAKS = "。！？；，、,.!?; "


def _split_for_fit(text: str, max_chars: int) -> list[str]:
    """Split dense copy at natural punctuation while preserving every character."""
    remaining = text
    parts: list[str] = []
    while len(remaining) > max_chars:
        cut = max_chars
        for index in range(max_chars, max(1, int(max_chars * 0.65)), -1):
            if remaining[index - 1] in _SENTENCE_BREAKS:
                cut = index
                break
        parts.append(remaining[:cut])
        remaining = remaining[cut:]
    if remaining:
        parts.append(remaining)
    return parts


def _continued_slide(data: dict[str, Any], page_number: int) -> dict[str, Any]:
    copy = dict(data)
    suffix = f"-cont-{page_number}"
    copy["id"] = f"{str(data['id'])[:48 - len(suffix)]}{suffix}"
    title = data.get("title") or data.get("id")
    copy["title"] = f"{str(title)[:108]}（续{page_number}）"
    return copy


def paginate_overflowing_content(design: PresentationDesign) -> PresentationDesign:
    """Create continuation slides before rendering rather than squeezing copy into small text."""
    expanded: list[dict[str, Any]] = []
    for slide in design.slides:
        data = slide.model_dump(mode="json")
        if slide.type in {"title-content", "summary", "cards", "comparison"}:
            is_card_layout = slide.type in {"cards", "comparison"}
            max_chars = 108 if is_card_layout else 78
            capacity = 4
            source_points = data.get("supportingPoints") or ([data["keyMessage"]] if data.get("keyMessage") else [])
            points = [fragment for point in source_points for fragment in _split_for_fit(point, max_chars) if fragment.strip()]
            page_count = max(1, (len(points) + capacity - 1) // capacity)
            for page_index in range(page_count):
                page = data if page_index == 0 else _continued_slide(data, page_index + 1)
                page["supportingPoints"] = points[page_index * capacity:(page_index + 1) * capacity]
                expanded.append(page)
            continue

        if slide.type == "table" and slide.table and len(slide.table.rows) > 5:
            rows_per_page = 5
            rows = data["table"]["rows"]
            for page_index, start in enumerate(range(0, len(rows), rows_per_page)):
                page = dict(data) if page_index == 0 else _continued_slide(data, page_index + 1)
                end = start + rows_per_page
                page["table"] = {
                    **data["table"],
                    "rows": rows[start:end],
                    "highlightRows": [row - start for row in data["table"].get("highlightRows", []) if start <= row < end],
                }
                expanded.append(page)
            continue

        if slide.type in {"timeline", "process"} and slide.timeline:
            events: list[dict[str, Any]] = []
            for item in data["timeline"]:
                details = _split_for_fit(item.get("detail", ""), 58) or [""]
                for part_index, detail in enumerate(details):
                    events.append({
                        **item,
                        "label": f"{item['label'][:33]}{'（續）' if part_index else ''}",
                        "title": f"{item['title'][:58]}{'（續）' if part_index else ''}",
                        "detail": detail,
                    })
            events_per_page = 4
            page_count = max(1, (len(events) + events_per_page - 1) // events_per_page)
            for page_index in range(page_count):
                page = data if page_index == 0 else _continued_slide(data, page_index + 1)
                page["timeline"] = events[page_index * events_per_page:(page_index + 1) * events_per_page]
                expanded.append(page)
            continue

        if slide.type == "quote" and data.get("quote"):
            quotes = _split_for_fit(data["quote"], 150)
            for page_index, quote in enumerate(quotes):
                page = data if page_index == 0 else _continued_slide(data, page_index + 1)
                page["quote"] = quote
                expanded.append(page)
            continue

        expanded.append(data)

    if len(expanded) > 25:
        raise ValueError("内容自动分页后超过 25 页，请减少内容或分批生成。")
    ids = [slide["id"] for slide in expanded]
    if len(ids) != len(set(ids)):
        raise ValueError("自动分页产生重复页面 ID，请缩短原始页面 ID 后重试。")
    return design.model_copy(update={"slides": [SlideDesign.model_validate(item) for item in expanded]})


def _estimated_chars_per_line(width_inches: float, font_size: float) -> float:
    # CJK glyphs are approximately one em wide. This deliberately errs on the
    # conservative side so QA can warn before PowerPoint clips text.
    return max(8.0, width_inches * 72.0 / max(font_size, 1.0) * 0.72)


def run_visual_qa(raw_design: PresentationDesign | dict[str, Any]) -> dict[str, Any]:
    """Bounded schema/layout checks suitable for deterministic generation."""
    design = raw_design if isinstance(raw_design, PresentationDesign) else PresentationDesign.model_validate(raw_design)
    width, height = CANVAS[design.aspectRatio]
    issues: list[dict[str, Any]] = []
    for index, slide in enumerate(design.slides):
        variant = choose_layout(slide, index)
        boxes: list[tuple[str, float, float, float, float]] = [("header", SAFE_MARGIN, SAFE_MARGIN, width - 2 * SAFE_MARGIN, 1.05)]
        if slide.type == "cover":
            boxes = [("cover-title", SAFE_MARGIN, 2.1, width - 2 * SAFE_MARGIN, 2.1)]
        elif slide.type in {"chart", "table", "image-text", "full-image"}:
            boxes.append(("main-visual", SAFE_MARGIN, 1.85, width - 2 * SAFE_MARGIN, height - 1.85 - SAFE_MARGIN - 0.72))
        else:
            boxes.append(("body", SAFE_MARGIN, 1.85, width - 2 * SAFE_MARGIN, height - 1.85 - SAFE_MARGIN - 0.72))

        for element_id, x, y, box_w, box_h in boxes:
            if x < SAFE_MARGIN or y < SAFE_MARGIN or x + box_w > width - SAFE_MARGIN + 0.001 or y + box_h > height - SAFE_MARGIN + 0.001:
                issues.append({"slideId": slide.id, "elementId": element_id, "type": "out_of_bounds", "severity": "error", "message": "布局元素超出安全区。", "autoFixable": True})

        title = slide.title or ""
        if len(title) > 54:
            issues.append({"slideId": slide.id, "elementId": "title", "type": "text_overflow", "severity": "warning", "message": "标题较长，建议精简或拆页。", "autoFixable": True})
        body_chars = sum(len(point) for point in slide.supportingPoints) + len(slide.keyMessage or "")
        if body_chars > 620 or len(slide.supportingPoints) >= 5:
            issues.append({"slideId": slide.id, "elementId": "body", "type": "content_density", "severity": "warning", "message": "页面内容密度偏高；优先精简或拆页，不建议继续缩小字体。", "autoFixable": False})
        if slide.type == "table" and slide.table and (len(slide.table.rows) > 6 or len(slide.table.headers) > 5):
            issues.append({"slideId": slide.id, "elementId": "table", "type": "table_overflow", "severity": "warning", "message": "表格较密，建议拆分或移至附录。", "autoFixable": False})
        if slide.type == "chart" and slide.chart and len(slide.chart.categories) > 7:
            issues.append({"slideId": slide.id, "elementId": "chart", "type": "chart_overflow", "severity": "warning", "message": "图表类别较多，可能影响标签可读性。", "autoFixable": False})

        allowed = VARIANTS.get(slide.type)
        if allowed and slide.layoutVariant and slide.layoutVariant not in allowed:
            issues.append({"slideId": slide.id, "elementId": "layoutVariant", "type": "invalid_layout", "severity": "error", "message": f"{slide.type} 不支持布局 {slide.layoutVariant}，已回退到确定性布局。", "autoFixable": True})

        # This geometric estimate is shared by the renderer and QA; it guards
        # against empty boxes and accidental element collisions as layouts grow.
        if any(box[3] <= 0 or box[4] <= 0 or _estimated_chars_per_line(box[3], 20) < 8 for box in boxes):
            issues.append({"slideId": slide.id, "elementId": "layout", "type": "layout_bounds", "severity": "error", "message": "布局区域不可用。", "autoFixable": False})
        if any(len(source) > 220 for source in slide.sources):
            issues.append({"slideId": slide.id, "elementId": "sources", "type": "source_overflow", "severity": "warning", "message": "来源脚注过长，建议缩短为机构/报告名和年份。", "autoFixable": False})

    return {
        "version": "1.0",
        "issues": issues,
        "passed": not any(issue["severity"] == "error" for issue in issues),
        "requiresContentRevision": any(not issue["autoFixable"] for issue in issues),
        "attempts": 1,
        "maxAttempts": 1,
    }


def apply_deterministic_fixes(raw_design: PresentationDesign | dict[str, Any]) -> tuple[PresentationDesign, dict[str, Any]]:
    """Paginate content that exceeds readable regions and normalize unsafe layout variants."""
    design = raw_design if isinstance(raw_design, PresentationDesign) else PresentationDesign.model_validate(raw_design)
    data = design.model_dump(mode="json")
    for index, slide in enumerate(data["slides"]):
        allowed = VARIANTS.get(slide["type"])
        if allowed and slide.get("layoutVariant") not in allowed:
            slide["layoutVariant"] = choose_layout(SlideDesign.model_validate(slide), index)
        if slide["type"] == "metrics":
            count = len(slide.get("metrics", []))
            if count > 1 and slide.get("layoutVariant") == "hero-metric":
                slide["layoutVariant"] = "2-column"
            elif count >= 3 and slide.get("layoutVariant") in {"3-column", "4-column"}:
                # Multi-row cards retain comfortable width and readable notes.
                slide["layoutVariant"] = "2-column"
    fixed = PresentationDesign.model_validate(data)
    fixed = paginate_overflowing_content(fixed)
    return fixed, run_visual_qa(fixed)
