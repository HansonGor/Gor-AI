"""Best-effort Pexels backgrounds for generated presentations."""

from __future__ import annotations

from dataclasses import dataclass
from collections import OrderedDict
from hashlib import sha256
from io import BytesIO
import ipaddress
import re
import socket
from time import monotonic
from typing import Protocol
from urllib.parse import urlparse

import httpx
from PIL import Image, ImageFilter, ImageStat

from config import config


MAX_IMAGE_BYTES = 8 * 1024 * 1024
MAX_PHOTOS_PER_DECK = 25
_resolution_cache: OrderedDict[tuple, tuple[float, dict[str, PexelsPhoto]]] = OrderedDict()


def _remember_resolution(key, result):
    # Retain the complete image assignment (including intentional missing
    # photos), not only individual downloads, across motion-only revisions.
    # Bounded in-process cache; stored snapshot assets survive browser refresh.
    _resolution_cache[key] = (monotonic(), dict(result))
    _resolution_cache.move_to_end(key)
    while len(_resolution_cache) > 8 or sum(len(photo.image_bytes) for _, assets in _resolution_cache.values() for photo in assets.values()) > 128 * 1024 * 1024:
        _resolution_cache.popitem(last=False)
    return result


class PexelsPhotoError(RuntimeError):
    """A safe, user-facing Pexels error with no credentials in its message."""

    def __init__(self, message: str, *, terminal: bool = False):
        super().__init__(message)
        self.terminal = terminal


@dataclass(frozen=True)
class PexelsPhoto:
    image_bytes: bytes
    photographer: str
    photographer_url: str
    photo_url: str
    alt: str = ""
    provider: str = "Pexels"
    license_name: str = "Pexels License"
    license_url: str = "https://www.pexels.com/license/"
    attribution: str = ""
    image_url: str = ""
    title: str = ""


def _is_pexels_image_url(url: str) -> bool:
    parsed = urlparse(url)
    return parsed.scheme == "https" and parsed.hostname == "images.pexels.com"


_QUERY_FILLER = {"photo", "photography", "editorial", "cinematic", "natural", "light", "wide", "shot", "close", "up", "warm", "style", "clear", "sky", "background", "composition", "beautiful", "high", "quality", "image", "soft", "against", "with", "and", "the", "at", "of", "in", "on", "from", "a"}


def _search_terms(value: str) -> list[str]:
    return [term for term in re.findall(r"[a-z]{3,}", value.lower()) if term not in _QUERY_FILLER]


def _candidate_relevance(query: str, candidate: dict) -> float:
    terms = _search_terms(query)
    if not terms:
        return .5
    description = " ".join((str(candidate.get("alt") or ""), str(candidate.get("url") or "").replace("-", " ")))
    present = set(_search_terms(description))
    if not present:
        return .05
    # Early query terms usually name the actual subject; trailing terms describe
    # treatment. A generic "food" result must not outrank the named dish.
    weights = [3 if index < 4 else 1 for index in range(len(terms))]
    return sum(weight for term, weight in zip(terms, weights) if term in present) / sum(weights)


def _subject_matches(query: str, candidate: dict) -> bool:
    description = " ".join((str(candidate.get("alt") or ""), str(candidate.get("url") or "").replace("-", " "))).lower()
    requested = set(_search_terms(query))
    # Exact locations and named dishes should never silently turn into a
    # similar-looking landmark or unrelated food in another city.
    for city in ("guangzhou", "beijing", "shanghai", "xiamen", "shenzhen", "tokyo", "london", "paris"):
        if city in requested and city not in description:
            return False
    if {"canton", "tower"} <= requested and not any(term in description for term in ("canton tower", "guangzhou")):
        return False
    if "shrimp" in requested and "shrimp" not in description:
        return False
    if "cheung" in requested and not any(term in description for term in ("cheung", "rice noodle roll")):
        return False
    if any(term in requested for term in ("daylight", "morning")) and any(term in description for term in ("night", "electric light", "dark alley")):
        return False
    return True


def _image_quality(image_bytes: bytes) -> float:
    with Image.open(BytesIO(image_bytes)) as source:
        image = source.convert("RGB")
        image.thumbnail((400, 240))
        grey = image.convert("L")
        stats = ImageStat.Stat(grey)
        exposure = stats.mean[0]
        edges = ImageStat.Stat(grey.filter(ImageFilter.FIND_EDGES)).stddev[0]
        left = grey.crop((0, 0, max(1, grey.width // 3), grey.height))
        right = grey.crop((grey.width * 2 // 3, 0, grey.width, grey.height))
        quiet_side = min(ImageStat.Stat(region.filter(ImageFilter.FIND_EDGES)).stddev[0] for region in (left, right))
        return min(1.0, edges / 45) * .38 + (1 - abs(exposure - 125) / 125) * .22 + (1 - min(1.0, quiet_side / 45)) * .4


_PROVIDER_HOME = {
    "Pexels": "https://www.pexels.com",
    "Pixabay": "https://pixabay.com",
    "Unsplash": "https://unsplash.com",
    "Openverse": "https://openverse.org",
    "Wikimedia Commons": "https://commons.wikimedia.org",
}
_PROVIDER_LICENSE = {
    "Pexels": "https://www.pexels.com/license/",
    "Pixabay": "https://pixabay.com/service/license-summary/",
    "Unsplash": "https://unsplash.com/license",
}
_PROVIDER_IMAGE_HOSTS = {
    "Pexels": {"images.pexels.com"},
    "Pixabay": {"cdn.pixabay.com", "pixabay.com"},
    "Unsplash": {"images.unsplash.com"},
    "Wikimedia Commons": {"upload.wikimedia.org", "thumb.wikimedia.org"},
}


def _safe_public_image_url(url: str, provider: str) -> bool:
    parsed = urlparse(url)
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password or parsed.port not in (None, 443):
        return False
    host = parsed.hostname.lower().rstrip(".")
    allowed = _PROVIDER_IMAGE_HOSTS.get(provider)
    if allowed:
        return host in allowed
    # Openverse indexes multiple publishers, so validate the resolved address
    # before requesting their API-provided thumbnail. Redirects are disabled.
    if provider != "Openverse":
        return False
    try:
        addresses = {item[4][0] for item in socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM)}
        return bool(addresses) and all(ipaddress.ip_address(address).is_global for address in addresses)
    except (OSError, ValueError):
        return False


def _download_location_event(client: httpx.Client, candidate: dict) -> None:
    """Honor Unsplash's download tracking requirement before embedding a photo."""
    location = str(candidate.get("downloadLocation") or "")
    if not location:
        return
    if urlparse(location).hostname != "api.unsplash.com":
        raise ValueError("Unexpected Unsplash download endpoint")
    response = client.get(
        location,
        headers={"Authorization": f"Client-ID {config.ImageSearch.UNSPLASH_ACCESS_KEY.strip()}", "Accept-Version": "v1"},
        follow_redirects=False,
    )
    response.raise_for_status()


def _get_photo(query: str) -> PexelsPhoto | None:
    """Use the exact shared image-search implementation, then embed one safe result."""
    # Lazy import avoids a module cycle: image_search uses the Pexels URL guard
    # above, while presentations consume its same federated search core.
    from tools.image_search import search_image_results

    payload = search_image_results(query, "landscape", "all")
    candidates = [item for item in payload.get("results", []) if isinstance(item, dict)
                  and item.get("imageUrl") and item.get("pageUrl")
                  and _subject_matches(query, {"alt": " ".join((str(item.get("alt") or ""), str(item.get("title") or ""))),
                                               "url": item.get("pageUrl")})]
    if not candidates:
        return None
    candidates.sort(key=lambda item: _candidate_relevance(query, {
        "alt": " ".join((str(item.get("alt") or ""), str(item.get("title") or ""), str(item.get("attribution") or ""))),
        "url": item.get("pageUrl"),
    }), reverse=True)
    if _search_terms(query) and _candidate_relevance(query, {
        "alt": " ".join((str(candidates[0].get("alt") or ""), str(candidates[0].get("title") or ""))),
        "url": candidates[0].get("pageUrl"),
    }) < .12:
        return None

    timeout = httpx.Timeout(12.0, connect=5.0)
    evaluated = []
    with httpx.Client(timeout=timeout, follow_redirects=False) as client:
        for candidate in candidates[:8]:
            provider = str(candidate.get("provider") or "")
            image_url = str(candidate.get("imageUrl") or "")
            if not _safe_public_image_url(image_url, provider):
                continue
            try:
                if candidate.get("downloadLocation"):
                    _download_location_event(client, candidate)
                image_response = client.get(image_url, follow_redirects=False)
                image_response.raise_for_status()
                image_bytes = image_response.content
                if (len(image_bytes) > MAX_IMAGE_BYTES
                        or not image_response.headers.get("content-type", "").lower().startswith("image/")):
                    continue
                try:
                    quality = _image_quality(image_bytes)
                except (ValueError, OSError):
                    continue
                relevance = _candidate_relevance(query, {
                    "alt": " ".join((str(candidate.get("alt") or ""), str(candidate.get("title") or ""))),
                    "url": candidate.get("pageUrl"),
                })
                score = relevance * .7 + quality * .3
                evaluated.append((score, candidate, image_bytes))
            except (httpx.HTTPError, ValueError, TypeError):
                continue
    if not evaluated:
        return None
    _, selected, image_bytes = max(evaluated, key=lambda item: item[0])
    return PexelsPhoto(
        image_bytes=image_bytes,
        photographer=str(selected.get("creator") or "")[:100],
        photographer_url=str(selected.get("creatorUrl") or ""),
        photo_url=str(selected["pageUrl"]),
        alt=str(selected.get("alt") or selected.get("title") or "")[:240],
        provider=str(selected.get("provider") or "Unknown source"),
        license_name=str(selected.get("license") or "See source page")[:120],
        license_url=str(selected.get("licenseUrl") or _PROVIDER_LICENSE.get(str(selected.get("provider") or ""), selected["pageUrl"])),
        attribution=str(selected.get("attribution") or "")[:300],
        image_url=str(selected.get("imageUrl") or ""),
        title=str(selected.get("title") or "")[:160],
    )


def _slide_query(slide) -> str:
    """Prefer the model's focused English search query; infer one for older schemas."""
    if slide.imageQuery and slide.imageQuery.strip():
        return " ".join(slide.imageQuery.split())[:120]

    parts = [slide.title, slide.subtitle, slide.eyebrow, slide.keyMessage, slide.visualIntent]
    parts.extend(slide.supportingPoints[:2])
    parts.extend(f"{metric.label} {metric.value} {metric.note or ''}" for metric in slide.metrics[:2])
    parts.extend(f"{item.title} {item.detail}" for item in slide.timeline[:2])
    if slide.chart:
        parts.extend([slide.chart.title, *slide.chart.categories[:3]])
    if slide.table:
        parts.extend(slide.table.headers[:3])
    query = " ".join(str(part).strip() for part in parts if part and str(part).strip())
    return " ".join(query.split())[:120]


def _route_fallback_query(slide, primary: str) -> str | None:
    if not slide.timeline:
        return None
    city = next((term for term in ("Guangzhou", "Beijing", "Shanghai", "Xiamen", "Shenzhen", "Tokyo", "London", "Paris") if term.lower() in primary.lower()), None)
    if not city:
        return None
    if "夜" in (slide.title or "") or "night" in primary.lower():
        return f"{city} river night"
    if "brick" in primary.lower() or "东山" in (slide.title or ""):
        return f"{city} red brick street daylight"
    return f"{city} old town streets"


def _focused_subject_query(primary: str) -> str | None:
    words = set(_search_terms(primary))
    if "shrimp" in words and ("dumpling" in words or "dumplings" in words):
        return "shrimp dumplings bamboo steamer"
    if "cheung" in words and "fun" in words:
        return "Cantonese rice noodle roll cheung fun"
    return None


def ensure_presentation_image_queries(design):
    """Only photo-bearing slides get a query; empty image roles are intentional."""
    supported_roles = {
        "cover": {"hero", "background"},
        "full-image": {"hero", "background"},
        "image-text": {"editorial", "product", "supporting", "texture"},
        "big-number": {"product", "supporting"},
        "title-content": {"supporting"},
        "summary": {"supporting"},
        "quote": {"background", "texture"},
    }
    updated_slides = []
    for slide in design.slides:
        role = slide.imageRole or ("hero" if slide.type == "cover" else "background" if slide.type == "full-image" else "editorial" if slide.type == "image-text" else "none")
        if role not in supported_roles.get(slide.type, set()):
            role = "none"
        if role == "none":
            updated_slides.append(slide.model_copy(update={"imageRole": "none", "imageQuery": None}))
            continue
        query = _slide_query(slide) or design.title
        if len(query.split()) < 3 or query.lower() in {"business", "technology", "success", "innovation", "teamwork"}:
            subject = slide.title or design.title
            setting = slide.visualIntent or slide.keyMessage or slide.subtitle or "editorial photography, natural light, considered composition"
            query = f"{subject}, {setting}, editorial photography, natural light"[:120]
        updated_slides.append(slide.model_copy(update={"imageRole": role, "imageQuery": query}))
    return design.model_copy(update={"slides": updated_slides})


def resolve_presentation_photos(design) -> dict[str, PexelsPhoto]:
    """Use shared image search on selected content-matched pages; others use theme."""
    credentials = "\0".join((config.Pexels.API_KEY.strip(), config.ImageSearch.PIXABAY_API_KEY.strip(),
                               config.ImageSearch.UNSPLASH_ACCESS_KEY.strip()))
    key = (sha256(credentials.encode()).hexdigest(), design.title,
           tuple((slide.id, slide.imageRole, _slide_query(slide)) for slide in design.slides))
    cached = _resolution_cache.get(key)
    if cached and monotonic() - cached[0] < 300:
        _resolution_cache.move_to_end(key)
        return dict(cached[1])

    result: dict[str, PexelsPhoto] = {}
    used_photo_urls: set[str] = set()
    query_cache: dict[str, PexelsPhoto | None] = {}
    for slide in design.slides:
        if len(result) >= MAX_PHOTOS_PER_DECK:
            break
        role = slide.imageRole or ("hero" if slide.type == "cover" else "background" if slide.type == "full-image" else "editorial" if slide.type == "image-text" else "none")
        if role == "none":
            continue
        primary = _slide_query(slide)
        # A shorter search often succeeds when the model supplied an overly
        # specific phrase; the deck title keeps the fallback topic relevant.
        queries = ([primary, *[query for query in (_focused_subject_query(primary), _route_fallback_query(slide, primary)) if query]] if slide.imageQuery else list(dict.fromkeys(query for query in (
            primary, f"{design.title} {slide.title or ''}".strip()[:120], design.title,
        ) if query)))
        for query in queries:
            if query not in query_cache:
                try:
                    query_cache[query] = _get_photo(query)
                except PexelsPhotoError:
                    query_cache[query] = None
            photo = query_cache[query]
            if photo:
                if photo.photo_url in used_photo_urls:
                    continue
                result[slide.id] = photo
                used_photo_urls.add(photo.photo_url)
                break
    return _remember_resolution(key, result)


class PresentationAssetProvider(Protocol):
    """Provider boundary for Pexels, generated images and user uploads."""

    def resolve(self, design) -> dict[str, PexelsPhoto]: ...


class SharedImageSearchProvider:
    """PPT adapter for the same federated search used by the search_images tool."""

    def resolve(self, design) -> dict[str, PexelsPhoto]:
        return resolve_presentation_photos(design)


# Compatibility name for existing integrations and tests.
PexelsProvider = SharedImageSearchProvider
