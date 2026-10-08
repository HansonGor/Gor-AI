"""
联网搜索工具集（底层 Provider）
================================
按"国内中文 / 海外中文 / 通用 / 语义深度 / 代码专用"五类搜索源封装。
各搜索源独立配置 API Key，缺少时自动跳过对应来源；公开 GitHub 仓库搜索可匿名回退，GitHub Code Search 仍需 Token。

对外联网工具：
- web_search(query)          普通网页检索，由 SearchOrchestrator 选择来源并 fallback
- web_reader(urls)           读取本轮搜索命中的 3–5 个公开网页正文
- search_github_code(query)  GitHub 仓库发现优先，按需检索源码

底层 Provider（保留，供 orchestrator 调用）：
- _search_doubao    豆包搜索（feedcoopapi），支持 Filter.Sites / BlockHosts
- _search_tavily    Tavily，支持 include_domains / exclude_domains
- _search_serper    Serper(Google)，支持 query 内 site: 限定
- _search_brave     Brave 独立索引
- _search_exa       Exa 语义搜索（未来 includeDomains）
- _search_github_repositories  GitHub 仓库名搜索 / 热度排序
- _search_github_code  GitHub Code Search
"""
from __future__ import annotations

import httpx
import re
from langchain_core.tools import tool

from config import config

TIMEOUT = 15.0

_GITHUB_REPO_ALIASES = {
    "antd mobile": "ant-design-mobile",
    "ant design mobile": "ant-design-mobile",
    "ant-design-mobile": "ant-design-mobile",
    "antd design mobile": "ant-design-mobile",
    "antd desgin mobile": "ant-design-mobile",
}


def _github_api_headers() -> dict[str, str]:
    token = config.Search.GITHUB_TOKEN
    headers = {"Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    return headers


def _github_public_get(url: str, *, params: dict | None = None) -> httpx.Response:
    """Public repository discovery can fall back to anonymous API access."""
    headers = _github_api_headers()
    response = httpx.get(url, headers=headers, params=params, timeout=TIMEOUT)
    if response.status_code in (401, 403) and "Authorization" in headers:
        headers.pop("Authorization", None)
        response = httpx.get(url, headers=headers, params=params, timeout=TIMEOUT)
    return response


def _normalize_repo_name(value: str) -> str:
    return re.sub(r"[^a-z0-9]", "", value.casefold())


def _github_repo_term(query: str) -> tuple[str, tuple[str, str] | None]:
    """Extract a repository locator or a compact name-search term."""
    value = (query or "").strip()
    match = re.search(r"(?:https?://)?(?:www\.)?github\.com/([\w.-]+)/([\w.-]+)", value, re.I)
    if match:
        return match.group(2).removesuffix(".git"), (match.group(1), match.group(2).removesuffix(".git"))

    match = re.search(r"(?<![\w.-])([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+)(?![\w.-])", value)
    if match:
        return match.group(2).removesuffix(".git"), (match.group(1), match.group(2).removesuffix(".git"))

    value = re.sub(r"https?://\S+", " ", value, flags=re.I)
    value = re.sub(r"\b(?:github|repo(?:sitory)?|search|find|look\s+up)\b", " ", value, flags=re.I)
    value = re.sub(
        r"仓库|项目|这个库|这个项目|搜索|搜一下|查一下|找一下|查找|请帮我|帮我|看看|一下|官方|最主流",
        " ", value, flags=re.I,
    )
    value = re.sub(r"\s+", " ", value).strip(" .,:：，;；!?！？\"'` ")
    lowered = value.casefold()
    for alias, canonical in sorted(_GITHUB_REPO_ALIASES.items(), key=lambda pair: len(pair[0]), reverse=True):
        if alias in lowered:
            return canonical, None
    return value, None


def _repository_result(repo: dict, match_kind: str = "fuzzy") -> dict:
    full_name = repo.get("full_name", "")
    stars = repo.get("stargazers_count", 0)
    description = (repo.get("description") or "").strip()
    language = repo.get("language") or "未标注语言"
    updated = (repo.get("updated_at") or "")[:10]
    details = [f"Stars: {stars}", f"主要语言: {language}"]
    if updated:
        details.append(f"最近更新: {updated}")
    if description:
        details.append(description[:240])
    return {
        "title": full_name,
        "url": repo.get("html_url", ""),
        "content": " · ".join(details),
        "source": "github/repository",
        "repository_name": full_name,
        "repository_stars": stars,
        "repository_description": description,
        "repository_match": match_kind,
    }


def _search_github_repositories(query: str, max_results: int = 8) -> list[dict]:
    """Find exact-name repositories first, then popular fuzzy name matches."""
    term, locator = _github_repo_term(query)
    if not term:
        return []
    if locator:
        owner, name = locator
        response = _github_public_get(f"https://api.github.com/repos/{owner}/{name}")
        if response.status_code == 200:
            return [_repository_result(response.json(), "exact")]
        if response.status_code not in (403, 404):
            response.raise_for_status()
        term = name

    def search_repositories(search_query: str) -> list[dict]:
        response = _github_public_get(
            "https://api.github.com/search/repositories",
            params={"q": search_query, "sort": "stars", "order": "desc", "per_page": 30},
        )
        response.raise_for_status()
        return response.json().get("items", [])

    repositories = search_repositories(f"{term} in:name")
    normalized_term = _normalize_repo_name(term)
    if not any(_normalize_repo_name(repo.get("name", "")) == normalized_term for repo in repositories):
        # If there is no exact name match, widen to description/README matches
        # so familiar product names can still surface their mainstream repo.
        broader = search_repositories(term)
        by_name = {repo.get("full_name", "").casefold(): repo for repo in repositories}
        by_name.update({repo.get("full_name", "").casefold(): repo for repo in broader})
        repositories = list(by_name.values())
    repositories.sort(key=lambda repo: (
        _normalize_repo_name(repo.get("name", "")) != normalized_term,
        -int(repo.get("stargazers_count") or 0),
        (repo.get("full_name") or "").casefold(),
    ))
    return [
        _repository_result(
            repo,
            "exact" if _normalize_repo_name(repo.get("name", "")) == normalized_term else "fuzzy",
        )
        for repo in repositories[:max_results]
    ]


# ---------------------------------------------------------------------------
# 各搜索源底层实现
# ---------------------------------------------------------------------------
def _search_doubao(query: str, max_results: int = 5,
                   sites: list[str] | None = None,
                   block_hosts: list[str] | None = None) -> list[dict]:
    """豆包搜索（火山引擎 feedcoopapi，国内中文首选）。

    sites:       限定只搜这些站点（Filter.Sites，多个用 | 分隔）
    block_hosts: 屏蔽这些站点（Filter.BlockHosts）
    """
    api_key = config.Search.DOUBAO_SEARCH_API_KEY
    if not api_key:
        return []
    filter_args: dict = {"NeedUrl": True}
    if sites:
        filter_args["Sites"] = "|".join(sites)
    if block_hosts:
        filter_args["BlockHosts"] = "|".join(block_hosts)
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
            "Filter": filter_args,
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
            "published_date": (it.get("PublishTime") or it.get("PublishDate")
                               or it.get("published_date") or it.get("publish_time")),
        })
    return out


def _search_tavily(query: str, max_results: int = 5,
                   include_domains: list[str] | None = None,
                   exclude_domains: list[str] | None = None) -> list[dict]:
    """Tavily 通用搜索。

    include_domains: 只搜这些域名（如 ["developer.mozilla.org"]）
    exclude_domains: 排除这些域名
    """
    api_key = config.Search.TAVILY_API_KEY
    if not api_key:
        return []
    from tavily import TavilyClient

    kwargs: dict = {
        "query": query,
        "search_depth": "basic",
        "max_results": max_results,
        # Keep results citable: answer-only items have no source URL and must
        # not be surfaced as if they were a verifiable web page.
        "include_answer": False,
    }
    if include_domains:
        kwargs["include_domains"] = include_domains
    if exclude_domains:
        kwargs["exclude_domains"] = exclude_domains
    resp = TavilyClient(api_key=api_key).search(**kwargs)
    items: list[dict] = []
    if resp.get("answer"):
        items.append({"title": "Tavily 摘要", "url": "", "content": resp["answer"], "source": "tavily"})
    for it in resp.get("results", []):
        items.append({
            "title": it.get("title", ""),
            "url": it.get("url", ""),
            "content": it.get("content", "")[:400],
            "source": "tavily",
            "published_date": it.get("published_date") or it.get("publishedDate"),
        })
    return items


def _search_serper(query: str, max_results: int = 5,
                   sites: list[str] | None = None) -> list[dict]:
    """Serper.dev (Google) 搜索。

    sites: 在 query 中拼 site: 限定（多个用 OR 组合）
    """
    api_key = config.Search.SERPER_API_KEY
    if not api_key:
        return []
    q = query
    if sites:
        site_q = " OR ".join(f"site:{s}" for s in sites)
        q = f"({site_q}) {query}"
    r = httpx.post(
        "https://google.serper.dev/search",
        headers={"X-API-KEY": api_key, "Content-Type": "application/json"},
        json={"q": q, "num": max_results, "hl": "zh-cn"},
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
            "date_hint": it.get("date"),
        })
    return out


def _search_brave(query: str, max_results: int = 5,
                  sites: list[str] | None = None) -> list[dict]:
    """Brave Search 独立索引；site: 操作符用于站点限定。"""
    api_key = config.Search.BRAVE_API_KEY
    if not api_key:
        return []
    r = httpx.get(
        "https://api.search.brave.com/res/v1/web/search",
        headers={"X-Subscription-Token": api_key, "Accept": "application/json"},
        params={"q": _site_query(query, sites), "count": max_results, "search_lang": "zh-hans"},
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
            "published_date": it.get("published_date") or it.get("publishedDate"),
            "date_hint": it.get("page_age"),
        })
    return out


def _site_query(query: str, sites: list[str] | None) -> str:
    if not sites:
        return query
    site_query = " OR ".join(f"site:{site}" for site in sites)
    return f"({site_query}) {query}"


def _search_exa(query: str, max_results: int = 5,
                sites: list[str] | None = None) -> list[dict]:
    """Exa 语义搜索，includeDomains 提供原生域名约束。"""
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
            **({"includeDomains": sites} if sites else {}),
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
            "published_date": it.get("publishedDate") or it.get("published_date"),
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


# ---------------------------------------------------------------------------
# 暴露给 LLM 的工具（统一入口）
# ---------------------------------------------------------------------------
_SEARCH_RESULT_MARKER = "__GOR_SEARCH_RESULT__"


@tool
def web_search(query: str, original_query: str = "", user_language: str = "") -> str:
    """
    统一联网搜索入口。系统会自动识别搜索意图（官方事实 official_fact /
    用户真实体验 user_experience / 技术文档 technical_docs / 代码示例
    code_example / 新闻 news / 深度调研 deep_research / 视觉灵感
    visual_inspiration），选择优先来源。新闻来源按地区覆盖国内外主流媒体；
    新闻/最新版本按“权威来源搜索 → web_reader 读取 3–5 篇正文 → 综合回答”执行；
    新闻优先查找当日和昨天发布的报道，再补充近期重磅新闻；保留并展示搜索源
    提供的发布日期，区分发布时间与事件时间，不将旧闻说成最新。
    GitHub/代码意图优先 GitHub Code Search，再补充技术官方文档和网页结果。
    搜索词沿用用户原始语言，优先来源不足时自动扩大检索范围。

    适合：新闻资讯、官方信息（开放时间/政策/价格）、旅游攻略、美食推荐、
    技术文档/教程、开源代码示例、深度技术调研、设计灵感等一切需要联网资料的场景。

    返回结果每条带 [S1]、[S2] 等来源标记：回答中引用搜索结果时，在对应
    事实后标注来源标记（如"广州陈家祠开放时间为 9:00-17:30[S2]"），
    禁止编造 URL 或搜索结果中不存在的网站。

    Args:
        query: 搜索关键词或问题，例如"广州陈家祠开放时间"、"React Web Worker esbuild-wasm"
        original_query: 本轮用户原始问题。Agent 会注入，用于保持搜索语言和识别复合意图。
        user_language: 本轮用户语言代码（如 zh / en），Agent 会注入。
    """
    from tools.search_orchestrator import orchestrator, format_results

    payload = orchestrator.run(query, original_query=original_query, user_language=user_language)
    # Keep the result payload request-local. A module-level "last search" is
    # racy when multiple chats search at the same time and can cross-link sources.
    import json
    return _SEARCH_RESULT_MARKER + json.dumps({
        "text": format_results(payload),
        "payload": payload,
    }, ensure_ascii=False)
