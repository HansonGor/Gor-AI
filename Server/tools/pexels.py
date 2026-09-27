"""Best-effort Pexels backgrounds for generated presentations."""

from __future__ import annotations

from dataclasses import dataclass
from functools import lru_cache
from urllib.parse import urlparse

import httpx

from config import config


MAX_IMAGE_BYTES = 8 * 1024 * 1024
MAX_PHOTOS_PER_DECK = 25


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


def _is_pexels_image_url(url: str) -> bool:
    parsed = urlparse(url)
    return parsed.scheme == "https" and parsed.hostname == "images.pexels.com"


@lru_cache(maxsize=96)
def _get_photo(query: str) -> PexelsPhoto | None:
    """Search once per query and download a bounded, Pexels-hosted JPEG."""
    api_key = config.Pexels.API_KEY.strip()
    if not api_key:
        return None
    headers = {"Authorization": api_key}
    timeout = httpx.Timeout(12.0, connect=5.0)
    try:
        with httpx.Client(timeout=timeout, follow_redirects=True) as client:
            response = client.get(
                "https://api.pexels.com/v1/search",
                headers=headers,
                params={
                    "query": query,
                    "orientation": "landscape",
                    "size": "large",
                    "locale": "zh-CN",
                    "per_page": 12,
                },
            )
            response.raise_for_status()
            candidates = response.json().get("photos", [])
            photo = next(
                (
                    item for item in candidates
                    if isinstance(item, dict)
                    and isinstance(item.get("src"), dict)
                    and _is_pexels_image_url(str(item["src"].get("large") or ""))
                    and item.get("url")
                    and item.get("photographer")
                    and item.get("photographer_url")
                ),
                None,
            )
            if not photo:
                return None

            image_response = client.get(str(photo["src"]["large"]))
            image_response.raise_for_status()
            image_bytes = image_response.content
            content_type = image_response.headers.get("content-type", "").lower()
            if len(image_bytes) > MAX_IMAGE_BYTES or not content_type.startswith("image/"):
                raise PexelsPhotoError("Pexels 返回的图片格式无效或超过 8 MB。")

            return PexelsPhoto(
                image_bytes=image_bytes,
                photographer=str(photo["photographer"])[:100],
                photographer_url=str(photo["photographer_url"]),
                photo_url=str(photo["url"]),
            )
    except httpx.HTTPStatusError as exc:
        status = exc.response.status_code
        if status == 401:
            detail = "Pexels 密钥无效或已失效。"
        elif status == 429:
            detail = "Pexels 请求额度已用完，请稍后再试。"
        else:
            detail = f"Pexels 服务返回 HTTP {status}。"
        raise PexelsPhotoError(detail, terminal=True) from None
    except httpx.HTTPError:
        raise PexelsPhotoError("连接 Pexels 失败，请检查网络后重试。", terminal=True) from None
    except (ValueError, TypeError, KeyError):
        raise PexelsPhotoError("Pexels 返回的数据无法解析。") from None


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


def ensure_presentation_image_queries(design):
    """Persist a content-derived search query on every slide, including old schemas."""
    updated_slides = []
    for slide in design.slides:
        query = _slide_query(slide) or design.title
        updated_slides.append(slide.model_copy(update={"imageQuery": query}))
    return design.model_copy(update={"slides": updated_slides})


def resolve_presentation_photos(design) -> dict[str, PexelsPhoto]:
    """Try a content-matched photo for each slide; empty entries use the theme."""
    if not config.Pexels.API_KEY.strip():
        return {}

    result: dict[str, PexelsPhoto] = {}
    for slide in design.slides:
        if len(result) >= MAX_PHOTOS_PER_DECK:
            break
        primary = _slide_query(slide)
        # A shorter search often succeeds when the model supplied an overly
        # specific phrase; the deck title keeps the fallback topic relevant.
        queries = list(dict.fromkeys(query for query in (
            primary,
            f"{design.title} {slide.title or ''}".strip()[:120],
            design.title,
        ) if query))
        for query in queries:
            try:
                photo = _get_photo(query)
            except PexelsPhotoError as exc:
                # Credentials, rate limits and connectivity may affect the
                # remaining pages too. Keep the usable photos already found.
                if exc.terminal:
                    return result
                continue
            if photo:
                result[slide.id] = photo
                break
    return result
