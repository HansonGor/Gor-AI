"""Federated image search across licensed and stock-image providers."""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor, as_completed
from collections import OrderedDict
from hashlib import sha256
from html import unescape
import json
import re
from threading import Lock
from time import monotonic
from typing import Literal
from urllib.parse import quote, urlparse

import httpx
from langchain_core.tools import tool

from config import config
from tools.pexels import _is_pexels_image_url


_TIMEOUT = httpx.Timeout(10.0, connect=4.0)
_PER_PROVIDER = 6
# Pixabay's API image URLs are temporary; refresh their candidate metadata
# before its documented 24-hour URL lifetime can lapse.
_CACHE_TTL_SECONDS = 20 * 60 * 60
_CACHE_MAX_ENTRIES = 128
_provider_cache: OrderedDict[tuple[str, str, str, str], tuple[float, list[dict]]] = OrderedDict()
_provider_cache_lock = Lock()


def _https_url(value: object) -> str:
    url = str(value or "").strip()
    parsed = urlparse(url)
    return url if parsed.scheme == "https" and parsed.hostname else ""


def _clean_metadata(value: object, limit: int = 300) -> str:
    text = unescape(re.sub(r"<[^>]*>", " ", str(value or "")))
    return " ".join(text.split())[:limit]


def _matches_orientation(width: object, height: object, orientation: str) -> bool:
    if not isinstance(width, int) or not isinstance(height, int) or min(width, height) <= 0:
        return True
    if orientation == "landscape":
        return width >= height
    if orientation == "portrait":
        return height >= width
    ratio = width / height
    return 0.8 <= ratio <= 1.25


def _base_result(provider: str, item_id: object, title: object, image_url: object,
                 page_url: object, *, alt: object = "", creator: object = "",
                 creator_url: object = "", width: object = None, height: object = None,
                 license_name: object = "", license_url: object = "",
                 attribution: object = "", download_location: object = "") -> dict | None:
    image = _https_url(image_url)
    page = _https_url(page_url)
    if not image or not page:
        return None
    return {
        "id": str(item_id or page)[:160],
        "provider": provider,
        "title": _clean_metadata(title, 240) or "Untitled image",
        "alt": _clean_metadata(alt, 300),
        "imageUrl": image,
        "pageUrl": page,
        "creator": _clean_metadata(creator, 120),
        "creatorUrl": _https_url(creator_url),
        "width": width if isinstance(width, int) else None,
        "height": height if isinstance(height, int) else None,
        "license": _clean_metadata(license_name, 120),
        "licenseUrl": _https_url(license_url),
        "attribution": _clean_metadata(attribution, 360),
        "downloadLocation": _https_url(download_location),
    }


def _search_pexels(query: str, orientation: str) -> list[dict]:
    response = httpx.get(
        "https://api.pexels.com/v1/search",
        headers={"Authorization": config.Pexels.API_KEY.strip()},
        params={"query": query, "orientation": orientation, "size": "large", "locale": "zh-CN", "per_page": _PER_PROVIDER},
        timeout=_TIMEOUT,
    )
    response.raise_for_status()
    results = []
    for photo in response.json().get("photos", []):
        src = photo.get("src") or {}
        item = _base_result(
            "Pexels", photo.get("id"), photo.get("alt") or "Pexels photo", src.get("large"), photo.get("url"),
            alt=photo.get("alt"), creator=photo.get("photographer"), creator_url=photo.get("photographer_url"),
            width=photo.get("width"), height=photo.get("height"), license_name="Pexels License",
        )
        if item and _is_pexels_image_url(item["imageUrl"]) and urlparse(item["pageUrl"]).hostname == "www.pexels.com":
            results.append(item)
    return results


def _search_pixabay(query: str, orientation: str) -> list[dict]:
    orientation_value = {"landscape": "horizontal", "portrait": "vertical", "square": "all"}[orientation]
    response = httpx.get(
        "https://pixabay.com/api/",
        params={"key": config.ImageSearch.PIXABAY_API_KEY.strip(), "q": query[:100], "lang": "zh",
                "image_type": "photo", "orientation": orientation_value, "safesearch": "true", "per_page": _PER_PROVIDER},
        timeout=_TIMEOUT,
    )
    response.raise_for_status()
    results = []
    for photo in response.json().get("hits", []):
        if not _matches_orientation(photo.get("imageWidth"), photo.get("imageHeight"), orientation):
            continue
        user = str(photo.get("user") or "")
        user_id = photo.get("user_id")
        creator_url = f"https://pixabay.com/users/{quote(user, safe='')}-{user_id}/" if user and user_id else ""
        item = _base_result(
            "Pixabay", photo.get("id"), photo.get("tags") or "Pixabay photo",
            photo.get("webformatURL") or photo.get("previewURL"), photo.get("pageURL"),
            alt=photo.get("tags"), creator=user, creator_url=creator_url,
            width=photo.get("imageWidth"), height=photo.get("imageHeight"),
            license_name="Pixabay Content License",
        )
        if item:
            # Pixabay permits its URLs for temporary result previews, not permanent embedding.
            item["imageUrlTemporary"] = True
            results.append(item)
    return results


def _search_unsplash(query: str, orientation: str) -> list[dict]:
    response = httpx.get(
        "https://api.unsplash.com/search/photos",
        headers={"Authorization": f"Client-ID {config.ImageSearch.UNSPLASH_ACCESS_KEY.strip()}", "Accept-Version": "v1"},
        params={"query": query, "per_page": _PER_PROVIDER, "orientation": "squarish" if orientation == "square" else orientation},
        timeout=_TIMEOUT,
    )
    response.raise_for_status()
    results = []
    for photo in response.json().get("results", []):
        urls = photo.get("urls") or {}
        links = photo.get("links") or {}
        user = photo.get("user") or {}
        user_links = user.get("links") or {}
        attribution_url = str(user_links.get("html") or "")
        if attribution_url:
            attribution_url += "?utm_source=gor&utm_medium=referral"
        page_url = str(links.get("html") or "")
        if page_url:
            page_url += "?utm_source=gor&utm_medium=referral"
        item = _base_result(
            "Unsplash", photo.get("id"), photo.get("alt_description") or photo.get("description") or "Unsplash photo",
            urls.get("regular") or urls.get("small"), page_url,
            alt=photo.get("alt_description") or photo.get("description"), creator=user.get("name"), creator_url=attribution_url,
            width=photo.get("width"), height=photo.get("height"), license_name="Unsplash License",
            attribution=f"Photo by {user.get('name') or 'Unknown photographer'} on Unsplash",
            download_location=links.get("download_location"),
        )
        if item:
            # Unsplash requires hotlinking API-returned photo URLs and attribution.
            results.append(item)
    return results


def _search_openverse(query: str, orientation: str) -> list[dict]:
    response = httpx.get(
        "https://api.openverse.org/v1/images/",
        params={"q": query, "page_size": _PER_PROVIDER, "mature": "false"},
        headers={"User-Agent": "Gor image search/1.0"},
        timeout=_TIMEOUT,
    )
    response.raise_for_status()
    results = []
    for photo in response.json().get("results", []):
        width, height = photo.get("width"), photo.get("height")
        if not _matches_orientation(width, height, orientation):
            continue
        item = _base_result(
            "Openverse", photo.get("id"), photo.get("title"), photo.get("thumbnail") or photo.get("url"),
            photo.get("foreign_landing_url") or photo.get("detail_url") or photo.get("url"),
            alt=photo.get("description") or photo.get("title"), creator=photo.get("creator"),
            creator_url=photo.get("creator_url"), width=width, height=height,
            license_name=" ".join(str(x) for x in (photo.get("license"), photo.get("license_version")) if x),
            license_url=photo.get("license_url"), attribution=photo.get("attribution"),
        )
        if item:
            item["source"] = _clean_metadata(photo.get("source"), 80)
            results.append(item)
    return results


def _search_wikimedia(query: str, orientation: str) -> list[dict]:
    response = httpx.get(
        "https://commons.wikimedia.org/w/api.php",
        params={"action": "query", "generator": "search", "gsrsearch": query, "gsrnamespace": 6,
                "gsrlimit": _PER_PROVIDER, "prop": "imageinfo", "iiprop": "url|extmetadata",
                "iiurlwidth": 1000, "format": "json", "formatversion": 2},
        headers={"User-Agent": "Gor image search/1.0 (Wikimedia Commons API client)"},
        timeout=_TIMEOUT,
    )
    response.raise_for_status()
    results = []
    for page in response.json().get("query", {}).get("pages", []):
        image_info = (page.get("imageinfo") or [{}])[0]
        metadata = image_info.get("extmetadata") or {}
        width, height = image_info.get("width"), image_info.get("height")
        if not _matches_orientation(width, height, orientation):
            continue
        description = metadata.get("ImageDescription", {}).get("value")
        creator = metadata.get("Artist", {}).get("value")
        license_name = metadata.get("LicenseShortName", {}).get("value") or metadata.get("UsageTerms", {}).get("value")
        license_url = metadata.get("LicenseUrl", {}).get("value")
        attribution = metadata.get("Attribution", {}).get("value") or metadata.get("Credit", {}).get("value")
        item = _base_result(
            "Wikimedia Commons", page.get("pageid"), page.get("title", "").removeprefix("File:"),
            image_info.get("thumburl") or image_info.get("url"), image_info.get("descriptionurl"),
            alt=description, creator=creator, width=width, height=height,
            license_name=license_name, license_url=license_url, attribution=attribution,
        )
        if item:
            results.append(item)
    return results


_PROVIDERS = {
    "pexels": ("Pexels", lambda: bool(config.Pexels.API_KEY.strip()), _search_pexels),
    "pixabay": ("Pixabay", lambda: bool(config.ImageSearch.PIXABAY_API_KEY.strip()), _search_pixabay),
    "unsplash": ("Unsplash", lambda: bool(config.ImageSearch.UNSPLASH_ACCESS_KEY.strip()), _search_unsplash),
    "openverse": ("Openverse", lambda: True, _search_openverse),
    "wikimedia": ("Wikimedia Commons", lambda: True, _search_wikimedia),
}


def _credential_fingerprint(provider: str) -> str:
    if provider == "pexels":
        value = config.Pexels.API_KEY.strip()
    elif provider == "pixabay":
        value = config.ImageSearch.PIXABAY_API_KEY.strip()
    elif provider == "unsplash":
        value = config.ImageSearch.UNSPLASH_ACCESS_KEY.strip()
    else:
        value = ""
    return sha256(value.encode()).hexdigest() if value else ""


def _cached_search(provider: str, search_fn, query: str, orientation: str) -> tuple[list[dict], bool]:
    cache_key = (provider, _credential_fingerprint(provider), query, orientation)
    now = monotonic()
    with _provider_cache_lock:
        entry = _provider_cache.get(cache_key)
        if entry and now - entry[0] < _CACHE_TTL_SECONDS:
            _provider_cache.move_to_end(cache_key)
            return [dict(item) for item in entry[1]], True
    results = search_fn(query, orientation)
    with _provider_cache_lock:
        _provider_cache[cache_key] = (now, [dict(item) for item in results])
        _provider_cache.move_to_end(cache_key)
        while len(_provider_cache) > _CACHE_MAX_ENTRIES:
            _provider_cache.popitem(last=False)
    return results, False


def search_image_results(
    query: str,
    orientation: Literal["landscape", "portrait", "square"] = "landscape",
    provider: Literal["all", "pexels", "pixabay", "unsplash", "openverse", "wikimedia"] = "all",
) -> dict:
    """Shared search implementation for the agent tool and presentation images."""
    query = " ".join((query or "").split())[:120]
    if not query:
        return {"error": "请提供具体的图片搜索关键词。"}
    selected = list(_PROVIDERS) if provider == "all" else [provider]
    active = []
    skipped = []
    for key in selected:
        name, configured, search_fn = _PROVIDERS[key]
        if configured():
            active.append((key, name, search_fn))
        else:
            skipped.append({"provider": name, "status": "skipped", "reason": "未配置 API 密钥"})

    if not active:
        return {"query": query, "results": [], "providers": skipped,
                "message": "所选图片来源未配置密钥，或没有可匿名访问的来源。"}

    results: list[dict] = []
    statuses: list[dict] = list(skipped)
    with ThreadPoolExecutor(max_workers=min(len(active), 5)) as executor:
        futures = {executor.submit(_cached_search, key, search_fn, query, orientation): (key, name) for key, name, search_fn in active}
        for future in as_completed(futures):
            key, name = futures[future]
            try:
                provider_results, cached = future.result()
                status = "cached" if cached else "success" if provider_results else "empty"
                statuses.append({"provider": name, "status": status, "resultCount": len(provider_results)})
                results.extend(provider_results)
            except httpx.HTTPStatusError as exc:
                status = exc.response.status_code
                reason = "密钥无效或权限不足" if status in (401, 403) else "请求过于频繁" if status == 429 else f"服务返回 HTTP {status}"
                statuses.append({"provider": name, "status": "error", "reason": reason})
            except (httpx.HTTPError, ValueError, TypeError, KeyError):
                statuses.append({"provider": name, "status": "error", "reason": "网络错误或响应格式异常"})

    provider_order = {_PROVIDERS[key][0]: index for index, key in enumerate(selected)}
    results.sort(key=lambda item: provider_order.get(item["provider"], len(provider_order)))
    statuses.sort(key=lambda item: provider_order.get(item["provider"], len(provider_order)))
    return {"query": query, "orientation": orientation, "results": results,
            "providers": statuses}


@tool
def search_images(
    query: str,
    orientation: Literal["landscape", "portrait", "square"] = "landscape",
    provider: Literal["all", "pexels", "pixabay", "unsplash", "openverse", "wikimedia"] = "all",
) -> str:
    """Search image candidates across configured providers and preserve attribution/licensing metadata.

    Args:
        query: Specific subjects, place, scene, lighting, or composition to search for.
        orientation: Desired image orientation.
        provider: Search all configured providers, or one specific provider.
    """
    return json.dumps(search_image_results(query, orientation, provider), ensure_ascii=False)
