"""Deterministic, metadata-only design references for editable presentations.

Sources contribute *abstract* design strengths.  This module never downloads,
copies or renders third-party templates, logos, pictures, or slide geometry.
"""

from __future__ import annotations

import re
from threading import RLock
from time import monotonic
from typing import Any, Literal, Protocol
from urllib.parse import urlparse

from pydantic import BaseModel, ConfigDict, Field


SourceId = Literal["pitch", "envato", "canva", "slidesgo", "slidescarnival", "microsoft", "officeplus", "ypppt"]


class ReferenceModel(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)


class PresentationBrief(ReferenceModel):
    topic: str = Field(max_length=200)
    language: Literal["zh", "en"] = "en"
    presentationType: str = "general"
    industry: str = "general"
    audience: str = "general"
    style: str = "professional"


class PresentationReferenceSource(ReferenceModel):
    id: SourceId
    name: str
    url: str
    baseWeight: float = Field(ge=0, le=1)
    strengths: tuple[str, ...]
    weaknesses: tuple[str, ...] = ()
    bestFor: tuple[str, ...]
    languageAffinity: tuple[str, ...]
    scenarioAffinity: dict[str, float]
    styleAffinity: dict[str, float]
    industryAffinity: dict[str, float]
    audienceAffinity: dict[str, float]
    formatAffinity: dict[str, float]
    expertise: dict[str, float]
    designCharacteristics: dict[str, str]
    referenceIntent: tuple[str, ...]
    retrievalMode: Literal["metadata-only", "manual-reference", "disabled-online-retrieval"] = "metadata-only"


class ReferenceWeight(ReferenceModel):
    source: SourceId
    baseWeight: float
    scenarioRelevance: float
    styleRelevance: float
    languageRelevance: float
    industryRelevance: float
    audienceRelevance: float
    formatRelevance: float
    retrievalRelevance: float = Field(ge=0, le=1)
    rawWeight: float
    finalWeight: float


class RetrievedReference(ReferenceModel):
    """Small public-search evidence record; never contains copied template data."""
    source: str
    title: str = Field(max_length=180)
    url: str = Field(max_length=500)
    snippet: str = Field(default="", max_length=360)


class LanguageCalibration(ReferenceModel):
    language: Literal["zh", "en"]
    fontFamily: str
    titleScale: float = Field(ge=.8, le=1.1)
    bodyLineSpacing: float = Field(ge=.9, le=1.3)
    guidance: str


class ReferencePlan(ReferenceModel):
    brief: PresentationBrief
    sourceWeights: list[ReferenceWeight] = Field(min_length=8, max_length=8)
    primarySources: list[SourceId] = Field(min_length=2, max_length=2)
    secondarySources: list[SourceId] = Field(min_length=2, max_length=2)
    calibrationSources: list[SourceId] = Field(default_factory=list, max_length=2)
    referenceIntent: dict[str, list[str]]
    blendedDNA: dict[str, str]
    appliedDNA: dict[str, str]
    layoutGrammar: list[str] = Field(max_length=8)
    motionDirection: Literal["minimal", "professional", "cinematic", "editorial", "dynamic", "data-driven"]
    languageCalibration: LanguageCalibration
    decisionTrace: dict[str, str]
    providerStatus: str = "metadata-only"
    userReferenceApplied: bool = False
    retrievedReferences: list[RetrievedReference] = Field(default_factory=list, max_length=12)


class PresentationReferenceProvider(Protocol):
    """Future legal retrieval seam. The built-in provider returns metadata only."""

    def search(self, brief: PresentationBrief) -> list[dict[str, Any]]: ...
    def get_metadata(self, reference_id: str) -> dict[str, Any] | None: ...
    def get_preview(self, reference_id: str) -> bytes | None: ...
    def analyze(self, metadata: dict[str, Any]) -> dict[str, str]: ...


class MetadataOnlyReferenceProvider:
    def search(self, brief: PresentationBrief) -> list[dict[str, Any]]:
        return []

    def get_metadata(self, reference_id: str) -> dict[str, Any] | None:
        return None

    def get_preview(self, reference_id: str) -> bytes | None:
        return None

    def analyze(self, metadata: dict[str, Any]) -> dict[str, str]:
        return {}


_REFERENCE_DOMAINS: dict[str, str] = {
    "pitch.com": "pitch", "envato.com": "envato", "canva.com": "canva",
    "slidesgo.com": "slidesgo", "slidescarnival.com": "slidescarnival",
    "create.microsoft.com": "microsoft", "officeplus.cn": "officeplus",
    "ypppt.com": "ypppt", "xiaohongshu.com": "xiaohongshu",
}


class PublicIndexedReferenceProvider(MetadataOnlyReferenceProvider):
    """Search public index snippets from user-requested design sites.

    It does not crawl, download or analyze template files. The returned page
    titles/snippets are only evidence that a source page was actually found.
    """

    def search(self, brief: PresentationBrief) -> list[dict[str, Any]]:
        from tools.search_orchestrator import SearchOrchestrator

        cache_key = (brief.topic, brief.language, brief.presentationType,
                     brief.industry, brief.audience, brief.style)
        now = monotonic()
        with _PUBLIC_REFERENCE_CACHE_LOCK:
            cached = _PUBLIC_REFERENCE_CACHE.get(cache_key)
            if cached and now - cached[0] < 900:
                return [dict(item) for item in cached[1]]

        ranked = sorted((_score(source, brief) for source in SOURCES),
                        key=lambda item: (-item.rawWeight, item.source))
        domains = []
        for item in ranked[:6]:
            source = SOURCE_BY_ID[item.source]
            host = re.sub(r"^https?://", "", source.url).split("/", 1)[0]
            if host not in domains:
                domains.append(host)
        if brief.language == "zh":
            domains.append("xiaohongshu.com")
        query = f"{brief.topic} PPT 演示文稿 页面构图 设计参考"
        payload = SearchOrchestrator().run(
            query, intent_override="visual_inspiration", domains_override=domains,
            strict_domains=True, min_total=4, max_results=12,
        )
        results = []
        for item in payload["results"]:
            host = urlparse(item.get("url", "")).hostname or ""
            source_id = next((source for domain, source in _REFERENCE_DOMAINS.items()
                              if host == domain or host.endswith("." + domain)), "xiaohongshu" if "xiaohongshu.com" in host else "")
            if not source_id:
                continue
            results.append({"source": source_id, "title": item.get("title", "")[:180],
                            "url": item.get("url", "")[:500], "snippet": item.get("snippet", "")[:360]})
        results = results[:12]
        with _PUBLIC_REFERENCE_CACHE_LOCK:
            _PUBLIC_REFERENCE_CACHE[cache_key] = (monotonic(), tuple(dict(item) for item in results))
            if len(_PUBLIC_REFERENCE_CACHE) > 64:
                oldest = min(_PUBLIC_REFERENCE_CACHE, key=lambda key: _PUBLIC_REFERENCE_CACHE[key][0])
                _PUBLIC_REFERENCE_CACHE.pop(oldest, None)
        return results


_PUBLIC_REFERENCE_CACHE: dict[tuple[str, ...], tuple[float, tuple[dict[str, Any], ...]]] = {}
_PUBLIC_REFERENCE_CACHE_LOCK = RLock()


def _source(id: SourceId, name: str, url: str, base: float, *, strengths: tuple[str, ...],
            best_for: tuple[str, ...], languages: tuple[str, ...], scenarios: dict[str, float],
            styles: dict[str, float], industries: dict[str, float], audiences: dict[str, float],
            formats: dict[str, float], expertise: dict[str, float], dna: dict[str, str],
            intent: tuple[str, ...]) -> PresentationReferenceSource:
    return PresentationReferenceSource(
        id=id, name=name, url=url, baseWeight=base, strengths=strengths, bestFor=best_for,
        languageAffinity=languages, scenarioAffinity=scenarios, styleAffinity=styles,
        industryAffinity=industries, audienceAffinity=audiences, formatAffinity=formats,
        expertise=expertise, designCharacteristics=dna, referenceIntent=intent,
    )


SOURCES: tuple[PresentationReferenceSource, ...] = (
    _source("pitch", "Pitch", "https://pitch.com/templates", .95,
            strengths=("typography", "whitespace", "business-storytelling", "visual-hierarchy"),
            best_for=("startup", "saas", "investor", "technology", "consulting"), languages=("en", "international"),
            scenarios={"investor-pitch": 1, "strategy": .96, "product-launch": .91, "annual-report": .62, "work-report": .52, "brand-launch": .72},
            styles={"minimal": 1, "professional": .94, "cinematic": .86, "editorial": .88, "creative": .65},
            industries={"saas": 1, "technology": .96, "automotive": .83, "consulting": .94, "business": .75, "government": .42, "fashion": .56},
            audiences={"investor": 1, "executive": .96, "consumer": .78, "internal": .57, "government": .42},
            formats={"pitch": 1, "report": .69, "launch": .88, "portfolio": .65},
            expertise={"typography": 1, "whitespace": 1, "composition": .86, "rhythm": .83, "charts": .67},
            dna={"whitespace": "generous", "typographyScale": "balanced", "alignment": "left", "compositionStyle": "editorial", "decorationLevel": "minimal", "visualRhythm": "varied"},
            intent=("typography", "whitespace", "business storytelling", "information hierarchy")),
    _source("envato", "Envato Elements", "https://elements.envato.com/presentation-templates", .93,
            strengths=("premium-composition", "editorial-layout", "image-treatment", "creative-direction"),
            best_for=("brand", "product", "fashion", "architecture", "luxury"), languages=("en", "international"),
            scenarios={"product-launch": 1, "brand-launch": 1, "investor-pitch": .89, "strategy": .78, "annual-report": .61, "work-report": .49},
            styles={"cinematic": 1, "editorial": 1, "creative": .97, "professional": .82, "minimal": .76},
            industries={"automotive": 1, "fashion": 1, "technology": .86, "saas": .84, "consulting": .71, "business": .68, "government": .39},
            audiences={"consumer": 1, "investor": .86, "executive": .81, "internal": .52, "government": .4},
            formats={"launch": 1, "portfolio": .98, "pitch": .91, "report": .62},
            expertise={"composition": 1, "imagery": 1, "typography": .82, "color": .87, "rhythm": .79},
            dna={"imageTreatment": "cinematic", "compositionStyle": "dramatic", "asymmetry": "medium", "contrast": "high", "whitespace": "generous", "cornerStyle": "sharp"},
            intent=("hero composition", "product imagery", "editorial layout", "premium visual direction")),
    _source("canva", "Canva", "https://www.canva.com/presentations/templates/", .88,
            strengths=("visual-diversity", "color", "creative-layout", "image-composition"),
            best_for=("marketing", "brand", "fashion", "lifestyle", "portfolio"), languages=("en", "international"),
            scenarios={"brand-launch": 1, "product-launch": .87, "investor-pitch": .7, "annual-report": .58, "work-report": .54, "strategy": .58},
            styles={"creative": 1, "editorial": .91, "cinematic": .77, "professional": .68, "minimal": .71},
            industries={"fashion": 1, "automotive": .79, "business": .69, "technology": .72, "saas": .65, "government": .43},
            audiences={"consumer": 1, "investor": .64, "executive": .59, "internal": .61, "government": .43},
            formats={"portfolio": 1, "launch": .9, "pitch": .68, "report": .57},
            expertise={"color": 1, "imagery": .9, "composition": .89, "rhythm": .74},
            dna={"imageTreatment": "editorial", "contrast": "high", "visualRhythm": "varied", "asymmetry": "medium", "decorationLevel": "restrained"},
            intent=("visual variation", "color", "creative composition", "image composition")),
    _source("slidesgo", "Slidesgo", "https://slidesgo.com/", .82,
            strengths=("slide-variety", "infographics", "presentation-structure"),
            best_for=("education", "business", "technology", "general"), languages=("en", "international"),
            scenarios={"annual-report": .75, "work-report": .71, "strategy": .73, "investor-pitch": .7, "product-launch": .68, "brand-launch": .59},
            styles={"professional": .81, "creative": .82, "editorial": .7, "minimal": .67, "cinematic": .54},
            industries={"education": 1, "business": .85, "technology": .86, "saas": .69, "automotive": .61, "fashion": .53, "government": .65},
            audiences={"internal": .84, "executive": .74, "consumer": .67, "investor": .66, "government": .63},
            formats={"report": .86, "pitch": .74, "launch": .67, "portfolio": .61},
            expertise={"rhythm": .93, "charts": .83, "composition": .7, "information_density": .72},
            dna={"visualRhythm": "varied", "chartStyle": "editorial", "density": "medium", "compositionStyle": "editorial"},
            intent=("slide type variety", "infographic structure", "deck rhythm")),
    _source("slidescarnival", "SlidesCarnival", "https://www.slidescarnival.com/", .75,
            strengths=("deck-structure", "general-layout", "education"),
            best_for=("education", "general", "business"), languages=("en", "international"),
            scenarios={"work-report": .73, "annual-report": .72, "strategy": .65, "investor-pitch": .62, "product-launch": .58, "brand-launch": .55},
            styles={"professional": .76, "creative": .74, "editorial": .66, "minimal": .67, "cinematic": .5},
            industries={"education": 1, "business": .79, "government": .69, "saas": .58, "automotive": .52, "fashion": .48},
            audiences={"internal": .8, "government": .69, "executive": .68, "consumer": .67, "investor": .57},
            formats={"report": .82, "pitch": .63, "launch": .57, "portfolio": .53},
            expertise={"rhythm": .86, "composition": .73, "information_density": .72},
            dna={"visualRhythm": "steady", "compositionStyle": "editorial", "density": "medium"},
            intent=("deck structure", "general layouts", "page type coverage")),
    _source("microsoft", "Microsoft PowerPoint", "https://create.microsoft.com/en-us/templates/presentations", .75,
            strengths=("powerpoint-native", "corporate-layout", "master-logic"),
            best_for=("corporate", "government", "education", "report"), languages=("en", "international"),
            scenarios={"annual-report": 1, "work-report": .98, "strategy": .87, "investor-pitch": .72, "product-launch": .65, "brand-launch": .49},
            styles={"professional": 1, "minimal": .82, "editorial": .68, "creative": .56, "cinematic": .51},
            industries={"government": 1, "business": .96, "consulting": .88, "education": .89, "technology": .73, "fashion": .42, "automotive": .56},
            audiences={"government": 1, "internal": .96, "executive": .92, "investor": .7, "consumer": .48},
            formats={"report": 1, "pitch": .7, "launch": .56, "portfolio": .48},
            expertise={"composition": .9, "charts": .86, "information_density": .82, "rhythm": .76},
            dna={"compositionStyle": "consulting", "chartStyle": "analytical", "alignment": "grid", "decorationLevel": "minimal", "visualRhythm": "steady"},
            intent=("PowerPoint native structure", "corporate layout", "slide master logic")),
    _source("officeplus", "OfficePLUS", "https://www.officeplus.cn/", .72,
            strengths=("chinese-typography", "chinese-business-layout", "corporate-reporting"),
            best_for=("chinese-report", "annual-summary", "government", "education"), languages=("zh",),
            scenarios={"annual-report": 1, "work-report": 1, "strategy": .89, "product-launch": .59, "investor-pitch": .44, "brand-launch": .43},
            styles={"professional": 1, "minimal": .78, "editorial": .7, "cinematic": .48, "creative": .49},
            industries={"government": 1, "business": 1, "consulting": .86, "education": .91, "automotive": .56, "fashion": .39, "saas": .49},
            audiences={"government": 1, "internal": 1, "executive": .91, "consumer": .47, "investor": .43},
            formats={"report": 1, "pitch": .49, "launch": .52, "portfolio": .45},
            expertise={"typography": 1, "information_density": 1, "composition": .85, "charts": .79},
            dna={"typographyScale": "restrained", "density": "medium", "alignment": "left", "compositionStyle": "consulting", "chartStyle": "analytical", "whitespace": "balanced"},
            intent=("Chinese typography calibration", "Chinese business layout", "corporate reporting")),
    _source("ypppt", "优品PPT", "https://www.ypppt.com/", .62,
            strengths=("chinese-structure", "work-report", "annual-summary", "chinese-density"),
            best_for=("chinese-report", "work-plan", "government", "education"), languages=("zh",),
            scenarios={"annual-report": 1, "work-report": 1, "strategy": .71, "product-launch": .43, "investor-pitch": .39, "brand-launch": .35},
            styles={"professional": .85, "minimal": .62, "editorial": .55, "creative": .46, "cinematic": .4},
            industries={"government": 1, "business": .91, "education": .89, "consulting": .66, "automotive": .44, "fashion": .31, "saas": .4},
            audiences={"government": 1, "internal": .96, "executive": .77, "consumer": .43, "investor": .35},
            formats={"report": 1, "pitch": .42, "launch": .43, "portfolio": .4},
            expertise={"information_density": 1, "rhythm": .88, "typography": .84, "composition": .7},
            dna={"density": "medium", "visualRhythm": "varied", "compositionStyle": "consulting", "whitespace": "balanced"},
            intent=("Chinese work-report structure", "annual-summary rhythm", "Chinese content density")),
)

SOURCE_BY_ID = {source.id: source for source in SOURCES}
assert len(SOURCE_BY_ID) == 8


def _has(text: str, *words: str) -> bool:
    return any(
        bool(re.search(r"(?<![a-z0-9])" + re.escape(word) + r"(?![a-z0-9])", text))
        if word and word[0].isascii() and word[0].isalpha() else word in text
        for word in words
    )


def brief_from_design(design: Any) -> PresentationBrief:
    """Infer bounded intent from the whole deck, not just its first slide."""
    primary = " ".join(filter(None, [design.title, design.description, design.purpose, design.audience])).lower()
    text = " ".join(filter(None, [primary, *[slide.title for slide in design.slides],
                                *[slide.keyMessage for slide in design.slides]])).lower()[:5000]
    scenario_words = ("融资", "投资人", "investor", "fundraising", "pitch deck", "发布会", "新品发布",
                      "product launch", "brand launch", "品牌发布", "年度", "年终", "annual",
                      "year-end", "工作汇报", "工作总结", "工作计划", "述职", "work report",
                      "战略", "咨询", "strategy", "consulting")
    industry_words = ("政府", "政务", "部门", "党建", "government", "public sector", "时尚",
                      "fashion", "奢侈", "服装", "汽车", "车型", "新能源车", "automotive",
                      "vehicle", "saas", "startup", "初创", "创业", "咨询", "consulting",
                      "教育", "教学", "学校", "education", "科技", "技术", "ai", "technology", "software")
    scenario_text = primary if _has(primary, *scenario_words) else text
    industry_text = primary if _has(primary, *industry_words) else text
    zh_count = len(re.findall(r"[\u3400-\u9fff]", text))
    language = "zh" if zh_count >= 2 else "en"
    if _has(scenario_text, "融资", "投资人", "investor", "fundraising", "pitch deck"):
        scenario = "investor-pitch"
    elif _has(scenario_text, "发布会", "新品发布", "product launch", "brand launch", "品牌发布"):
        scenario = "brand-launch" if _has(industry_text, "时尚", "fashion", "奢侈", "品牌") and not _has(industry_text, "汽车", "车型", "新能源") else "product-launch"
    elif _has(scenario_text, "年度", "年终", "annual", "year-end"):
        scenario = "annual-report"
    elif _has(scenario_text, "工作汇报", "工作总结", "工作计划", "述职", "work report"):
        scenario = "work-report"
    elif _has(scenario_text, "战略", "咨询", "strategy", "consulting"):
        scenario = "strategy"
    else:
        scenario = "general"
    if _has(industry_text, "政府", "政务", "部门", "党建", "government", "public sector"):
        industry = "government"
    elif _has(industry_text, "时尚", "fashion", "奢侈", "服装"):
        industry = "fashion"
    elif _has(industry_text, "汽车", "车型", "新能源车", "automotive", "vehicle"):
        industry = "automotive"
    elif _has(industry_text, "saas", "startup", "初创", "创业"):
        industry = "saas"
    elif _has(industry_text, "咨询", "consulting"):
        industry = "consulting"
    elif _has(industry_text, "教育", "教学", "学校", "education"):
        industry = "education"
    elif _has(industry_text, "科技", "技术", "ai", "technology", "software"):
        industry = "technology"
    else:
        industry = "business" if scenario in {"annual-report", "work-report", "strategy"} else "general"
    if industry == "government":
        audience = "government"
    elif scenario == "investor-pitch":
        audience = "investor"
    elif _has(text, "管理层", "高管", "董事会", "executive", "management") or scenario == "strategy":
        audience = "executive"
    elif scenario in {"annual-report", "work-report"}:
        audience = "internal"
    elif scenario in {"product-launch", "brand-launch"}:
        audience = "consumer"
    else:
        audience = "general"
    direction = " ".join([*design.artDirection.mood, design.artDirection.visualLanguage,
                          design.artDirection.compositionDirection]).lower()
    if _has(text, "时尚", "fashion"):
        style = "editorial"
    elif _has(direction, "cinematic", "电影", "发布会") or industry == "automotive" and scenario == "product-launch":
        style = "cinematic"
    elif _has(direction, "minimal", "极简") or scenario == "investor-pitch":
        style = "minimal"
    elif _has(direction, "creative", "活力", "创意"):
        style = "creative"
    else:
        style = "professional" if scenario in {"annual-report", "work-report", "strategy"} else "editorial"
    return PresentationBrief(topic=design.title[:200], language=language, presentationType=scenario,
                             industry=industry, audience=audience, style=style)


def _factor(affinity: float, floor: float) -> float:
    return round(floor + (1 - floor) * max(0, min(1, affinity)), 4)


def _score(source: PresentationReferenceSource, brief: PresentationBrief,
           retrieval_relevance: float = 0) -> ReferenceWeight:
    scenario = _factor(source.scenarioAffinity.get(brief.presentationType, .72), .52)
    style = _factor(source.styleAffinity.get(brief.style, .72), .78)
    language_affinity = 1 if brief.language in source.languageAffinity else .49 if brief.language == "zh" else .45
    language = _factor(language_affinity, .72)
    industry = _factor(source.industryAffinity.get(brief.industry, .72), .68)
    audience = _factor(source.audienceAffinity.get(brief.audience, .72), .78)
    format_key = ("pitch" if brief.presentationType == "investor-pitch" else
                  "launch" if brief.presentationType in {"product-launch", "brand-launch"} else
                  "report" if brief.presentationType in {"annual-report", "work-report", "strategy"} else "portfolio")
    format_relevance = _factor(source.formatAffinity.get(format_key, .72), .78)
    retrieval_relevance = max(0, min(1, retrieval_relevance))
    # A relevant, actually indexed page is a bounded availability signal, not
    # a substitute for the site's topic/industry expertise profile.
    raw = (source.baseWeight * scenario * style * language * industry * audience * format_relevance
           * (1 + .12 * retrieval_relevance))
    return ReferenceWeight(source=source.id, baseWeight=source.baseWeight,
                           scenarioRelevance=scenario, styleRelevance=style,
                           languageRelevance=language, industryRelevance=industry,
                           audienceRelevance=audience, formatRelevance=format_relevance,
                           retrievalRelevance=round(retrieval_relevance, 4),
                           rawWeight=round(raw, 6), finalWeight=0)


_TRAIT_DOMAIN = {
    "density": "information_density", "alignment": "composition", "whitespace": "whitespace",
    "typographyScale": "typography", "imageTreatment": "imagery", "cornerStyle": "composition",
    "decorationLevel": "composition", "contrast": "color", "chartStyle": "charts",
    "compositionStyle": "composition", "asymmetry": "composition", "visualRhythm": "rhythm",
}


def _blend(weights: list[ReferenceWeight], ids: list[SourceId]) -> dict[str, str]:
    votes: dict[str, dict[str, float]] = {}
    for item in weights:
        if item.source not in ids:
            continue
        source = SOURCE_BY_ID[item.source]
        for trait, value in source.designCharacteristics.items():
            expertise = source.expertise.get(_TRAIT_DOMAIN[trait], .55)
            votes.setdefault(trait, {})[value] = votes.setdefault(trait, {}).get(value, 0) + item.finalWeight * expertise
    return {trait: sorted(options.items(), key=lambda entry: (-entry[1], entry[0]))[0][0]
            for trait, options in votes.items()}


def _user_reference_overrides(profile: Any) -> dict[str, str]:
    if profile is None:
        return {}
    values = {}
    for source_field, target_field, allowed in (
        ("alignment", "alignment", {"left", "center", "asymmetric", "grid"}),
        ("cornerStyle", "cornerStyle", {"sharp", "subtle", "rounded"}),
        ("chartStyle", "chartStyle", {"editorial", "restrained", "analytical"}),
        ("spacing", "whitespace", {"compact", "balanced", "generous", "dramatic"}),
    ):
        candidate = getattr(profile, source_field, None)
        if candidate in allowed:
            values[target_field] = candidate
    if any("oversized" in value.lower() for value in profile.typography):
        values["typographyScale"] = "oversized"
    if any("restrained" in value.lower() for value in profile.typography):
        values["typographyScale"] = "restrained"
    return values


def build_reference_plan(design: Any, provider: PresentationReferenceProvider | None = None) -> ReferencePlan:
    brief = brief_from_design(design)
    retrieved: list[RetrievedReference] = []
    status = "metadata-only"
    if provider is not None:
        try:
            retrieved = [RetrievedReference.model_validate(item) for item in provider.search(brief)[:12]]
            status = "public-indexed" if retrieved else "provider-empty"
        except Exception:
            status = "provider-fallback"
    retrieval_counts: dict[str, int] = {}
    for item in retrieved:
        if item.source in SOURCE_BY_ID:
            retrieval_counts[item.source] = retrieval_counts.get(item.source, 0) + 1
    scores = [_score(source, brief,
                     min(1, retrieval_counts.get(source.id, 0) / 3)) for source in SOURCES]
    maximum = max(item.rawWeight for item in scores) or 1
    weights = sorted([item.model_copy(update={"finalWeight": round(item.rawWeight / maximum, 4)})
                      for item in scores], key=lambda item: (-item.rawWeight, item.source))
    primary = [item.source for item in weights[:2]]
    secondary = [item.source for item in weights[2:4]]
    chosen = primary + secondary
    calibration: list[SourceId] = ["officeplus", "ypppt"] if brief.language == "zh" else []
    intent = {source_id: list(SOURCE_BY_ID[source_id].referenceIntent)
              for source_id in dict.fromkeys(chosen + calibration)}
    blend = _blend(weights, chosen)
    user_values = _user_reference_overrides(design.referenceDesignProfile)
    # An uploaded or user-specified design reference outranks public profiles,
    # but only bounded semantic tokens can cross into Art Direction.
    blend.update(user_values)
    grammar = list(dict.fromkeys(
        item for source_id in chosen for item in SOURCE_BY_ID[source_id].referenceIntent
        if item in {"information hierarchy", "hero composition", "editorial layout", "deck rhythm",
                    "corporate layout", "Chinese business layout", "slide type variety", "creative composition"}
    ))[:8]
    motion = ("cinematic" if brief.style == "cinematic" else
              "editorial" if brief.style in {"editorial", "creative"} else
              "data-driven" if brief.presentationType == "strategy" else
              "minimal" if brief.style == "minimal" or brief.industry == "government" else "professional")
    calibration_token = LanguageCalibration(
        language=brief.language, fontFamily="Microsoft YaHei" if brief.language == "zh" else "Aptos",
        titleScale=.94 if brief.language == "zh" else 1, bodyLineSpacing=1.08 if brief.language == "zh" else 1,
        guidance=("按中文断行和字重校准标题；国际化视觉来源不直接套英文排版。" if brief.language == "zh" else
                  "Keep concise headings and readable body copy."),
    )
    trace = {
        item.source: f"擅长 {', '.join(SOURCE_BY_ID[item.source].referenceIntent[:2])}；"
                     f"场景 {item.scenarioRelevance:.2f}，行业 {item.industryRelevance:.2f}，"
                     f"语言 {item.languageRelevance:.2f}，综合 {item.finalWeight:.2f}。"
        for item in weights[:4]
    }
    return ReferencePlan(
        brief=brief, sourceWeights=weights, primarySources=primary, secondarySources=secondary,
        calibrationSources=calibration, referenceIntent=intent, blendedDNA=blend,
        appliedDNA={}, layoutGrammar=grammar, motionDirection=motion,
        languageCalibration=calibration_token, decisionTrace=trace,
        providerStatus=status, userReferenceApplied=bool(user_values),
        retrievedReferences=retrieved,
    )


def apply_reference_system(design: Any, provider: PresentationReferenceProvider | None = None) -> Any:
    """Art Director retains explicit DNA; references only fill undecided tokens."""
    from tools.presentation_motion import MotionLanguage

    plan = build_reference_plan(design, provider)
    previous = design.referencePlan
    updates = {}
    for key, value in plan.blendedDNA.items():
        current = getattr(design.designDNA, key)
        inherited = previous is not None and previous.appliedDNA.get(key) == current
        if key not in design.designDNA.model_fields_set or inherited:
            updates[key] = value
    # An explicit supplied design reference takes precedence over public sites.
    updates.update(_user_reference_overrides(design.referenceDesignProfile))
    dna = design.designDNA.model_copy(update=updates)
    art_updates = {}
    if "typographyDirection" not in design.artDirection.model_fields_set:
        art_updates["typographyDirection"] = plan.languageCalibration.guidance
    if "compositionDirection" not in design.artDirection.model_fields_set and plan.layoutGrammar:
        art_updates["compositionDirection"] = "Use semantic hierarchy and " + ", ".join(plan.layoutGrammar[:2])
    art = design.artDirection.model_copy(update=art_updates)
    motion = design.motionLanguage or MotionLanguage(style=plan.motionDirection,
                                                       energy="low" if plan.motionDirection in {"minimal", "data-driven"} else "medium")
    plan = plan.model_copy(update={"appliedDNA": {key: getattr(dna, key) for key in plan.blendedDNA}})
    return design.model_copy(update={"designDNA": dna, "artDirection": art,
                                     "motionLanguage": motion, "referencePlan": plan})
