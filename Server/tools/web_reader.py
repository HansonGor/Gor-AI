"""Read a small number of public article pages returned by web_search."""
from __future__ import annotations

import ipaddress
import hashlib
import json
import re
import socket
import time
from html.parser import HTMLParser
from urllib.parse import urljoin, urlparse
from typing import Annotated

import httpx
from langchain_core.tools import tool
from pydantic import Field


MAX_PAGES = 8
MAX_PAGE_BYTES = 2_000_000
MAX_ARTICLE_CHARS = 8_000
REQUEST_TIMEOUT = 12.0
_USER_AGENT = "GorResearchReader/1.0 (+https://gor.local; public article extraction)"


def _public_hostname(hostname: str) -> bool:
    host = (hostname or "").rstrip(".").casefold()
    if not host or host == "localhost" or host.endswith((".localhost", ".local", ".internal", ".test")):
        return False
    try:
        return ipaddress.ip_address(host).is_global
    except ValueError:
        pass
    try:
        addresses = socket.getaddrinfo(host, None, type=socket.SOCK_STREAM)
    except OSError:
        return False
    resolved = {item[4][0].split("%", 1)[0] for item in addresses}
    return bool(resolved) and all(
        _is_global_ip(address) for address in resolved
    )


def _is_global_ip(value: str) -> bool:
    try:
        return ipaddress.ip_address(value).is_global
    except ValueError:
        return False


def _validate_public_url(value: str) -> str:
    url = (value or "").strip()
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise ValueError("仅支持公开网页的 HTTP/HTTPS 地址。")
    if parsed.username or parsed.password:
        raise ValueError("不接受含账号凭据的网页地址。")
    if not _public_hostname(parsed.hostname):
        raise ValueError("网页地址无法确认是公开互联网域名，已拒绝读取。")
    return url


class _ArticleParser(HTMLParser):
    _SKIP = {"script", "style", "noscript", "svg", "canvas", "iframe", "form", "nav", "footer", "aside"}
    _BLOCKS = {"p", "li", "blockquote", "h1", "h2", "h3", "h4", "td", "th"}
    _SEPARATORS = {"article", "main", "section", "div", "br", "hr"}

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.meta: dict[str, str] = {}
        self.title_text: list[str] = []
        self.blocks: list[tuple[str, bool]] = []
        self.current: list[str] = []
        self.current_tag = ""
        self.skip_depth = 0
        self.article_depth = 0
        self.title_depth = 0
        self.jsonld_depth = 0
        self.jsonld_parts: list[str] = []
        self.jsonld_documents: list[object] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        tag = tag.casefold()
        values = {key.casefold(): value or "" for key, value in attrs}
        if tag == "meta":
            key = (values.get("property") or values.get("name") or values.get("itemprop") or "").casefold()
            content = values.get("content", "").strip()
            if key and content:
                self.meta.setdefault(key, content)
            return
        if tag == "link" and "canonical" in values.get("rel", "").casefold():
            if values.get("href"):
                self.meta.setdefault("canonical", values["href"])
            return
        if tag in self._SKIP:
            self.skip_depth += 1
            if tag == "script" and "ld+json" in values.get("type", "").casefold():
                self.jsonld_depth = self.skip_depth
                self.jsonld_parts = []
            return
        if self.skip_depth:
            return
        if tag == "time" and values.get("datetime"):
            self.meta.setdefault("time:datetime", values["datetime"])
        if tag in {"article", "main"}:
            self.article_depth += 1
        if tag == "title":
            self.title_depth += 1
        if tag in self._BLOCKS:
            self._flush()
            self.current_tag = tag
        elif tag in self._SEPARATORS:
            self._flush()

    def handle_endtag(self, tag: str) -> None:
        tag = tag.casefold()
        if tag in self._SKIP and self.skip_depth:
            if tag == "script" and self.jsonld_depth == self.skip_depth and self.jsonld_parts:
                try:
                    self.jsonld_documents.append(json.loads("".join(self.jsonld_parts)))
                except (json.JSONDecodeError, TypeError):
                    pass
                self.jsonld_depth = 0
            self.skip_depth -= 1
            return
        if self.skip_depth:
            return
        if tag in self._BLOCKS:
            self._flush()
        elif tag in self._SEPARATORS:
            self._flush()
        if tag in {"article", "main"} and self.article_depth:
            self.article_depth -= 1
        if tag == "title" and self.title_depth:
            self.title_depth -= 1

    def handle_data(self, data: str) -> None:
        text = re.sub(r"\s+", " ", data).strip()
        if not text:
            return
        if self.skip_depth:
            if self.jsonld_depth and self.jsonld_depth == self.skip_depth:
                self.jsonld_parts.append(data)
            return
        if self.title_depth:
            self.title_text.append(text)
        if self.current_tag:
            self.current.append(text)
        elif len(text) > 1:
            self.blocks.append((text, self.article_depth > 0))

    def _flush(self) -> None:
        text = " ".join(self.current).strip()
        if text:
            self.blocks.append((text, self.article_depth > 0))
        self.current = []
        self.current_tag = ""


def _walk_jsonld(value: object):
    if isinstance(value, dict):
        yield value
        graph = value.get("@graph")
        if isinstance(graph, list):
            yield from _walk_jsonld(graph)
    elif isinstance(value, list):
        for item in value:
            yield from _walk_jsonld(item)


def _author_text(value: object) -> str:
    if isinstance(value, str):
        return value.strip()
    if isinstance(value, list):
        return ", ".join(filter(None, (_author_text(item) for item in value)))
    if isinstance(value, dict):
        return str(value.get("name") or "").strip()
    return ""


def _tokens(value: str) -> set[str]:
    lowered = value.casefold()
    tokens = set(re.findall(r"[a-z0-9][a-z0-9.+#_-]{1,}", lowered))
    chinese = re.findall(r"[\u3400-\u9fff]", lowered)
    tokens.update("".join(chinese[i:i + 2]) for i in range(max(0, len(chinese) - 1)))
    return tokens


def _extract_article(html: str, url: str, focus: str = "", start_char: int = 0) -> dict:
    parser = _ArticleParser()
    parser.feed(html)
    parser.close()
    jsonld = [entry for document in parser.jsonld_documents for entry in _walk_jsonld(document)]
    article_nodes = [entry for entry in jsonld if any(
        token in str(entry.get("@type", "")).casefold() for token in ("article", "newsarticle", "blogposting")
    )]
    node = article_nodes[0] if article_nodes else {}
    title = (parser.meta.get("og:title") or parser.meta.get("twitter:title")
             or str(node.get("headline") or node.get("name") or "")
             or " ".join(parser.title_text)).strip()
    if not title:
        title = "网页正文"
    paragraphs = [text for text, _ in parser.blocks if len(text) >= 30]
    article_paragraphs = [text for text, in_article in parser.blocks if in_article and len(text) >= 30]
    if article_paragraphs:
        paragraphs = article_paragraphs
    if len(" ".join(paragraphs)) < 240 and isinstance(node.get("articleBody"), str):
        json_body = re.sub(r"\s+", " ", node["articleBody"]).strip()
        if len(json_body) > len(" ".join(paragraphs)):
            paragraphs = [json_body]
    full_body = "\n\n".join(paragraphs)
    start_char = max(0, int(start_char))
    body = full_body[start_char:start_char + MAX_ARTICLE_CHARS]
    end_char = start_char + len(body)
    published = next((value for value in (
        parser.meta.get("article:published_time"), parser.meta.get("og:published_time"),
        parser.meta.get("datepublished"), parser.meta.get("pubdate"),
        parser.meta.get("publishdate"), parser.meta.get("parsely-pub-date"),
        parser.meta.get("sailthru.date"), parser.meta.get("dc.date.issued"),
        parser.meta.get("dc.date"), parser.meta.get("date"), parser.meta.get("time:datetime"),
        node.get("datePublished"), node.get("dateCreated"),
    ) if isinstance(value, str) and value.strip()), "")
    author = (parser.meta.get("author") or parser.meta.get("article:author")
              or _author_text(node.get("author")) or "")
    focus_tokens = _tokens(focus)
    indexed = list(enumerate(paragraphs))
    if focus_tokens:
        indexed.sort(key=lambda pair: (
            -len(focus_tokens & _tokens(pair[1])), -min(len(pair[1]), 600), pair[0],
        ))
    key_paragraphs = [text[:700] for _, text in indexed[:3]]
    return {
        "title": title[:300],
        "body": body,
        "description": (parser.meta.get("og:description") or parser.meta.get("description") or "")[:500],
        "published_at": str(published).strip()[:100],
        "author": str(author).strip()[:200],
        "url": url,
        "key_paragraphs": key_paragraphs,
        "total_body_chars": len(full_body),
        "body_fingerprint": hashlib.sha256(full_body.encode("utf-8")).hexdigest(),
        "body_start_char": start_char,
        "body_truncated": start_char > 0 or end_char < len(full_body),
        "has_more": end_char < len(full_body),
        "next_start_char": end_char if end_char < len(full_body) else None,
        "reading_note": ("当前正文仅为文章片段，不能宣称已完整核实；必要时以 next_start_char 继续读取同一 URL。"
                         if start_char > 0 or end_char < len(full_body) else ""),
    }


def _read_one(url: str, focus: str, start_char: int = 0) -> dict:
    started = time.perf_counter()
    current = _validate_public_url(url)
    headers = {"User-Agent": _USER_AGENT, "Accept": "text/html,application/xhtml+xml"}
    # Honor the server's configured HTTP(S) proxy so the reader can use the
    # same outbound route as the search providers. The hostname is still
    # resolved and checked before every request/redirect above.
    with httpx.Client(timeout=REQUEST_TIMEOUT, follow_redirects=False, trust_env=True) as client:
        for _ in range(4):
            current = _validate_public_url(current)
            with client.stream("GET", current, headers=headers) as response:
                if response.status_code in {301, 302, 303, 307, 308}:
                    location = response.headers.get("location")
                    if not location:
                        raise ValueError("网页返回了无目标地址的跳转。")
                    current = urljoin(current, location)
                    continue
                response.raise_for_status()
                media_type = response.headers.get("content-type", "").casefold()
                if media_type and not any(kind in media_type for kind in ("text/html", "application/xhtml+xml")):
                    raise ValueError("该链接不是可读取的 HTML 新闻/文章页面。")
                chunks: list[bytes] = []
                total = 0
                for chunk in response.iter_bytes():
                    total += len(chunk)
                    if total > MAX_PAGE_BYTES:
                        raise ValueError("网页正文超过安全读取上限。")
                    chunks.append(chunk)
                encoding = response.encoding or "utf-8"
                html = b"".join(chunks).decode(encoding, errors="replace")
                extracted_at = time.perf_counter()
                page = _extract_article(html, url, focus, start_char)
                page["timings"] = {
                    "download_ms": round((extracted_at - started) * 1000),
                    "extraction_ms": round((time.perf_counter() - extracted_at) * 1000),
                }
                return page
    raise ValueError("网页跳转次数过多。")


def page_has_evidence(page: dict) -> bool:
    body = page.get("body")
    return isinstance(body, str) and bool(body) and (
        len(body) >= 80 or (page.get("body_start_char", 0) > 0 and page.get("total_body_chars", 0) >= 80)
    )


def read_web_pages(urls: list[str], query: str = "", max_pages: int = MAX_PAGES, start_char: int = 0) -> dict:
    selected = list(dict.fromkeys(url.strip() for url in (urls or []) if isinstance(url, str) and url.strip()))
    limit = min(MAX_PAGES, max(1, int(max_pages or MAX_PAGES)))
    pages, failures = [], []
    for url in selected[:limit]:
        started = time.perf_counter()
        try:
            page = _read_one(url, query, start_char) if start_char else _read_one(url, query)
            pages.append(page)
            print("[ReaderTiming] " + json.dumps({"success": True, "cache_hit": False,
                  "elapsed_ms": round((time.perf_counter() - started) * 1000),
                  **page.get("timings", {}), "body_chars": len(page.get("body", "")),
                  "truncated": page.get("body_truncated", False), "start_char": start_char}))
        except Exception as exc:  # isolated page failures must not drop other articles
            failures.append({"url": url[:1000], "error": f"{type(exc).__name__}: {str(exc)[:240]}"})
            print("[ReaderTiming] " + json.dumps({"success": False, "cache_hit": False,
                  "elapsed_ms": round((time.perf_counter() - started) * 1000), "error_type": type(exc).__name__}))
    return {
        "success": any(page_has_evidence(page) for page in pages),
        "pages": pages,
        "failures": failures,
        "requested_pages": min(len(selected), limit),
        "max_pages": MAX_PAGES,
    }


@tool
def web_reader(urls: list[str], query: str = "", max_pages: int = MAX_PAGES,
               start_char: Annotated[int, Field(ge=0)] = 0) -> str:
    """读取 web_search 本轮命中的公开文章页面，最多 8 篇。

    传入 web_search 返回的精确 URL，选择 3–8 篇；综合咨询优先 5–8 篇，聚焦问题按需读取，不凑数。提取标题、
    正文、发布时间、作者、原链接及关键段落；页面不可读时返回单页失败原因。
    只读取公开 HTTP/HTTPS 网页，不访问本机/内网地址、文件 URL 或任意附件。
    正文超过单次容量时返回 body_truncated、has_more、next_start_char，不能把片段当成全文。
    需核实后续内容时，仅传目标 URL，并将 start_char 设为 next_start_char，逐段补读。
    后续读取重新获取网页；若 snapshot_changed 为真或 body_fingerprint 变化，需从起始段重新核实，不拼接不同版本。
    """
    result = read_web_pages(urls, query=query, max_pages=max_pages, start_char=start_char)
    return json.dumps(result, ensure_ascii=False)


__all__ = ["web_reader", "read_web_pages", "_extract_article", "_validate_public_url"]
