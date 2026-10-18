"""单次 Agent 运行内的证据账本：登记本轮真实检索/读取到的来源，供回答核验使用。

只登记已执行工具的结果，不发起网络请求；不跨轮、不跨会话保存。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass
class EvidenceSource:
    source_id: str
    url: str = ""
    title: str = ""
    snippet: str = ""
    published_date: str = ""
    date_hint: str = ""
    page_text: list[str] = field(default_factory=list)
    page_published_at: str = ""


class EvidenceLedger:
    def __init__(self) -> None:
        self._sources: dict[str, EvidenceSource] = {}

    def __bool__(self) -> bool:
        return bool(self._sources)

    def __len__(self) -> int:
        return len(self._sources)

    @property
    def source_ids(self) -> set[str]:
        return set(self._sources)

    def get(self, source_id: str) -> EvidenceSource | None:
        return self._sources.get(source_id)

    def add_source(self, source: dict[str, Any]) -> None:
        """登记 web_search / search_github_code 返回的一条结果（sourceId 已按本轮统一编号）。"""
        source_id = source.get("sourceId") if isinstance(source, dict) else None
        if not isinstance(source_id, str) or not source_id:
            return
        entry = self._sources.setdefault(source_id, EvidenceSource(source_id))
        entry.url = str(source.get("url") or entry.url)
        entry.title = str(source.get("title") or entry.title)
        if len(str(source.get("snippet") or "")) > len(entry.snippet):
            entry.snippet = str(source.get("snippet"))
        entry.published_date = str(source.get("publishedDate") or entry.published_date)
        entry.date_hint = str(source.get("dateHint") or entry.date_hint)

    def add_page(self, page: dict[str, Any]) -> None:
        """登记 web_reader 读取到的页面正文；只接受已关联到本轮来源编号的页面。"""
        source_id = page.get("sourceId") if isinstance(page, dict) else None
        entry = self._sources.get(source_id) if isinstance(source_id, str) else None
        if entry is None:
            return
        paragraphs = page.get("key_paragraphs") if isinstance(page.get("key_paragraphs"), list) else []
        text = "\n".join([str(page.get("body") or ""), *(str(p) for p in paragraphs)]).strip()
        if text:
            entry.page_text.append(text)
        entry.page_published_at = str(page.get("published_at") or entry.page_published_at)
