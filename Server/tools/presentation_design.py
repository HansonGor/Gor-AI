"""Versioned Presentation Design Schema, theme tokens, layouts and deterministic QA."""

from __future__ import annotations

import re
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator
from tools.presentation_motion import MotionLanguage, SlideTransition, AnimationSpec, AnimationCue, AnimationGroup
from tools.presentation_reference import ReferencePlan


ThemeName = Literal["modern-light", "modern-dark", "business", "minimal", "technology"]
SlideType = Literal[
    "cover", "section", "title-content", "image-text", "full-image", "big-number",
    "metrics", "comparison", "timeline", "process", "cards", "chart", "table", "quote", "summary",
]
SlideRole = Literal["hero", "statement", "evidence", "data", "explanation", "comparison", "breath", "transition", "emotional", "summary"]
Density = Literal["low", "medium", "high"]
Whitespace = Literal["compact", "balanced", "generous", "dramatic"]
ImageRole = Literal["hero", "background", "editorial", "product", "supporting", "texture", "none"]
LayoutFamily = Literal["editorial", "hero", "data", "split", "minimal", "cards", "comparison", "full-bleed", "statement", "diagram"]


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ArtDirection(StrictModel):
    """Deck-wide visual direction, deliberately semantic rather than geometric."""
    mood: list[str] = Field(default_factory=lambda: ["restrained", "clear"], max_length=5)
    visualLanguage: str = Field(default="editorial composition with deliberate whitespace", max_length=240)
    typographyDirection: str = Field(default="clear typographic hierarchy; vary headline scale by page role", max_length=180)
    imageDirection: str = Field(default="use specific editorial imagery selectively; avoid generic stock backgrounds", max_length=180)
    compositionDirection: str = Field(default="use aligned grid with occasional controlled asymmetry", max_length=180)
    colorDirection: str = Field(default="use theme colors with one restrained accent", max_length=160)
    densityDirection: str = Field(default="alternate quiet pages with evidence-rich pages", max_length=160)
    decorationDirection: str = Field(default="minimal decoration", max_length=160)
    chartDirection: str = Field(default="emphasize the one insight that matters", max_length=160)
    narrativeRhythm: list[str] = Field(default_factory=list, max_length=25)
    visualRhythm: list[int] = Field(default_factory=list, max_length=25)
    avoidPatterns: list[str] = Field(default_factory=lambda: ["card wall", "repeated three-column layout", "background photo on every slide", "subtitle on every slide"], max_length=12)

    @model_validator(mode="after")
    def validate_rhythm(self):
        if any(level < 1 or level > 5 for level in self.visualRhythm):
            raise ValueError("ArtDirection.visualRhythm 每项必须在 1 到 5 之间。")
        return self


class DesignDNA(StrictModel):
    """Behavioral design tokens; these guide deterministic layout selection."""
    density: Density = "medium"
    alignment: Literal["left", "center", "asymmetric", "grid"] = "left"
    whitespace: Whitespace = "balanced"
    typographyScale: Literal["restrained", "balanced", "oversized"] = "balanced"
    imageTreatment: Literal["editorial", "cinematic", "documentary", "minimal"] = "editorial"
    cornerStyle: Literal["sharp", "subtle", "rounded"] = "subtle"
    decorationLevel: Literal["minimal", "restrained", "expressive"] = "restrained"
    contrast: Literal["soft", "balanced", "high"] = "balanced"
    chartStyle: Literal["editorial", "restrained", "analytical"] = "editorial"
    compositionStyle: Literal["editorial", "consulting", "dramatic", "minimal"] = "editorial"
    asymmetry: Literal["none", "low", "medium", "high"] = "low"
    visualRhythm: Literal["varied", "steady", "dramatic"] = "varied"


class ReferenceDesignProfile(StrictModel):
    """Extension point for later reference-deck analysis; not a cloning claim."""
    typography: list[str] = Field(default_factory=list, max_length=8)
    colorPalette: list[str] = Field(default_factory=list, max_length=12)
    spacing: str | None = Field(default=None, max_length=80)
    imageRatio: str | None = Field(default=None, max_length=80)
    alignment: str | None = Field(default=None, max_length=80)
    cornerStyle: str | None = Field(default=None, max_length=80)
    chartStyle: str | None = Field(default=None, max_length=80)
    layoutRhythm: list[str] = Field(default_factory=list, max_length=25)


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
    chartInsight: str | None = Field(default=None, max_length=160)
    highlightSeries: str | None = Field(default=None, max_length=40)
    highlightPoint: str | None = Field(default=None, max_length=40)
    annotation: str | None = Field(default=None, max_length=120)

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
    visualRole: Literal["hero", "editorial", "timeline", "data", "list", "statement", "closing"] | None = None
    focalPoint: Literal["image", "title", "number", "chart", "content"] | None = None
    composition: Literal["image-dominant", "text-dominant", "split", "full-bleed", "progressive"] | None = None
    motionRole: Literal["minimal", "reveal", "progressive", "emphasis"] | None = None
    semanticOrder: list[str] = Field(default_factory=list, max_length=12)
    readingOrder: list[str] = Field(default_factory=list, max_length=12)
    animationOrder: list[str] = Field(default_factory=list, max_length=12)
    supportingPoints: list[str] = Field(default_factory=list, max_length=5)
    visualIntent: str | None = Field(default=None, max_length=180)
    imageQuery: str | None = Field(default=None, max_length=120)
    dataIntent: str | None = Field(default=None, max_length=120)
    layoutVariant: str | None = Field(default=None, max_length=32)
    objective: str | None = Field(default=None, max_length=180)
    slideRole: SlideRole | None = None
    contentDensity: Density | None = None
    visualIntensity: int | None = Field(default=None, ge=1, le=5)
    transitionRole: Literal["open", "build", "contrast", "pause", "resolve", "close"] | None = None
    layoutFamily: LayoutFamily | None = None
    imageRole: ImageRole | None = None
    decorationBudget: Literal["none", "low", "medium"] | None = None
    metrics: list[Metric] = Field(default_factory=list, max_length=4)
    chart: ChartDesign | None = None
    table: TableDesign | None = None
    timeline: list[TimelineItem] = Field(default_factory=list, max_length=6)
    quote: str | None = Field(default=None, max_length=500)
    attribution: str | None = Field(default=None, max_length=80)
    emphasis: list[str] = Field(default_factory=list, max_length=5)
    sources: list[str] = Field(default_factory=list, max_length=4)
    transition: SlideTransition | None = None
    animations: dict[str, AnimationSpec] = Field(default_factory=dict)
    animationTimeline: list[AnimationCue] | None = Field(default=None, max_length=15)
    animationGroups: list[AnimationGroup] = Field(default_factory=list, max_length=20)
    persistentElements: dict[str, str] = Field(default_factory=dict)
    motionDisabled: bool = False

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
    artDirection: ArtDirection = Field(default_factory=ArtDirection)
    designDNA: DesignDNA = Field(default_factory=DesignDNA)
    referenceDesignProfile: ReferenceDesignProfile | None = None
    referencePlan: ReferencePlan | None = None
    motionLanguage: MotionLanguage | None = None
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
    "cover": {"editorial-left", "hero-center", "hero-split"},
    "section": {"statement-left", "statement-center"},
    "title-content": {"editorial-list", "statement", "quiet-copy"},
    "image-text": {"image-left", "image-right", "image-top", "image-background", "editorial-inset"},
    "full-image": {"full-bleed", "image-with-caption"},
    "big-number": {"center", "left", "split", "oversized-editorial", "minimal-number"},
    "metrics": {"2-column", "3-column", "4-column", "hero-metric", "editorial-ledger"},
    "comparison": {"two-column", "cards", "editorial-contrast", "split-evidence"},
    "timeline": {"horizontal", "editorial-steps"},
    "process": {"horizontal", "vertical-process"},
    "cards": {"2-column", "3-column", "4-column", "editorial-list"},
    "chart": {"editorial-chart", "chart-with-annotation", "minimal-chart"},
    "table": {"editorial-table", "compact-table"},
    "quote": {"quiet-quote", "statement-quote"},
    "summary": {"editorial-summary", "closing-statement"},
}

SLIDE_ROLES: set[str] = {"hero", "statement", "evidence", "data", "explanation", "comparison", "breath", "transition", "emotional", "summary"}


CANVAS = {"16:9": (13.333, 7.5), "4:3": (10.0, 7.5)}
SAFE_MARGIN = 0.62
MAX_QA_ROUNDS = 2


def resolve_theme(name: str) -> dict[str, Any]:
    """Return a copy so renderers cannot mutate the shared design tokens."""
    if name not in THEMES:
        raise ValueError(f"不支持的主题：{name}")
    return dict(THEMES[name])


def _default_role(slide: SlideDesign) -> str:
    by_type = {
        "cover": "hero", "section": "transition", "big-number": "data", "metrics": "data",
        "chart": "data", "table": "evidence", "comparison": "comparison", "cards": "explanation",
        "quote": "emotional", "summary": "summary", "full-image": "hero", "image-text": "explanation",
    }
    return by_type.get(slide.type, "breath" if not slide.supportingPoints else "explanation")


def _default_intensity(slide: SlideDesign, role: str, index: int) -> int:
    by_role = {"hero": 5, "statement": 4, "evidence": 3, "data": 4, "explanation": 3,
               "comparison": 3, "breath": 1, "transition": 2, "emotional": 4, "summary": 2}
    if role == "data" and slide.type == "big-number":
        return 5
    # Give otherwise-unplanned decks a deliberate, repeatable arc. Role remains
    # the primary signal; this small cadence prevents long runs of identical 3s.
    if role in {"explanation", "evidence"} and index > 0 and index % 3 == 2:
        return 2
    return by_role[role]


def _default_family(slide: SlideDesign, role: str, index: int, dna: DesignDNA) -> str:
    if role in {"hero", "emotional"}:
        return "hero" if slide.type in {"cover", "big-number", "full-image"} else "editorial"
    if role == "breath":
        return "minimal"
    if role == "data" or slide.type in {"chart", "table", "metrics", "big-number"}:
        return "data" if slide.type in {"chart", "table", "metrics"} else "minimal"
    if role == "comparison" or slide.type == "comparison":
        return "comparison"
    if slide.type in {"image-text", "full-image"}:
        return "split" if role != "hero" else "full-bleed"
    if slide.type in {"timeline", "process"}:
        return "diagram"
    if slide.type in {"cards"}:
        return "editorial" if dna.compositionStyle in {"editorial", "minimal"} else "cards"
    if role == "statement":
        return "statement"
    return "editorial" if dna.compositionStyle != "consulting" else "split"


def choose_layout(slide: SlideDesign, slide_index: int = 0, dna: DesignDNA | None = None) -> str:
    allowed = VARIANTS.get(slide.type)
    if allowed:
        if slide.layoutVariant in allowed:
            return str(slide.layoutVariant)
        role = slide.slideRole or _default_role(slide)
        family = slide.layoutFamily or _default_family(slide, role, slide_index, dna or DesignDNA())
        family_preferences = {
            "hero": {"cover": "hero-split", "big-number": "oversized-editorial", "full-image": "full-bleed"},
            "editorial": {"cover": "editorial-left", "title-content": "editorial-list", "comparison": "editorial-contrast", "cards": "editorial-list", "metrics": "editorial-ledger", "chart": "editorial-chart", "table": "editorial-table", "image-text": "editorial-inset", "summary": "editorial-summary", "quote": "quiet-quote"},
            "minimal": {"big-number": "minimal-number", "title-content": "statement", "summary": "closing-statement", "quote": "statement-quote"},
            "data": {"chart": "chart-with-annotation", "table": "editorial-table", "metrics": "editorial-ledger", "big-number": "left"},
            "split": {"image-text": "image-right", "big-number": "split", "comparison": "split-evidence", "cover": "hero-split"},
            "cards": {"cards": "2-column", "comparison": "cards", "metrics": "2-column"},
            "comparison": {"comparison": "editorial-contrast"},
            "full-bleed": {"full-image": "full-bleed", "image-text": "image-background", "cover": "hero-center"},
            "statement": {"section": "statement-left", "title-content": "statement", "quote": "statement-quote", "summary": "closing-statement"},
            "diagram": {"timeline": "editorial-steps", "process": "vertical-process"},
        }
        preferred_family = family_preferences.get(family, {}).get(slide.type)
        if preferred_family in allowed:
            return preferred_family
        defaults = {
            "cover": "editorial-left", "section": "statement-left", "title-content": "editorial-list",
            "image-text": "editorial-inset", "full-image": "image-with-caption", "big-number": "minimal-number",
            "comparison": "editorial-contrast", "metrics": "hero-metric" if len(slide.metrics) == 1 else "2-column",
            "cards": "editorial-list", "timeline": "editorial-steps", "process": "vertical-process",
            "chart": "editorial-chart", "table": "editorial-table", "quote": "quiet-quote", "summary": "editorial-summary",
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
            "objective": slide.objective or slide.eyebrow or slide.type,
            "keyMessage": slide.keyMessage or slide.title or "",
            "visualRole": slide.visualRole or _page_intent(slide, index == len(design.slides) - 1)["visualRole"],
            "focalPoint": slide.focalPoint or _page_intent(slide, index == len(design.slides) - 1)["focalPoint"],
            "composition": slide.composition or _page_intent(slide, index == len(design.slides) - 1)["composition"],
            "motionRole": slide.motionRole or _page_intent(slide, index == len(design.slides) - 1)["motionRole"],
            "semanticOrder": list(slide.semanticOrder),
            "readingOrder": list(slide.readingOrder),
            "animationOrder": list(slide.animationOrder),
            "slideRole": slide.slideRole or _default_role(slide),
            "contentDensity": slide.contentDensity or ("high" if len(slide.supportingPoints) >= 4 else "medium" if slide.supportingPoints else "low"),
            "visualIntensity": slide.visualIntensity or _default_intensity(slide, slide.slideRole or _default_role(slide), index),
            "transitionRole": slide.transitionRole or ("open" if index == 0 else "close" if index == len(design.slides) - 1 else "build"),
            "supportingPoints": list(slide.supportingPoints),
            "visualIntent": slide.visualIntent,
            "dataIntent": slide.dataIntent,
            "layoutFamily": slide.layoutFamily or _default_family(slide, slide.slideRole or _default_role(slide), index, design.designDNA),
            "layoutVariant": choose_layout(slide, index, design.designDNA),
            "imageRole": slide.imageRole or _default_image_role(slide),
        }
        for index, slide in enumerate(design.slides)
    ]


def _default_image_role(slide: SlideDesign) -> str:
    if slide.imageRole:
        return slide.imageRole
    if slide.type == "cover":
        return "hero"
    if slide.type == "full-image":
        return "background"
    if slide.type == "image-text":
        return "editorial"
    return "none"


_CLOCK_POINT = re.compile(r"^\s*(\d{1,2}[:：]\d{2})\s+(.+?)(?:[：:]\s*(.+))?\s*$")


def _chronological_points(slide: SlideDesign) -> list[TimelineItem]:
    """Promote already-written clock points to semantic events; never invent stops."""
    if slide.timeline:
        clocks = [re.match(r"^\s*(\d{1,2})[:：](\d{2})\s*$", item.label) for item in slide.timeline]
        if all(clocks):
            normalized = [item.model_copy(update={"label": f"{int(match.group(1)):02d}:{match.group(2)}"})
                          for item, match in zip(slide.timeline, clocks) if match]
            return sorted(normalized, key=lambda item: tuple(map(int, item.label.split(":"))))
        return slide.timeline
    if len(slide.supportingPoints) < 3:
        return []
    parsed = [_CLOCK_POINT.match(point) for point in slide.supportingPoints]
    if any(match is None for match in parsed):
        return []
    times = [match.group(1).replace("：", ":") for match in parsed if match]
    if times != sorted(times, key=lambda value: tuple(map(int, value.split(":")))):
        return []
    return [TimelineItem(label=f"{int(time.split(':')[0]):02d}:{time.split(':')[1]}", title=match.group(2)[:64], detail=(match.group(3) or "")[:140])
            for time, match in zip(times, parsed) if match]


def _page_intent(slide: SlideDesign, is_last: bool) -> dict[str, Any]:
    has_timeline = bool(slide.timeline)
    visual_role = slide.visualRole or (
        "closing" if is_last and slide.type == "summary" else
        "timeline" if has_timeline else
        "data" if slide.type in {"big-number", "metrics", "chart", "table"} or slide.table else
        "list" if slide.type in {"cards", "title-content"} and len(slide.supportingPoints) >= 3 else
        "hero" if slide.type in {"cover", "full-image"} else
        "statement" if slide.type in {"section", "quote"} or slide.slideRole == "breath" else "editorial"
    )
    focal = slide.focalPoint or ("number" if slide.metrics else "chart" if slide.chart else "image" if slide.imageRole not in {None, "none"} and visual_role in {"hero", "editorial"} else "title" if visual_role in {"statement", "closing"} else "content")
    composition = slide.composition or ("progressive" if visual_role == "timeline" else "full-bleed" if slide.type == "full-image" else "image-dominant" if focal == "image" and slide.contentDensity == "low" else "split" if slide.imageRole not in {None, "none"} else "text-dominant")
    motion = slide.motionRole or ("progressive" if visual_role in {"timeline", "list"} else "emphasis" if focal in {"number", "chart"} else "minimal" if visual_role in {"closing", "statement"} else "reveal")
    targets = ([f"step-{index}" for index in range(len(slide.timeline))] if has_timeline else
               [f"metric-{index}" for index in range(len(slide.metrics))] if slide.metrics else
               ["chart-group"] if slide.chart else
               ["table-group"] if slide.table else
               [f"card-{index}" for index in range(len(slide.supportingPoints))] if slide.type in {"cards", "comparison"} else
               [f"point-{index}" for index in range(len(slide.supportingPoints))])
    semantic_order = slide.semanticOrder if set(slide.semanticOrder) == set(targets) and len(slide.semanticOrder) == len(targets) else targets
    default_reading = ["headline", *semantic_order] if visual_role != "closing" else ["headline"]
    reading_order = slide.readingOrder if set(slide.readingOrder) == set(default_reading) and len(slide.readingOrder) == len(default_reading) else default_reading
    return {"visualRole": visual_role, "focalPoint": focal, "composition": composition,
            "motionRole": motion, "semanticOrder": semantic_order, "readingOrder": reading_order,
            "animationOrder": slide.animationOrder if set(slide.animationOrder) == set(reading_order) and len(slide.animationOrder) == len(reading_order) else reading_order}


def compose_design(raw_design: PresentationDesign | dict[str, Any]) -> PresentationDesign:
    """Complete semantic plans with a deterministic, deck-aware composition."""
    design = raw_design if isinstance(raw_design, PresentationDesign) else PresentationDesign.model_validate(raw_design)
    slides: list[SlideDesign] = []
    intensity_plan: list[int] = []
    role_plan: list[str] = []
    for index, slide in enumerate(design.slides):
        role = slide.slideRole or _default_role(slide)
        if design.artDirection.narrativeRhythm and index < len(design.artDirection.narrativeRhythm):
            proposed_role = design.artDirection.narrativeRhythm[index].lower()
            if proposed_role in SLIDE_ROLES and slide.slideRole is None:
                role = proposed_role
        intensity = slide.visualIntensity or (
            design.artDirection.visualRhythm[index]
            if index < len(design.artDirection.visualRhythm)
            else _default_intensity(slide, role, index)
        )
        intensity = max(1, min(5, intensity))
        density = slide.contentDensity or ("high" if len(slide.supportingPoints) >= 4 or slide.type in {"table", "chart"} else "medium" if slide.supportingPoints else "low")
        family = slide.layoutFamily or _default_family(slide, role, index, design.designDNA)
        transition = slide.transitionRole or ("open" if index == 0 else "close" if index == len(design.slides) - 1 else "pause" if role == "breath" else "contrast" if intensity >= 4 and index and intensity_plan[-1] <= 2 else "build")
        image_role = _default_image_role(slide)
        timeline = _chronological_points(slide)
        normalized = slide.model_copy(update={
            "slideRole": role, "visualIntensity": intensity, "contentDensity": density,
            "layoutFamily": family, "layoutVariant": choose_layout(slide, index, design.designDNA),
            "transitionRole": transition, "imageRole": image_role,
            "objective": slide.objective or slide.eyebrow or slide.keyMessage or slide.title or slide.type,
            "decorationBudget": slide.decorationBudget or ("none" if intensity <= 2 or design.designDNA.decorationLevel == "minimal" else "low"),
            "timeline": timeline,
        })
        if timeline and [cue.target for cue in (slide.animationTimeline or []) if cue.target.startswith("step-")] != [f"step-{item_index}" for item_index in range(len(timeline))]:
            normalized = normalized.model_copy(update={"animationTimeline": None, "animationGroups": []})
        normalized = normalized.model_copy(update=_page_intent(normalized, index == len(design.slides) - 1))
        slides.append(normalized)
        intensity_plan.append(intensity)
        role_plan.append(role)
    # Repair only obvious three-page visual loops, choosing a semantic family
    # alternative per slide type. This is stable for a stable schema.
    family_alternatives = {
        "cover": ["editorial", "hero"], "title-content": ["statement", "minimal", "editorial"],
        "metrics": ["editorial", "cards", "data"], "comparison": ["editorial", "split", "comparison"],
        "cards": ["editorial", "split", "cards"], "image-text": ["split", "editorial", "full-bleed"],
        "big-number": ["minimal", "hero", "editorial"], "summary": ["statement", "editorial", "minimal"],
        "section": ["statement", "editorial", "minimal"], "chart": ["editorial", "data", "minimal"],
        "table": ["editorial", "data", "minimal"], "quote": ["statement", "editorial", "minimal"],
        "timeline": ["diagram", "editorial", "split"], "process": ["diagram", "editorial", "split"],
        "full-image": ["full-bleed", "hero", "editorial"],
    }
    for index in range(2, len(slides)):
        window = slides[index - 2:index + 1]
        signatures = [(item.visualIntensity, item.slideRole, item.layoutFamily) for item in window]
        if signatures[0] != signatures[1] or signatures[1] != signatures[2]:
            continue
        target = slides[index - 1]
        options = family_alternatives.get(target.type, ["editorial", "minimal"])
        replacement = next((family for family in options if family != target.layoutFamily), None)
        if replacement:
            slides[index - 1] = target.model_copy(update={
                "layoutFamily": replacement,
                "layoutVariant": choose_layout(target.model_copy(update={"layoutFamily": replacement, "layoutVariant": None}), index - 1, design.designDNA),
            })
    # A timeline is a story, not five paragraphs beside a photograph. Choose
    # among existing variants using adjacent real compositions, not randomness.
    for index, slide in enumerate(slides):
        if slide.type == "cards" and len(slide.supportingPoints) <= 4 and slide.imageRole == "none" and all(len(point) <= 70 for point in slide.supportingPoints):
            slides[index] = slide.model_copy(update={"layoutVariant": "editorial-list", "layoutFamily": "editorial"})
            continue
        if slide.type != "image-text":
            continue
        if slide.timeline:
            recent = sum(bool(previous.timeline) for previous in slides[max(0, index - 2):index])
            variant = ("image-top", "image-right", "image-left")[min(recent, 2)]
        elif slide.table:
            variant = "editorial-inset"
        elif slide.slideRole == "emotional" and slide.imageRole != "none":
            variant = "image-left"
        elif index >= 2 and all(previous.type == "image-text" and previous.layoutVariant == "image-right" for previous in slides[index - 2:index]):
            variant = "editorial-inset"
        else:
            continue
        slides[index] = slide.model_copy(update={"layoutVariant": variant})
    art = design.artDirection.model_copy(update={"narrativeRhythm": role_plan, "visualRhythm": intensity_plan})
    return design.model_copy(update={"slides": slides, "artDirection": art})


def anti_ai_pattern_report(raw_design: PresentationDesign | dict[str, Any], photo_keys: list[str] | None = None) -> dict[str, Any]:
    """Report measurable template-like repetition; this is not an AI detector."""
    design = raw_design if isinstance(raw_design, PresentationDesign) else PresentationDesign.model_validate(raw_design)
    slides = design.slides
    count = len(slides)
    if not count:
        return {"version": "1.0", "scores": {}, "issues": []}
    families = [slide.layoutFamily or _default_family(slide, slide.slideRole or _default_role(slide), index, design.designDNA) for index, slide in enumerate(slides)]
    variants = [choose_layout(slide, index, design.designDNA) for index, slide in enumerate(slides)]
    density = [slide.contentDensity or ("high" if slide.supportingPoints else "low") for slide in slides]
    subtitles = sum(bool(slide.subtitle) for slide in slides)
    images = [_default_image_role(slide) for slide in slides]
    card_slide = [
        slide.type in {"cards", "comparison", "metrics"}
        and (families[index] == "cards" or slide.layoutVariant in {"cards", "2-column", "3-column", "4-column"})
        for index, slide in enumerate(slides)
    ]
    card_wall_runs = sum(1 for i in range(2, count) if all(card_slide[j] for j in range(i - 2, i + 1)))
    repeated_layouts = sum(1 for a, b in zip(variants, variants[1:]) if a == b)
    repeated_families = sum(1 for a, b in zip(families, families[1:]) if a == b)
    density_mode_ratio = max(density.count(value) for value in set(density)) / count
    photo_reuse = 0.0
    if photo_keys:
        photo_reuse = max(photo_keys.count(value) for value in set(photo_keys)) / max(1, len(photo_keys))
    scores = {
        "repeatedLayoutScore": round(repeated_layouts / max(1, count - 1), 3),
        "repeatedFamilyScore": round(repeated_families / max(1, count - 1), 3),
        "cardWallScore": round(card_wall_runs / max(1, count - 2), 3),
        "densityUniformityScore": round(density_mode_ratio, 3),
        "backgroundPhotoRepetition": round(photo_reuse, 3),
        "subtitleRepetition": round(subtitles / count, 3),
        "backgroundPhotoRatio": round(sum(role == "background" for role in images) / count, 3),
    }
    issues: list[dict[str, Any]] = []
    if scores["repeatedLayoutScore"] > 0.5:
        issues.append({"type": "repeated-layout", "severity": "medium", "message": "相邻页面的版式重复偏多。"})
    if scores["repeatedFamilyScore"] > 0.65:
        issues.append({"type": "repeated-layout-family", "severity": "medium", "message": "连续页面集中在同一布局家族。"})
    if card_wall_runs:
        issues.append({"type": "card-wall", "severity": "medium", "message": "检测到连续卡片/指标页，建议打断网格节奏。"})
    if density_mode_ratio > 0.8 and count >= 5:
        issues.append({"type": "uniform-density", "severity": "low", "message": "整套页面的信息密度过于一致。"})
    if subtitles == count and count >= 3:
        issues.append({"type": "subtitle-on-every-slide", "severity": "low", "message": "每页都使用副标题，层级略显机械。"})
    if scores["backgroundPhotoRatio"] > 0.65:
        issues.append({"type": "background-photo-overuse", "severity": "medium", "message": "背景照片覆盖页数过多。"})
    if photo_reuse > 0.5 and len(photo_keys or []) >= 3:
        issues.append({"type": "reused-photo", "severity": "medium", "message": "同一张照片被多页重复使用。"})
    return {"version": "1.0", "scores": scores, "issues": issues}


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
    # A new continuation page owns a new choreography, not the original page's
    # target indices and click clock. Content is preserved, motion is replanned.
    copy["animationTimeline"] = None
    copy["animationGroups"] = []
    copy["persistentElements"] = {}
    return copy


def paginate_overflowing_content(design: PresentationDesign) -> PresentationDesign:
    """Create continuation slides before rendering rather than squeezing copy into small text."""
    expanded: list[dict[str, Any]] = []
    source_slides: list[SlideDesign] = []
    for slide in design.slides:
        if (source_slides and re.search(r"-cont-\d+$", slide.id)
                and slide.id.rsplit("-cont-", 1)[0] == source_slides[-1].id
                and slide.type == source_slides[-1].type
                and len(source_slides[-1].supportingPoints) + len(slide.supportingPoints) <= 5
                and sum(map(len, [*source_slides[-1].supportingPoints, *slide.supportingPoints])) <= 240):
            previous = source_slides[-1]
            source_slides[-1] = previous.model_copy(update={"supportingPoints": [*previous.supportingPoints, *slide.supportingPoints], "animationTimeline": None, "animationGroups": []})
            continue
        source_slides.append(slide)
    for slide in source_slides:
        data = slide.model_dump(mode="json")
        if slide.type in {"title-content", "summary", "cards", "comparison"}:
            is_card_layout = slide.type in {"cards", "comparison"}
            max_chars = 108 if is_card_layout else 78
            capacity = 5 if slide.type in {"title-content", "summary"} and len(slide.supportingPoints) == 5 and sum(map(len, slide.supportingPoints)) <= 240 else 4
            source_points = data.get("supportingPoints") or ([data["keyMessage"]] if data.get("keyMessage") else [])
            points = [fragment for point in source_points for fragment in _split_for_fit(point, max_chars) if fragment.strip()]
            page_count = max(1, (len(points) + capacity - 1) // capacity)
            sizes = [capacity] * page_count
            if page_count == 2 and len(points) == capacity + 1:
                sizes = [(len(points) + 1) // 2, len(points) // 2]
            cursor = 0
            for page_index, page_size in enumerate(sizes):
                page = data if page_index == 0 else _continued_slide(data, page_index + 1)
                page["supportingPoints"] = points[cursor:cursor + page_size]
                cursor += page_size
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
    design = compose_design(raw_design)
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

    pattern_report = anti_ai_pattern_report(design)
    return {
        "version": "1.0",
        "issues": issues,
        "passed": not any(issue["severity"] == "error" for issue in issues),
        "requiresContentRevision": any(not issue["autoFixable"] for issue in issues),
        "attempts": 1,
        "maxAttempts": MAX_QA_ROUNDS,
        "antiAIPatternReport": pattern_report,
        "designCritique": {"status": "rule-based", "issues": pattern_report["issues"]},
    }


def apply_deterministic_fixes(raw_design: PresentationDesign | dict[str, Any]) -> tuple[PresentationDesign, dict[str, Any]]:
    """Paginate content that exceeds readable regions and normalize unsafe layout variants."""
    design = compose_design(raw_design)
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
    fixed = compose_design(fixed)
    return fixed, run_visual_qa(fixed)
