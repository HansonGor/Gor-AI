"""Snapshot-owned motion schema, semantic choreography and deterministic Motion QA."""
from __future__ import annotations

from collections import Counter
from typing import Literal, Any

from pydantic import BaseModel, ConfigDict, Field

Token = Literal["fast", "normal", "slow"]
Effect = Literal["none", "appear", "fade", "rise", "wipe", "fly", "zoom", "grow", "pulse", "colorEmphasis", "fadeOut"]
Trigger = Literal["withPrevious", "afterPrevious", "onClick"]
Direction = Literal["up", "left", "right", "down"]
Distance = Literal["micro", "short", "medium"]
DURATION = {"fast": .24, "normal": .42, "slow": .72}
STAGGER = {"fast": .08, "normal": .12, "slow": .18}
DELAY = {"none": 0., "short": .08, "normal": .15, "long": .25}
DISTANCE = {"micro": .012, "short": .025, "medium": .045}


class MotionModel(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)


class MotionLanguage(MotionModel):
    style: Literal["minimal", "professional", "cinematic", "editorial", "dynamic", "data-driven"] = "professional"
    energy: Literal["low", "medium", "high"] = "medium"
    transitionFamily: Literal["smooth", "directional", "none"] = "smooth"
    entranceFamily: Literal["subtle-directional", "fade", "structured"] = "subtle-directional"
    stagger: Token = "normal"
    durationScale: float = Field(default=1, ge=.5, le=1.5)
    motionDistance: Distance = "short"
    useMorph: bool = True
    maxAnimatedGroupsPerSlide: int = Field(default=5, ge=1, le=5)
    playback: Literal["automatic", "onClick", "none"] = "automatic"


class SlideTransition(MotionModel):
    effect: Literal["none", "fade", "push", "wipe", "morph"] = "fade"
    duration: float = Field(default=.42, ge=0, le=10)
    direction: Direction = "left"
    requestedEffect: str | None = None
    fallbackReason: str | None = None


class AnimationSpec(MotionModel):
    effect: Effect = "fade"
    trigger: Trigger = "afterPrevious"
    duration: Token = "normal"
    delay: Literal["none", "short", "normal", "long"] = "short"
    order: int | None = Field(default=None, ge=1, le=100)
    direction: Direction = "up"
    distance: Distance = "short"


class AnimationGroup(MotionModel):
    target: str = Field(min_length=1, max_length=64)
    kind: Literal["text", "image", "metric", "chart", "table", "card", "step"] = "text"
    priority: int = Field(default=2, ge=1, le=5)
    persistentElementId: str | None = Field(default=None, max_length=64)


class AnimationCue(MotionModel):
    target: str = Field(min_length=1, max_length=64)
    effect: Effect
    trigger: Trigger = "afterPrevious"
    start: float = Field(default=0, ge=0, le=60)
    duration: float = Field(default=.42, ge=0, le=10)
    delay: float = Field(default=.08, ge=0, le=10)
    order: int = Field(ge=1, le=100)
    clickIndex: int = Field(default=0, ge=0, le=30)
    direction: Direction = "up"
    distance: Distance = "short"


# Only capabilities emitted and understood by the centralized renderers are
# advertised. Morph and chart sub-builds deliberately remain unsupported.
CAPABILITIES = {
    **{effect: {"pptxSupport": True, "previewSupport": True, "fallback": "fade"}
       for effect in ("none", "appear", "fade", "rise", "wipe", "fly", "zoom", "grow", "pulse", "colorEmphasis", "fadeOut")},
    "push": {"pptxSupport": True, "previewSupport": True, "fallback": "fade"},
    "morph": {"pptxSupport": False, "previewSupport": "crossfade approximation", "fallback": "fade"},
    "chartSeries": {"pptxSupport": False, "previewSupport": False, "fallback": "whole-chart wipe"},
}


def semantic_groups(slide, image_available: bool) -> list[AnimationGroup]:
    """Names bind semantic primitives to native shape groups and DOM wrappers."""
    groups: list[AnimationGroup] = []
    def add(target, kind="text", priority=2):
        groups.append(AnimationGroup(target=target, kind=kind, priority=priority,
                                     persistentElementId=slide.persistentElements.get(target)))
    if slide.slideRole == "breath" and slide.type not in {"cover", "full-image"}:
        add("statement", priority=5)
        return groups
    if slide.visualRole == "closing":
        if slide.title:
            add("headline", priority=5)
        return groups
    if slide.title:
        add("headline", priority=5)
    if slide.subtitle or slide.type in {"cover", "section"} and slide.keyMessage:
        add("subtitle", priority=2)
    if image_available and slide.imageRole not in {"none", "background", "texture"} and slide.type != "full-image" and not (slide.type == "cover" and slide.layoutVariant == "hero-center"):
        add("hero-image" if slide.type == "cover" else "product-image" if slide.type == "big-number" else "editorial-image", "image", 4)
    if slide.type == "big-number" and len(slide.metrics) == 1 and slide.layoutVariant in {"minimal-number", "oversized-editorial", "left"}:
        add("metric-0", "metric", 5)
        add("metric-label-0", priority=3)
        if slide.metrics[0].note:
            add("metric-insight-0", priority=2)
    elif slide.type in {"big-number", "metrics"}:
        for index, _ in enumerate(slide.metrics):
            add(f"metric-{index}", "metric", 4)
    elif slide.type == "chart":
        add("chart-group", "chart", 5)
        if slide.chart.annotation:
            add("chart-highlight", priority=3)
        if slide.chart.chartInsight:
            add("chart-insight", priority=3)
    elif slide.table:
        add("table-group", "table", 4)
    elif slide.timeline:
        for index, _ in enumerate(slide.timeline):
            add(f"step-{index}", "step", 3)
    elif slide.type in {"comparison", "cards"}:
        for index, _ in enumerate(slide.supportingPoints or ([slide.keyMessage] if slide.keyMessage else [])):
            add(f"card-{index}", "card", 3)
    elif slide.type == "quote":
        add("quote", priority=5)
        if slide.attribution:
            add("author", priority=2)
    elif slide.type not in {"cover", "section"}:
        for index, _ in enumerate(slide.supportingPoints or ([slide.keyMessage] if slide.keyMessage else [])):
            add(f"point-{index}", priority=3)
    return groups


def infer_language(design) -> MotionLanguage:
    dna = design.designDNA
    words = " ".join(design.artDirection.mood).lower()
    style = "cinematic" if dna.imageTreatment == "cinematic" or "cinematic" in words else "data-driven" if dna.compositionStyle == "consulting" else "minimal" if dna.compositionStyle == "minimal" else "editorial" if dna.compositionStyle == "editorial" else "professional"
    return MotionLanguage(style=style, energy="low" if style in {"minimal", "data-driven"} else "medium",
                          entranceFamily="structured" if style == "data-driven" else "subtle-directional")


def morph_eligible(previous, current) -> bool:
    if previous is None:
        return False
    shared = set(previous.persistentElements.values()) & set(current.persistentElements.values())
    if not shared or (previous.layoutVariant == current.layoutVariant and previous.layoutFamily == current.layoutFamily):
        return False
    # Identity alone cannot claim that two unrelated photos are one visual object.
    return bool(previous.imageQuery and previous.imageQuery == current.imageQuery or
                previous.metrics and [m.value for m in previous.metrics] == [m.value for m in current.metrics])


def schedule(cues: list[AnimationCue]) -> list[AnimationCue]:
    """Resolve trigger clusters exactly once for both renderers. Start is segment-local."""
    result = []
    click, cluster_start, cluster_end = 0, 0., 0.
    for index, cue in enumerate(cues):
        if cue.trigger == "onClick":
            click += 1
            cluster_start = cluster_end = 0.
        elif cue.trigger == "afterPrevious" and result:
            cluster_start = cluster_end
        start = round(cluster_start + cue.delay, 4)
        end = round(start + cue.duration, 4)
        cluster_end = max(cluster_end, end)
        result.append(cue.model_copy(update={"order": index + 1, "start": start, "clickIndex": click}))
    return result


def _plan(slide, language, groups) -> list[AnimationCue]:
    if slide.motionDisabled or language.playback == "none":
        return []
    available = {group.target: group for group in groups}
    if not available:
        return []
    style = language.style
    headline_effect = "fade" if style in {"minimal", "data-driven"} or language.entranceFamily == "fade" else "wipe" if style == "editorial" else "fly" if style == "dynamic" else "rise"
    ordered: list[tuple[str, str]] = []
    def use(target, effect):
        if target in available:
            ordered.append((target, effect))
    if "statement" in available:
        use("statement", "fade")
    elif slide.timeline:
        use("headline", "fade" if style in {"minimal", "data-driven"} else headline_effect)
        # The authored event sequence, not shape/XML/z-order, owns the reveal.
        for target in slide.semanticOrder or [f"step-{index}" for index in range(len(slide.timeline))]:
            if target.startswith("step-"):
                use(target, "appear" if style == "minimal" else "wipe")
    elif slide.type == "quote":
        use("headline", "fade")
        use("quote", "fade")
        use("author", "appear")
    elif slide.type == "big-number":
        for target in available:
            if target.startswith("metric-") and not target.startswith(("metric-label", "metric-insight")):
                use(target, "zoom" if style in {"cinematic", "dynamic", "professional"} else "wipe")
        use("metric-label-0", "fade")
        use("headline", "appear")
        use("metric-insight-0", "fade")
        use("product-image", "fade")
    else:
        use("hero-image", "zoom" if style == "cinematic" else "fade")
        use("headline", headline_effect)
        use("subtitle", "fade")
        if slide.type == "chart":
            use("chart-group", "wipe")
            use("chart-highlight", "appear")
            use("chart-insight", "fade")
        else:
            use("table-group", "wipe" if style == "data-driven" else "appear")
            use("editorial-image", "wipe" if style == "editorial" else "fade")
            for target, group in available.items():
                if target.startswith(("point-", "card-", "step-", "metric-")):
                    use(target, "appear" if style == "minimal" else "wipe" if style == "data-driven" or group.kind in {"step", "metric"} or slide.type == "comparison" else "rise")
    if language.entranceFamily == "fade":
        ordered = [(target, "fade") for target, _ in ordered]
    budget = (len(slide.timeline) + 1 if slide.timeline else
              min(language.maxAnimatedGroupsPerSlide, 1 if slide.slideRole == "breath" else 3 if style == "minimal" or language.energy == "low" else 4 if slide.contentDensity == "high" else 5))
    cues = []
    previous_kind = None
    stagger_index = 0
    for target, effect in ordered[:budget]:
        group = available[target]
        trigger = "withPrevious" if not cues else "afterPrevious"
        delay = .06 if cues else .08
        if group.kind in {"card", "metric"} and previous_kind == group.kind and cues:
            trigger = "withPrevious"
            stagger_index += 1
            delay = round(.06 + STAGGER[language.stagger] * stagger_index, 4)
        else:
            stagger_index = 0
        if language.playback == "onClick" and target.startswith(("point-", "card-", "step-", "metric-")):
            trigger, delay = "onClick", 0.
        duration = DURATION["slow" if style == "cinematic" and group.kind == "image" else "fast" if effect == "appear" else "normal"] * language.durationScale
        override = slide.animations.get(target)
        if override:
            effect, trigger = override.effect, override.trigger
            duration, delay = DURATION[override.duration] * language.durationScale, DELAY[override.delay]
        if slide.timeline and target.startswith("step-"):
            trigger = "onClick" if language.playback == "onClick" else "afterPrevious"
            delay = 0. if trigger == "onClick" else .08
        cues.append(AnimationCue(target=target, effect=effect, trigger=trigger, duration=round(min(.9, duration), 4),
                                 delay=delay, order=(len(cues) + 1) if slide.timeline else override.order if override and override.order else len(cues) + 1,
                                 direction=override.direction if override else "left" if effect == "wipe" else "up",
                                 distance=override.distance if override else language.motionDistance))
        previous_kind = group.kind
    # Explicit per-target specs can request a later emphasis/exit on existing content.
    for target, spec in slide.animations.items():
        if slide.timeline:
            continue  # Old image/shape specs cannot displace a route's final stop.
        if target in available and target not in {cue.target for cue in cues}:
            cues.append(AnimationCue(target=target, effect=spec.effect, trigger=spec.trigger,
                                     duration=DURATION[spec.duration] * language.durationScale,
                                     delay=DELAY[spec.delay], order=spec.order or len(cues) + 1,
                                     direction=spec.direction, distance=spec.distance))
    return schedule(sorted(cues, key=lambda cue: cue.order))


def inspect_motion(design) -> dict[str, Any]:
    issues: list[dict] = []
    def issue(code, slide_id, message, severity="warning"):
        issues.append({"code": code, "slideId": slide_id, "message": message, "severity": severity})
    signatures = []
    effects, transitions = [], []
    for slide in design.slides:
        timeline = slide.animationTimeline or []
        targets = {group.target for group in slide.animationGroups}
        if any(target not in targets for target in slide.persistentElements):
            issue("invalidPersistentTarget", slide.id, "persistentElementId 引用不存在的语义对象。")
        if len(set(slide.persistentElements.values())) != len(slide.persistentElements):
            issue("duplicatePersistentIdentity", slide.id, "同一页多个不同对象不应共享 persistentElementId。")
        if slide.transition and slide.transition.effect == "morph":
            issue("unsupportedMorph", slide.id, "未支持的原生 Morph 未降级。", "error")
        allowed_budget = len(slide.timeline) + 1 if slide.timeline else design.motionLanguage.maxAnimatedGroupsPerSlide
        if len({cue.target for cue in timeline}) > allowed_budget:
            issue("tooManyAnimations", slide.id, "动画组数量超过语言预算。", "error")
        if slide.timeline:
            actual_steps = [cue.target for cue in timeline if cue.target.startswith("step-")]
            expected_steps = [target for target in (slide.semanticOrder or [f"step-{index}" for index in range(len(slide.timeline))]) if target.startswith("step-")]
            if actual_steps != expected_steps:
                issue("semanticOrderMismatch", slide.id, "路线或时间轴动画未严格按语义顺序出现。", "error")
        orders = [cue.order for cue in timeline]
        if len(orders) != len(set(orders)):
            issue("duplicateOrder", slide.id, "动画顺序重复。", "error")
        for cue in timeline:
            if cue.target not in targets:
                issue("invalidTarget", slide.id, f"不存在目标 {cue.target}。", "error")
            if not CAPABILITIES[cue.effect]["pptxSupport"]:
                issue("unsupportedEffect", slide.id, f"不支持效果 {cue.effect}。", "error")
            if cue.duration > .9 or cue.delay > .5:
                issue("longDuration", slide.id, "动画时长或等待过长。", "error")
        if len({cue.effect for cue in timeline if cue.effect != "none"}) > 3:
            issue("tooManyEffects", slide.id, "单页使用超过三种动画语言。")
        if len({cue.direction for cue in timeline if cue.effect in {"fly", "rise", "wipe"}}) > 2:
            issue("tooManyDirections", slide.id, "入场方向过多。")
        if timeline and max(cue.start + cue.duration for cue in timeline) > 6:
            issue("timelineTooLong", slide.id, "单页动画等待超过六秒。", "error")
        if sum(cue.effect == "fly" for cue in timeline) > 1:
            issue("excessiveFly", slide.id, "单页飞入过多。")
        if sum(cue.effect == "zoom" for cue in timeline) > 2:
            issue("excessiveZoom", slide.id, "单页缩放过多。")
        if len(timeline) > 1 and len({cue.delay for cue in timeline}) == 1:
            issue("sameDelay", slide.id, "出现时机缺少层级变化。")
        if len(timeline) > 1 and len({(cue.duration, cue.trigger, cue.delay) for cue in timeline}) == 1:
            issue("sameTiming", slide.id, "所有元素使用完全相同的节奏。")
        if len(timeline) > 1 and all(cue.effect == "fade" for cue in timeline) and slide.type not in {"quote", "section", "cover"} and slide.slideRole != "breath":
            issue("allFade", slide.id, "全页只有淡入，可按信息层级重新编排。")
        if timeline:
            expected = "metric-0" if slide.type == "big-number" else "hero-image" if slide.type == "cover" and "hero-image" in targets else "statement" if slide.slideRole == "breath" else "headline" if "headline" in targets else None
            if expected and timeline[0].target != expected:
                issue("hierarchyMismatch", slide.id, "显式顺序与默认叙事层级不同，请确认此修改意图。")
        signatures.append(tuple((cue.target.split("-")[0], cue.effect, cue.trigger, cue.delay) for cue in timeline))
        effects.extend(cue.effect for cue in timeline)
        transitions.append(slide.transition.effect if slide.transition else "none")
    if len(signatures) >= 3 and any(signatures[i] and signatures[i] == signatures[i + 1] == signatures[i + 2] for i in range(len(signatures) - 2)):
        issue("repeatedTimeline", None, "连续三页的动画编排完全相同。")
    if len(effects) >= 5 and all(effect == "fade" for effect in effects):
        issue("motionRepetition", None, "整套演示只有淡入。")
    if len(set(transitions) - {"none"}) > 2:
        issue("randomTransition", None, "整套演示使用了超过两个转场家族。")
    return {"passed": not any(item["severity"] == "error" for item in issues), "issues": issues,
            "effectCounts": dict(Counter(effects)), "transitionCounts": dict(Counter(transitions))}


def direct_motion(design, image_ids: set[str] | None = None):
    """Compile and repair motion into the same immutable PresentationDesign snapshot."""
    language = design.motionLanguage or infer_language(design)
    repairs = []
    slides = []
    image_ids = image_ids or set()
    previous = None
    chapter_effect = "push" if language.transitionFamily == "directional" or language.style in {"cinematic", "dynamic"} else "wipe"
    for slide in design.slides:
        groups = semantic_groups(slide, slide.id in image_ids)
        transition = slide.transition or SlideTransition(effect="none" if language.playback == "none" or slide.motionDisabled or language.transitionFamily == "none" else chapter_effect if previous and (slide.type == "section" or slide.slideRole == "transition") else "fade", duration=DURATION["slow" if slide.slideRole in {"hero", "breath", "emotional"} else "normal"] * language.durationScale)
        eligible = morph_eligible(previous, slide)
        if language.useMorph and eligible and slide.transition is None:
            transition = transition.model_copy(update={"effect": "morph"})
        if slide.motionDisabled or language.playback == "none":
            transition = transition.model_copy(update={"effect": "none"})
        if transition.effect == "morph":
            reason = "本版未输出原生 Morph，统一回退交叉淡化。" if eligible else "相邻页面缺少相同且可关联的 persistentElementId 或布局没有变化。"
            transition = transition.model_copy(update={"effect": "fade", "requestedEffect": "morph", "fallbackReason": reason})
            repairs.append({"code": "morphFallback", "slideId": slide.id, "message": reason})
        transition = transition.model_copy(update={"duration": min(.9, transition.duration)})
        generated = slide.animationTimeline is None
        cues = _plan(slide, language, groups) if generated else slide.animationTimeline
        valid = {group.target: group for group in groups}
        fixed = []
        seen = set()
        budget = (len(slide.timeline) + 1 if slide.timeline else
                  min(language.maxAnimatedGroupsPerSlide, 1 if slide.slideRole == "breath" else 4 if slide.contentDensity == "high" else 5))
        directions = Counter(cue.direction for cue in cues if cue.effect in {"fly", "rise", "wipe"})
        allowed_directions = {direction for direction, _ in directions.most_common(2)}
        used_effects, fly_count, zoom_count = set(), 0, 0
        for cue in sorted(cues, key=lambda item: item.order):
            if cue.target not in valid or cue.effect == "none" or slide.motionDisabled or language.playback == "none":
                repairs.append({"code": "invalidTarget" if cue.target not in valid else "removedAnimation", "slideId": slide.id, "message": f"移除目标 {cue.target} 的动画。"})
                continue
            if cue.target not in seen and len(seen) >= budget:
                repairs.append({"code": "animationBudget", "slideId": slide.id, "message": f"{cue.target} 超出预算，保持静态。"})
                continue
            effect = cue.effect
            if effect == "fly":
                fly_count += 1
                if fly_count > 1:
                    effect = "fade"
            if effect == "zoom":
                zoom_count += 1
                if zoom_count > 2:
                    effect = "fade"
            if len(used_effects) >= 3 and effect not in used_effects:
                effect = "fade" if "fade" in used_effects else next(iter(sorted(used_effects)))
            used_effects.add(effect)
            if effect == "colorEmphasis" and valid[cue.target].kind != "text":
                effect = "pulse"
                repairs.append({"code": "capabilityFallback", "slideId": slide.id, "message": "非文字对象颜色强调回退为轻微 pulse。"})
            direction = cue.direction if cue.effect not in {"fly", "rise", "wipe"} or not directions or cue.direction in allowed_directions else directions.most_common(1)[0][0]
            normalized = cue.model_copy(update={"effect": effect, "duration": min(.9, max(.02, cue.duration)), "delay": min(.5, cue.delay), "direction": direction, "distance": "short" if cue.distance == "medium" and language.energy != "high" else cue.distance})
            if normalized != cue:
                repairs.append({"code": "timingClamp", "slideId": slide.id, "message": "将持续时间、等待和距离约束到专业动画范围。"})
            seen.add(cue.target)
            fixed.append(normalized)
        fixed = schedule(fixed)
        if fixed and max(cue.start + cue.duration for cue in fixed) > 6:
            fixed = schedule([cue.model_copy(update={"delay": min(.15, cue.delay), "duration": min(.55, cue.duration)}) for cue in fixed])
            longest = max(cue.start + cue.duration for cue in fixed)
            if longest > 6:
                ratio = 5.9 / longest
                fixed = schedule([cue.model_copy(update={"delay": cue.delay * ratio, "duration": cue.duration * ratio}) for cue in fixed])
            repairs.append({"code": "timelineClamp", "slideId": slide.id, "message": "缩短时间轴以避免过长等待。"})
        # Deterministic role-aware variation on the third identical auto-planned
        # page. Explicit requested timelines and fade-only language stay intact.
        signature = lambda items: tuple((cue.target.split("-")[0], cue.effect, cue.trigger, cue.delay) for cue in items)
        if generated and language.entranceFamily != "fade" and len(slides) >= 2 and signature(fixed) == signature(slides[-1].animationTimeline) == signature(slides[-2].animationTimeline) and fixed:
            fixed = [cue.model_copy(update={"effect": "appear" if cue.target == "headline" else "wipe" if cue.target.startswith(("point-", "card-")) else cue.effect, "duration": min(.72, cue.duration + .04)}) for cue in fixed]
            fixed = schedule(fixed)
            repairs.append({"code": "rhythmVariation", "slideId": slide.id, "message": "第三个重复编排按内容层级改用直接呈现与定向揭示。"})
        slides.append(slide.model_copy(update={"transition": transition, "animationGroups": groups,
                                       "animationTimeline": fixed,
                                       "animationOrder": [cue.target for cue in fixed]}))
        previous = slide
    result = design.model_copy(update={"motionLanguage": language, "slides": slides})
    qa = inspect_motion(result)
    qa["repairs"] = repairs
    qa["capabilities"] = CAPABILITIES
    return result, qa
