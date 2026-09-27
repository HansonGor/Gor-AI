"""
联网搜索工具集
==============
按"国内中文 / 海外中文 / 通用 / 语义深度 / 代码专用"五类搜索源封装。
每个源独立配置 API Key，缺哪个 key 哪个源就自动跳过并返回提示，不阻塞其他源。

暴露给 LLM 的工具：
- web_search(query)             通用联网搜索，默认 Tavily，必要时自动补充其他源
- web_search_overseas(query)    面向海外视角的中文/英文资料，走 Serper(Google)
- web_search_deep(query)        深度技术调研、技术博客、论文，走 Exa 语义搜索
- search_github_code(query)    GitHub 开源代码/仓库/demo 检索
"""
from __future__ import annotations

import httpx
from langchain_core.tools import tool

from config import config

TIMEOUT = 15.0


# ---------------------------------------------------------------------------
# 各搜索源底层实现
# ---------------------------------------------------------------------------
def _search_doubao(query: str, max_results: int = 5) -> list[dict]:
    """豆包搜索（火山引擎 feedcoopapi，国内中文首选）。"""
    api_key = config.Search.DOUBAO_SEARCH_API_KEY
    if not api_key:
        return []
    r = httpx.post(
        "https://open.feedcoopapi.com/search_api/web_search",
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        json={
            "Query": query[:100],
            "SearchType": "web",
            "Count": max_results,
            "Filter": {"NeedUrl": True},
            "QueryControl": {"QueryRewrite": False},
        },
        timeout=TIMEOUT,
    )
    r.raise_for_status()
    data = r.json()
    err = data.get("ResponseMetadata", {}).get("Error")
    if err:
        raise RuntimeError(f"doubao search error: {err}")
    result = data.get("Result") or {}
    out = []
    for it in result.get("WebResults", [])[:max_results]:
        # Summary 是正文中与 query 相关的片段，适合喂给 LLM；Snippet 太短
        content = it.get("Summary") or it.get("Snippet") or ""
        out.append({
            "title": it.get("Title", ""),
            "url": it.get("Url", ""),
            "content": content[:500],
            "source": f"doubao/{it.get('SiteName', 'web')}",
        })
    return out


def _search_tavily(query: str, max_results: int = 5) -> list[dict]:
    """Tavily 通用搜索。"""
    api_key = config.Search.TAVILY_API_KEY
    if not api_key:
        return []
    from tavily import TavilyClient

    resp = TavilyClient(api_key=api_key).search(
        query=query, search_depth="basic", max_results=max_results, include_answer=True
    )
    items: list[dict] = []
    if resp.get("answer"):
        items.append({"title": "Tavily 摘要", "url": "", "content": resp["answer"], "source": "tavily"})
    for it in resp.get("results", []):
        items.append({
            "title": it.get("title", ""),
            "url": it.get("url", ""),
            "content": it.get("content", "")[:400],
            "source": "tavily",
        })
    return items


def _search_serper(query: str, max_results: int = 5) -> list[dict]:
    """Serper.dev (Google) 搜索。"""
    api_key = config.Search.SERPER_API_KEY
    if not api_key:
        return []
    r = httpx.post(
        "https://google.serper.dev/search",
        headers={"X-API-KEY": api_key, "Content-Type": "application/json"},
        json={"q": query, "num": max_results, "hl": "zh-cn"},
        timeout=TIMEOUT,
    )
    r.raise_for_status()
    data = r.json()
    out = []
    for it in data.get("organic", [])[:max_results]:
        out.append({
            "title": it.get("title", ""),
            "url": it.get("link", ""),
            "content": it.get("snippet", ""),
            "source": "serper/google",
        })
    return out


def _search_brave(query: str, max_results: int = 5) -> list[dict]:
    """Brave Search 独立索引。"""
    api_key = config.Search.BRAVE_API_KEY
    if not api_key:
        return []
    r = httpx.get(
        "https://api.search.brave.com/res/v1/web/search",
        headers={"X-Subscription-Token": api_key, "Accept": "application/json"},
        params={"q": query, "count": max_results, "search_lang": "zh-hans"},
        timeout=TIMEOUT,
    )
    r.raise_for_status()
    data = r.json()
    out = []
    for it in data.get("web", {}).get("results", [])[:max_results]:
        out.append({
            "title": it.get("title", ""),
            "url": it.get("url", ""),
            "content": it.get("description", ""),
            "source": "brave",
        })
    return out


def _search_exa(query: str, max_results: int = 5) -> list[dict]:
    """Exa 语义搜索。"""
    api_key = config.Search.EXA_API_KEY
    if not api_key:
        return []
    r = httpx.post(
        "https://api.exa.ai/search",
        headers={"x-api-key": api_key, "Content-Type": "application/json"},
        json={
            "query": query,
            "numResults": max_results,
            "contents": {"text": {"maxCharacters": 600}},
            "type": "auto",
        },
        timeout=TIMEOUT,
    )
    r.raise_for_status()
    data = r.json()
    out = []
    for it in data.get("results", [])[:max_results]:
        out.append({
            "title": it.get("title", ""),
            "url": it.get("url", ""),
            "content": (it.get("text") or "")[:400],
            "source": "exa",
        })
    return out


def _search_github_code(query: str, max_results: int = 5) -> list[dict]:
    """GitHub Code Search。"""
    token = config.Search.GITHUB_TOKEN
    if not token:
        return []
    r = httpx.get(
        "https://api.github.com/search/code",
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
        },
        params={"q": query, "per_page": max_results},
        timeout=TIMEOUT,
    )
    r.raise_for_status()
    data = r.json()
    out = []
    for it in data.get("items", [])[:max_results]:
        repo = it.get("repository", {})
        out.append({
            "title": f"{repo.get('full_name', '')} :: {it.get('name', '')}",
            "url": it.get("html_url", ""),
            "content": f"path: {it.get('path', '')} · repo stars: {repo.get('stargazers_count', 0)}",
            "source": "github",
        })
    return out


def _format(items: list[dict]) -> str:
    if not items:
        return ""
    lines = []
    for i, it in enumerate(items, 1):
        title = it.get("title", "").strip()
        url = it.get("url", "").strip()
        content = it.get("content", "").strip().replace("\n", " ")
        src = it.get("source", "")
        head = f"{i}. {title}"
        if src:
            head += f"  [{src}]"
        lines.append(head)
        if content:
            lines.append(f"   {content}")
        if url:
            lines.append(f"   来源：{url}")
    return "\n".join(lines)


def _missing_keys(hit: list[str]) -> str:
    """根据实际命中的源反推哪些 key 没配，返回提示。"""
    known = {
        "tavily": ("TAVILY_API_KEY", _search_tavily),
        "serper/google": ("SERPER_API_KEY", _search_serper),
        "brave": ("BRAVE_API_KEY", _search_brave),
        "exa": ("EXA_API_KEY", _search_exa),
        "github": ("GITHUB_TOKEN", _search_github_code),
    }
    configured = {k for k, (_, fn) in known.items() if fn("__probe__", 1)}
    missing = [env for k, (env, _) in known.items() if k not in configured and k in hit]
    return missing


# ---------------------------------------------------------------------------
# 暴露给 LLM 的工具
# ---------------------------------------------------------------------------
@tool
def web_search(query: str) -> str:
    """
    通用联网搜索，获取实时资讯、最新技术、社区讨论等。
    搜索源优先级：豆包搜索（国内中文）→ Tavily → Brave。
    适合：国内技术教程、最新新闻、产品文档、一般性事实查询。

    Args:
        query: 搜索关键词，例如"React 19 新特性"、"2026 年 AI 模型对比"
    """
    try:
        items = _search_doubao(query, max_results=5)
        used = "doubao"
        if not items:
            items = _search_tavily(query, max_results=5)
            used = "tavily"
        if not items:
            items = _search_brave(query, max_results=5)
            used = "brave"
        if not items:
            return "搜索失败：DOUBAO/TAVILY/BRAVE API KEY 均未配置，请在 Server/.env 中至少配置一个。"
        body = _format(items)
        return f"【搜索源：{used}】\n{body}"
    except Exception as e:
        return f"搜索失败：{type(e).__name__}: {e}"


@tool
def web_search_overseas(query: str) -> str:
    """
    面向海外视角的中文/英文资料搜索（Google）。
    适合：GitHub issue、国际技术社区、海外中文博客、英文官方文档、中英文混杂资料。
    不适合：国内本土资讯（用 web_search）、代码片段（用 search_github_code）。

    Args:
        query: 中英文关键词，例如"LangGraph memory architecture site:github.com"
    """
    try:
        items = _search_serper(query, max_results=6)
        if not items:
            return "搜索失败：SERPER_API_KEY 未配置，请在 Server/.env 中设置。"
        return f"【搜索源：serper/google】\n{_format(items)}"
    except Exception as e:
        return f"搜索失败：{type(e).__name__}: {e}"


@tool
def web_search_deep(query: str) -> str:
    """
    深度技术调研搜索（语义向量）。
    适合：技术博客、论文、深度解释文章、概念调研；不适合简单事实、简单代码示例。

    Args:
        query: 描述你要调研的主题或问题，例如"how does vector database indexing affect retrieval latency"
    """
    try:
        items = _search_exa(query, max_results=5)
        if not items:
            return "搜索失败：EXA_API_KEY 未配置，请在 Server/.env 中设置。"
        return f"【搜索源：exa】\n{_format(items)}"
    except Exception as e:
        return f"搜索失败：{type(e).__name__}: {e}"


@tool
def search_github_code(query: str) -> str:
    """
    在 GitHub 上搜索开源代码、仓库、demo 实现。
    当需要参考开源示例、查找项目源码、确认某个库的用法时优先使用本工具。
    不要用普通网页搜索替代。

    Args:
        query: GitHub 搜索语法，例如"useWebSocket react-native in:file language:TypeScript"
    """
    token = config.Search.GITHUB_TOKEN
    if not token:
        return "搜索失败：GITHUB_TOKEN 未配置，请在 Server/.env 中设置。"
    try:
        items = _search_github_code(query, max_results=6)
        if not items:
            return f"GitHub Code Search 未找到与「{query}」匹配的代码结果。请尝试放宽关键词、去掉 language/repo 限定符，或改用 web_search_overseas 搜索仓库介绍。"
        return f"【搜索源：github code】\n{_format(items)}"
    except Exception as e:
        return f"GitHub Code Search 调用失败：{type(e).__name__}: {e}"
