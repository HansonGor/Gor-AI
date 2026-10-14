"""Request-local PPT context selection and validated, immutable semantic patches."""
from __future__ import annotations

from contextvars import ContextVar
from copy import deepcopy
import hashlib
import json
import re
from typing import Any

from pydantic import BaseModel, ConfigDict, Field
from tools.presentation_design import PresentationDesign, SlideDesign


revision_source: ContextVar[dict | None] = ContextVar("presentation_revision_source", default=None)


def fingerprint(schema: dict) -> str:
    return hashlib.sha256(json.dumps(schema, ensure_ascii=False, sort_keys=True,
                                    separators=(",", ":")).encode()).hexdigest()


def saved_presentation(messages: list[dict], message_id: str | None = None) -> dict | None:
    """Resolve only persisted snapshots in this session; never read live project files."""
    for message in reversed(messages):
        if message_id and str(message.get("message_id") or message.get("id")) != message_id:
            continue
        snapshot = message.get("preview_snapshot")
        if (message.get("role") == "assistant" and isinstance(snapshot, dict)
                and snapshot.get("template") == "presentation"
                and isinstance(snapshot.get("presentationSchema"), dict)):
            return deepcopy(snapshot["presentationSchema"])
    return None


class SlideUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    slideId: str
    changes: dict[str, Any]


class PresentationRevision(BaseModel):
    model_config = ConfigDict(extra="forbid")
    baseFingerprint: str = Field(pattern=r"^[a-f0-9]{64}$")
    updates: list[SlideUpdate] = Field(default_factory=list, max_length=25)
    deckChanges: dict[str, Any] = Field(default_factory=dict)
    appendSlides: list[SlideDesign] = Field(default_factory=list, max_length=25)
    removeSlideIds: list[str] = Field(default_factory=list, max_length=25)


def _merge(source: dict, changes: dict) -> dict:
    result = deepcopy(source)
    for key, value in changes.items():
        if isinstance(value, dict) and isinstance(result.get(key), dict):
            result[key] = _merge(result[key], value)
        else:
            result[key] = deepcopy(value)
    return result


def merge_revision(source: dict | None, revision: dict) -> tuple[dict, set[str]]:
    patch = PresentationRevision.model_validate(revision)
    if source is None or fingerprint(source) != patch.baseFingerprint:
        raise ValueError("PPT 修改基准缺失或不匹配，请使用本轮提供的快照指纹。")
    base = PresentationDesign.model_validate(source).model_dump(mode="json")
    if set(patch.deckChanges) - (set(PresentationDesign.model_fields) - {"slides", "version", "referencePlan"}):
        raise ValueError("不允许修改未知或系统生成的整稿字段。")
    updates = {update.slideId: update.changes for update in patch.updates}
    ids = {slide["id"] for slide in base["slides"]}
    removed = set(patch.removeSlideIds)
    if len(updates) != len(patch.updates) or len(removed) != len(patch.removeSlideIds):
        raise ValueError("页面修改或删除 ID 重复。")
    if not set(updates).issubset(ids) or not removed.issubset(ids) or set(updates) & removed:
        raise ValueError("修改或删除的页面不存在，或同一页面同时修改和删除。")
    for changes in updates.values():
        if not changes or "id" in changes or set(changes) - set(SlideDesign.model_fields):
            raise ValueError("页面补丁必须包含有效字段，不能改变页面 ID。")
    result = _merge(base, patch.deckChanges)
    result["slides"] = [_merge(slide, updates.get(slide["id"], {}))
                        for slide in base["slides"] if slide["id"] not in removed]
    result["slides"].extend(slide.model_dump(mode="json") for slide in patch.appendSlides)
    if not (updates or removed or patch.appendSlides or patch.deckChanges):
        raise ValueError("PPT 补丁没有任何修改。")
    PresentationDesign.model_validate(result)
    affected = set(updates) | {slide.id for slide in patch.appendSlides}
    # Overflow continuations form one logical page: recompose that group together
    # so the paginator cannot copy an untouched continuation into its parent.
    roots = {re.sub(r"-cont-\d+$", "", slide_id) for slide_id in affected | removed}
    affected.update(slide["id"] for slide in result["slides"]
                    if re.sub(r"-cont-\d+$", "", slide["id"]) in roots)
    if patch.deckChanges:
        affected = {slide["id"] for slide in result["slides"]}
    return result, affected


def restore_unaffected(design: PresentationDesign, original: PresentationDesign,
                       affected: set[str]) -> PresentationDesign:
    """Keep untouched semantic pages, including existing continuation pages, exact."""
    original_ids = {slide.id for slide in original.slides}
    slides = []
    emitted = set()
    for slide in original.slides:
        if slide.id in emitted:
            continue
        if slide.id not in affected:
            slides.append(slide.model_copy(deep=True))
            continue
        candidates = [item for item in design.slides if item.id == slide.id or
                      (item.id.startswith(slide.id + "-cont-") and
                       (item.id not in original_ids or item.id in affected))]
        if not any(item.id == slide.id for item in candidates):
            root = re.sub(r"-cont-\d+$", "", slide.id)
            if root != slide.id and root in affected and root in emitted:
                continue  # The paginator merged this continuation back into its parent.
            raise ValueError("局部修改重排后页面缺失，未生成新快照。")
        slides.extend(candidates)
        emitted.update(item.id for item in candidates)
    payload = design.model_dump(mode="json")
    payload["slides"] = [slide.model_dump(mode="json") for slide in slides]
    return PresentationDesign.model_validate(payload)


def select_context(request: str, schema: dict | None, *, exact_source: bool = False) -> dict | None:
    if not schema:
        return ({"mode": "source-required", "instruction": "指定的 PPT 消息快照在当前会话中不存在，请确认目标消息。"}
                if exact_source else None)
    if not exact_source and re.search(r"第一份|最初|之前那份|更早|倒数|上一份", request):
        return {"mode": "source-required", "instruction": "当前默认快照不是用户明确指定的历史版本。先确认目标消息，不能用最近稿件冒充所指旧稿。"}
    # Carry-over/new-topic requests must not inherit the old deck's entire content.
    carry = bool(re.search(r"同样|相同|沿用|一样|照着|保持.*(?:预算|天数|风格)", request))
    new = bool(re.search(r"新建|新做|另一份|重新做|换个主题|换.*(?:目的地|城市|主题)|(?:我想|我要).*去", request))
    edit = bool(re.search(r"修改|调整|优化|改|替换|删除|去掉|增加|添加|放大|缩小|再大|再小|深|浅", request))
    if new or (carry and not edit):
        if not carry:
            return None
        constraints = []
        for slide in schema.get("slides", []):
            for key in ("title", "subtitle", "keyMessage", "supportingPoints"):
                values = slide.get(key) or []
                values = values if isinstance(values, list) else [values]
                constraints.extend(value for value in values if isinstance(value, str) and
                                   re.search(r"预算|\d+\s*[天日夜]|\d+\s*元|风格", value))
        data = {"mode": "carry-requirements", "theme": schema.get("theme"),
                "aspectRatio": schema.get("aspectRatio"),
                "requirementsEvidence": list(dict.fromkeys(constraints)),
                "instruction": "仅结合用户明确沿用的要求；旧目的地、正文和来源不代表新任务事实。新稿使用 presentation 完整参数。"}
        if re.search(r"风格|样式|设计|视觉|配色", request):
            data.update({key: deepcopy(schema[key]) for key in ("designDNA", "artDirection") if key in schema})
        return data
    if not edit and not re.search(r"这份|这套|这个.*(?:PPT|演示)|继续", request, re.I):
        return None
    slides = schema.get("slides", [])
    selected = set()
    if "封面" in request and slides:
        selected.add(0)
    if re.search(r"最后一页|末页|结尾页", request) and slides:
        selected.add(len(slides) - 1)
    for match in re.finditer(r"第\s*(\d+)\s*页", request):
        index = int(match[1]) - 1
        if 0 <= index < len(slides):
            selected.add(index)
    # Ambiguous/range/global edits retain the entire source rather than guessing.
    if re.search(r"整|全部|所有|每页|主题|风格|背景|第.*(?:到|至|[-—、]).*页", request):
        selected.clear()
    # Reference retrieval/ranking is derived server-side, not user requirements.
    data = {key: deepcopy(value) for key, value in schema.items() if key not in {"slides", "referencePlan"}}
    data.update(mode="revision", baseFingerprint=fingerprint(schema),
                slideManifest=[{"page": index + 1, "id": slide.get("id"), "title": slide.get("title")}
                               for index, slide in enumerate(slides)],
                slides=[deepcopy(slide) for index, slide in enumerate(slides) if not selected or index in selected],
                instruction="使用 revision 补丁，只提交实际修改字段，未提供页面由服务端保留。baseFingerprint 必须原样传回。不要用选中页面拼成完整新稿。若要重做整稿，可使用 presentation 完整参数。")
    return data
