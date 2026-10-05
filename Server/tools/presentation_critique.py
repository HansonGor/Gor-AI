"""Structured, bounded design critique using the existing Ark Vision client."""

from __future__ import annotations

import json
import re
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from config import config
from tools.presentation_design import PresentationDesign, SlideDesign, VARIANTS
from tools.presentation_render import RenderedSlide


class DesignCritiqueIssue(BaseModel):
    model_config = ConfigDict(extra="ignore")
    slideId: str | None = None
    type: str = "design-feedback"
    severity: str = "low"
    suggestion: str = Field(default="", max_length=240)


class DesignCritiquePatch(BaseModel):
    model_config = ConfigDict(extra="forbid")
    slideId: str
    field: str
    value: Any


class DesignCritiqueResult(BaseModel):
    model_config = ConfigDict(extra="ignore")
    status: str = "unavailable"
    issues: list[DesignCritiqueIssue] = Field(default_factory=list, max_length=30)
    patches: list[DesignCritiquePatch] = Field(default_factory=list, max_length=12)
    summary: str = Field(default="", max_length=500)


_PATCH_FIELDS = {"layoutFamily", "layoutVariant", "visualIntensity", "imageRole", "contentDensity", "decorationBudget"}
_PATCH_VALUES = {
    "layoutFamily": {"editorial", "hero", "data", "split", "minimal", "cards", "comparison", "full-bleed", "statement", "diagram"},
    "imageRole": {"hero", "background", "editorial", "product", "supporting", "texture", "none"},
    "contentDensity": {"low", "medium", "high"},
    "decorationBudget": {"none", "low", "medium"},
}


def critique_rendered_slides(slides: list[RenderedSlide], design: PresentationDesign) -> DesignCritiqueResult:
    """Review a small representative set. No image render means no pretend Vision QA."""
    if not slides:
        return DesignCritiqueResult(status="unavailable", summary="没有真实幻灯片图像，跳过 Vision 设计复核。")
    if not config.Ark.API_KEY.strip():
        return DesignCritiqueResult(status="unavailable", summary="Vision API 未配置，使用程序化 QA 兜底。")
    if len(slides) == 1:
        selected = slides
    else:
        indexes = sorted({0, len(slides) // 2, len(slides) - 1})
        selected = [slides[index] for index in indexes]
    images = ["data:image/png;base64," + __import__("base64").b64encode(item.image_bytes).decode("ascii") for item in selected]
    slide_manifest = [
        {"slideId": design.slides[item.index].id, "role": design.slides[item.index].slideRole,
         "intensity": design.slides[item.index].visualIntensity, "layoutFamily": design.slides[item.index].layoutFamily}
        for item in selected if item.index < len(design.slides)
    ]
    prompt = (
        "请以专业演示设计评审的视角检查这些真实渲染页，重点评估层级、留白、对比、焦点、节奏、重复、图片相关性、模板感和可读性。"
        "只返回 JSON 对象，不要 Markdown，格式为 {\"summary\":\"...\",\"issues\":[{\"slideId\":\"...\",\"type\":\"...\",\"severity\":\"low|medium|high\",\"suggestion\":\"...\"}],"
        "\"patches\":[{\"slideId\":\"...\",\"field\":\"layoutFamily|layoutVariant|visualIntensity|imageRole|contentDensity|decorationBudget\",\"value\":\"有限枚举值或1到5整数\"}]}。"
        "最多给出 4 个必要且可由 Schema 表达的安全 Patch；不要提供坐标、XML、文案重写或任意字段。"
        f"页面信息：{json.dumps(slide_manifest, ensure_ascii=False)}"
    )
    try:
        from models.vision import analyze_images
        response = analyze_images(images, prompt)
        content = response if isinstance(response, str) else ""
        content = re.sub(r"^\s*```(?:json)?|```\s*$", "", content.strip(), flags=re.IGNORECASE)
        start, end = content.find("{"), content.rfind("}")
        if start < 0 or end <= start:
            return DesignCritiqueResult(status="failed", summary="Vision 返回内容不是有效 JSON。")
        parsed = DesignCritiqueResult.model_validate_json(content[start:end + 1])
        parsed.status = "completed"
        valid_ids = {slide.id for slide in design.slides}
        parsed.patches = [patch for patch in parsed.patches if patch.slideId in valid_ids and patch.field in _PATCH_FIELDS]
        return parsed
    except Exception as exc:
        # QA must never block a deliverable. Keep the failure visible in metadata.
        return DesignCritiqueResult(status="failed", summary=f"Vision 设计复核失败，已回退程序化 QA：{type(exc).__name__}。")


def apply_safe_critique_patches(design: PresentationDesign, critique: DesignCritiqueResult) -> PresentationDesign:
    """Apply only allow-listed enum/intensity fields through runtime validation."""
    by_id = {slide.id: slide.model_dump(mode="json") for slide in design.slides}
    slide_types = {slide.id: slide.type for slide in design.slides}
    for patch in critique.patches:
        if patch.slideId not in by_id or patch.field not in _PATCH_FIELDS:
            continue
        value = patch.value
        if patch.field == "visualIntensity" and (not isinstance(value, int) or isinstance(value, bool) or not 1 <= value <= 5):
            continue
        if patch.field in _PATCH_VALUES and (not isinstance(value, str) or value not in _PATCH_VALUES[patch.field]):
            continue
        if patch.field == "layoutVariant" and (not isinstance(value, str) or value not in VARIANTS.get(slide_types[patch.slideId], set())):
            continue
        by_id[patch.slideId][patch.field] = value
        if patch.field == "layoutFamily":
            by_id[patch.slideId]["layoutVariant"] = None
    updated = design.model_copy(update={"slides": [SlideDesign.model_validate(by_id[slide.id]) for slide in design.slides]})
    return PresentationDesign.model_validate(updated.model_dump(mode="json"))
