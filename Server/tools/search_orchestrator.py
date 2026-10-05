"""
SearchOrchestrator —— 统一搜索编排层
=====================================
User Query
  → Search Intent           （意图识别：official_fact / user_experience /
                              technical_docs / code_example / news /
                              deep_research / visual_inspiration）
  → Source Type             （preferred domain / general web / github）
  → Preferred Domains       （意图 + 关键词驱动的优先来源域名）
  → Provider                （豆包 / Tavily / Serper / Brave / Exa / GitHub）
  → Unified Results         （统一结果结构）

设计原则：
1. 对外只暴露 web_search 一个工具，Agent 不感知底层多 Provider。
2. "优先网站"不是只搜这些网站：先查 preferred domains，结果不足自动扩大到
   普通 Web Search（sourceType 区分 preferred / general）。
3. Provider 抛异常时继续 fallback（不是只有空结果才降级）。
4. 不为小红书等平台新增专用 Skill / 爬虫；没有官方 API 时仅通过现有
   Web Search 搜索公开可索引页面，搜不到就正常回退 Web，绝不伪造结果。
"""
from __future__ import annotations

import re
from concurrent.futures import ThreadPoolExecutor, wait
from urllib.parse import parse_qsl, urlencode, urlparse, urlunparse

from tools.web_search import (
    _search_doubao,
    _search_tavily,
    _search_serper,
    _search_brave,
    _search_exa,
    _search_github_code,
)

# ---------------------------------------------------------------------------
# 常量
# ---------------------------------------------------------------------------
MIN_PREFERRED = 3      # 命中优先来源的最少条数，不足则扩大搜索
MIN_TOTAL = 5          # 最终最少条数
MAX_RESULTS = 8        # 返回给模型的结果上限
PROVIDER_TIMEOUT_SECONDS = 18
_PROVIDER_POOL = ThreadPoolExecutor(max_workers=8, thread_name_prefix="gor-search")

INTENTS = [
    "official_fact",
    "user_experience",
    "technical_docs",
    "code_example",
    "news",
    "deep_research",
    "visual_inspiration",
]

# ---------------------------------------------------------------------------
# 意图识别（轻量规则，按得分取最高；零命中走默认）
# ---------------------------------------------------------------------------
_INTENT_RULES: list[tuple[str, list[str]]] = [
    ("code_example", [
        "源码", "源代码", "代码", "github", "repo", "example", "demo",
        "实现", "组件写法", "函数", "示例", "怎么写", "开源", "code", "implementation",
    ]),
    ("technical_docs", [
        "文档", "官方文档", "api", "sdk", "用法", "参数", "报错", "documentation",
        "reference", "mdn", "教程", "手册", "配置", "react", "vue", "node",
        "web worker", "esbuild", "wasm", "typescript", "javascript", "python",
        "docker", "llm", "langchain", "fastapi", "怎么用", "如何使用", "tutorial",
    ]),
    ("news", [
        "新闻", "最新", "今日", "热点", "发布", "实时", "行情", "涨跌",
        "突发", "消息", "更新", "news", "breaking",
    ]),
    ("official_fact", [
        "开放时间", "门票", "官网", "价格", "政策", "规定", "电话", "地址",
        "营业时间", "费用", "签证", "报名", "时间", "几点", "怎么去", "官方",
        "开放", "hours", "opening", "ticket", "official", "schedule",
    ]),
    ("user_experience", [
        "攻略", "推荐", "值得", "体验", "测评", "踩坑", "种草", "避雷",
        "好玩", "探店", "好吃", "哪家", "哪里", "值得吃", "行程", "旅游",
        "三天", "两夜", "攻略", "review", "experience", "trip",
    ]),
    ("deep_research", [
        "原理", "机制", "调研", "论文", "综述", "对比", "架构", "深入",
        "分析", "研究", "benchmark", "survey", "paper", "deep dive",
    ]),
    ("visual_inspiration", [
        "设计", "模板", "配色", "风格", "海报", "ppt", "灵感", "ui",
        "视觉", "布局", "页面", "design", "template", "inspiration",
    ]),
]

# 技术词汇兜底：英文技术查询无命中时归为 technical_docs
_TECH_HINT = re.compile(
    r"(react|vue|angular|node|npm|webpack|vite|esbuild|wasm|worker|typescript|"
    r"javascript|python|java|golang|docker|kubernetes|llm|rag|langchain|"
    r"fastapi|flask|django|sql|database|api|sdk|component|hook|css|html|"
    r"git|github|linux|nginx|redis|postgres|mysql)"
)


def classify_intent(query: str) -> str:
    q = query.lower().strip()
    if not q:
        return "user_experience"

    score: dict[str, int] = {}
    for intent, keywords in _INTENT_RULES:
        for kw in keywords:
            if kw in q:
                score[intent] = score.get(intent, 0) + 1

    if not score:
        if _TECH_HINT.search(q):
            return "technical_docs"
        return "user_experience"

    # 并列最高时按 INTENTS 定义的优先级取更"具体"的意图
    best_score = max(score.values())
    candidates = [i for i, s in score.items() if s == best_score]
    # 具体性优先级：code_example > official_fact > user_experience > news
    #            > technical_docs > deep_research > visual_inspiration
    priority = {
        "code_example": 0, "official_fact": 1, "user_experience": 2,
        "news": 3, "technical_docs": 4, "deep_research": 5,
        "visual_inspiration": 6,
    }
    return min(candidates, key=lambda i: priority[i])


# ---------------------------------------------------------------------------
# Preferred Domains（意图 + 关键词微调）
# ---------------------------------------------------------------------------
_BASE_DOMAINS: dict[str, list[str]] = {
    "official_fact": [
        "gov.cn", "mct.gov.cn", "travelchina.gov.cn",
        "unesco.org", "enjoyholiday.com", "ctrip.com",
    ],
    "user_experience": [
        "xiaohongshu.com", "zhihu.com", "mafengwo.cn",
        "ctrip.com", "dianping.com", "qunar.com",
    ],
    "technical_docs": [
        "developer.mozilla.org", "docs.python.org", "react.dev",
        "vuejs.org", "nodejs.org", "vitejs.dev", "webpack.js.org",
        "esbuild.github.io", "developer.chrome.com", "developers.google.com",
    ],
    "news": [
        "news.cn", "people.com.cn", "xinhuanet.com", "gov.cn",
        "thepaper.cn", "36kr.com", "ithome.com",
    ],
    "deep_research": [
        "arxiv.org", "semanticscholar.org", "acm.org", "ieee.org",
        "arxiv.org", "jmlr.org", "aclweb.org",
    ],
    "visual_inspiration": [
        "xiaohongshu.com", "pitch.com", "canva.com", "envato.com",
        "slidesgo.com", "slidescarnival.com", "create.microsoft.com",
        "officeplus.cn", "ypppt.com", "behance.net", "dribbble.com",
    ],
}

_QUERY_HINTS: list[tuple[str, str, list[str]]] = [
    # (关键词, intent 限定, 追加域名) —— intent 限定为 None 表示任意
    ("美食", "user_experience", ["dianping.com", "xiaohongshu.com", "meituan.com"]),
    ("旅游", "user_experience", ["ctrip.com", "mafengwo.cn", "qunar.com", "travelchina.gov.cn"]),
    ("景区", "official_fact", ["gov.cn", "travelchina.gov.cn"]),
    ("ppt", "visual_inspiration", ["pitch.com", "canva.com", "envato.com", "slidesgo.com",
                                    "slidescarnival.com", "create.microsoft.com", "officeplus.cn", "ypppt.com"]),
    ("ppt", "technical_docs", ["officeplus.cn"]),
    ("设计", "visual_inspiration", ["pitch.com", "canva.com", "envato.com", "behance.net", "dribbble.com"]),
    ("react", "technical_docs", ["react.dev", "github.com"]),
    ("esbuild", "technical_docs", ["esbuild.github.io", "github.com"]),
    ("web worker", "technical_docs", ["developer.mozilla.org", "web.dev"]),
    ("stackoverflow", None, ["stackoverflow.com"]),
    ("报错", "technical_docs", ["stackoverflow.com"]),
    ("怎么", "technical_docs", ["stackoverflow.com", "zhihu.com"]),
    ("哪里", "user_experience", ["dianping.com", "xiaohongshu.com"]),
    ("值得", "user_experience", ["dianping.com", "xiaohongshu.com"]),
]


def preferred_domains_for(intent: str, query: str) -> list[str]:
    """返回意图 + 关键词微调后的优先域名列表（保持顺序、去重）。"""
    q = query.lower()
    domains = list(_BASE_DOMAINS.get(intent, []))
    for kw, intent_limit, extra in _QUERY_HINTS:
        if kw in q and (intent_limit is None or intent == intent_limit):
            for d in extra:
                if d not in domains:
                    domains.append(d)
    return domains


# ---------------------------------------------------------------------------
# Provider 计划（per intent）
# ---------------------------------------------------------------------------
_PROVIDER_PLAN: dict[str, list[str]] = {
    # Specialist first in final ranking; every configured provider in the
    # selected plan is queried concurrently rather than stopping at first hit.
    "code_example": ["github", "tavily", "brave", "serper", "doubao"],
    "technical_docs": ["tavily", "brave", "serper", "doubao"],
    "official_fact": ["tavily", "brave", "serper", "doubao"],
    "user_experience": ["tavily", "brave", "serper", "doubao"],
    "news": ["tavily", "brave", "serper", "doubao"],
    "deep_research": ["exa", "tavily", "brave", "serper", "doubao"],
    "visual_inspiration": ["tavily", "brave", "serper", "doubao"],
}


def _provider_configured(name: str) -> bool:
    from config import config
    return {
        "doubao": bool(config.Search.DOUBAO_SEARCH_API_KEY),
        "tavily": bool(config.Search.TAVILY_API_KEY),
        "serper": bool(config.Search.SERPER_API_KEY),
        "brave": bool(config.Search.BRAVE_API_KEY),
        "exa": bool(config.Search.EXA_API_KEY),
        "github": bool(config.Search.GITHUB_TOKEN),
    }.get(name, False)


# ---------------------------------------------------------------------------
# Provider 调用封装（异常 → 返回 (空列表, 错误信息)，由上层继续 fallback）
# ---------------------------------------------------------------------------
def _call_provider(name: str, query: str, max_results: int, sites: list[str] | None = None) -> tuple[list[dict], str | None]:
    """统一 Provider 调用：任何异常都转成 (空列表, error)，由上层继续 fallback。

    Returns:
        (items, error) —— items 为搜索结果列表；error 为异常信息（无异常为 None）。
        注意 items 为空不代表异常（可能正常返回但无结果），status 由调用方区分。
    """
    try:
        if name == "doubao":
            return _search_doubao(query, max_results=max_results, sites=sites), None
        if name == "tavily":
            return _search_tavily(query, max_results=max_results, include_domains=sites), None
        if name == "serper":
            return _search_serper(query, max_results=max_results, sites=sites), None
        if name == "brave":
            return _search_brave(query, max_results=max_results, sites=sites), None
        if name == "exa":
            return _search_exa(query, max_results=max_results, sites=sites), None
        if name == "github":
            return _search_github_code(query, max_results=max_results), None
    except Exception as exc:  # noqa: BLE001 - 任何异常都降级
        print(f"[SearchOrchestrator] provider={name} 异常，继续 fallback: {type(exc).__name__}: {exc}")
        return [], f"{type(exc).__name__}: {exc}"
    return [], f"unknown provider: {name}"


# ---------------------------------------------------------------------------
# 统一结果结构
# ---------------------------------------------------------------------------
def _to_unified(
    items: list[dict],
    provider: str,
    query: str,
    source_type: str,
) -> list[dict]:
    out = []
    for index, it in enumerate(items, 1):
        url = (it.get("url") or "").strip()
        domain = urlparse(url).netloc if url else ""
        out.append({
            "title": it.get("title", ""),
            "url": url,
            "snippet": it.get("content", "")[:300],
            "source": it.get("source", provider),
            "domain": domain,
            "sourceType": source_type,   # preferred | general
            "provider": provider,
            "query": query,
            "providerRank": index,
            "providers": [provider],
        })
    return out


_TRACKING_PARAMS = {"fbclid", "gclid", "ref", "source"}


def _canonical_url(value: str) -> str:
    if not value:
        return ""
    parsed = urlparse(value.strip())
    if not parsed.scheme or not parsed.netloc:
        return value.strip().rstrip("/").casefold()
    query = [(key, val) for key, val in parse_qsl(parsed.query, keep_blank_values=True)
             if not key.casefold().startswith("utm_") and key.casefold() not in _TRACKING_PARAMS]
    path = re.sub(r"/{2,}", "/", parsed.path).rstrip("/")
    return urlunparse((parsed.scheme.casefold(), parsed.netloc.casefold().removeprefix("www."),
                       path, "", urlencode(sorted(query)), ""))


def _dedupe(results: list[dict]) -> list[dict]:
    by_url: dict[str, dict] = {}
    order: list[str] = []
    for result in results:
        key = _canonical_url(result.get("url", "")) or (result.get("title", "").strip().casefold())
        if not key:
            continue
        current = by_url.get(key)
        if current is None:
            current = dict(result)
            current["providers"] = list(dict.fromkeys(result.get("providers", [result.get("provider", "")])) )
            current["providerRanks"] = {result.get("provider", ""): result.get("providerRank", 99)}
            order.append(key)
            by_url[key] = current
            continue
        current["providers"] = list(dict.fromkeys([*current.get("providers", []), *result.get("providers", [result.get("provider", "")])]))
        current.setdefault("providerRanks", {})[result.get("provider", "")] = result.get("providerRank", 99)
        if len(result.get("snippet", "")) > len(current.get("snippet", "")):
            current["snippet"] = result["snippet"]
        if not current.get("title") and result.get("title"):
            current["title"] = result["title"]
    return [by_url[key] for key in order]


def _site_matches(host: str, sites: list[str]) -> bool:
    hostname = host.casefold().split(":", 1)[0].removeprefix("www.")
    return any(hostname == site.casefold().removeprefix("www.") or hostname.endswith("." + site.casefold().removeprefix("www.")) for site in sites)


def _filter_sites(items: list[dict], sites: list[str] | None) -> list[dict]:
    if not sites:
        return items
    return [item for item in items if _site_matches(urlparse(item.get("url", "")).netloc, sites)]


def _explicit_sites(query: str) -> list[str]:
    return list(dict.fromkeys(match.casefold() for match in re.findall(r"(?:^|\s)site:([a-z0-9.-]+)", query, re.I)))


def _run_provider_batch(plan: list[str], query: str, sites: list[str] | None,
                        max_per_provider: int) -> tuple[dict[str, list[dict]], list[dict]]:
    configured = [provider for provider in plan if _provider_configured(provider)]
    futures = {
        _PROVIDER_POOL.submit(_call_provider, provider, query,
                              min(max_per_provider, 5 if provider != "github" else 6), sites): provider
        for provider in configured
    }
    done, pending = wait(futures, timeout=PROVIDER_TIMEOUT_SECONDS)
    for future in pending:
        future.cancel()
    results: dict[str, list[dict]] = {}
    trace: list[dict] = []
    # Keep source plan order for deterministic fusion, regardless of response timing.
    for future, provider in futures.items():
        if future not in done:
            items, error = [], "timeout"
        else:
            try:
                items, error = future.result()
            except Exception as exc:  # defensive against executor-level failures
                items, error = [], f"{type(exc).__name__}: {exc}"
        items = _filter_sites(items, sites)
        results[provider] = items
        trace.append({"provider": provider,
                      "status": "error" if error else "success" if items else "empty",
                      "error": error, "result_count": len(items),
                      "domains": _searched_domains([{"domain": urlparse((item.get("url") or "")).netloc} for item in items])})
    for provider in plan:
        if provider not in results:
            trace.append({"provider": provider, "status": "not_configured", "result_count": 0, "domains": []})
    return results, trace


def _fuse_order(results: list[dict], intent: str, preferred_domains: list[str]) -> list[dict]:
    """Reciprocal-rank fusion with small specialist and preferred-domain boosts."""
    domains = [d.casefold().removeprefix("www.") for d in preferred_domains]
    def score(item: dict) -> float:
        score_value = sum(1 / (60 + int(rank)) for rank in item.get("providerRanks", {}).values())
        host = urlparse(item.get("url", "")).netloc
        if domains and _site_matches(host, domains):
            score_value += .006
        if intent == "code_example" and "github" in item.get("providers", []):
            score_value += .01
        return score_value
    return sorted(results, key=score, reverse=True)


def _assign_source_ids(results: list[dict]) -> list[dict]:
    """按顺序为去重后的结果赋 sourceId: S1, S2, ...（Agent 用 [S1] 引用）"""
    for i, r in enumerate(results, 1):
        r["sourceId"] = f"S{i}"
    return results


def _searched_domains(results: list[dict]) -> list[str]:
    """实际返回结果的域名（去重、保持出现顺序）"""
    seen: list[str] = []
    for r in results:
        d = r.get("domain", "")
        if d and d not in seen:
            seen.append(d)
    return seen


# ---------------------------------------------------------------------------
# 编排主流程
# ---------------------------------------------------------------------------
class SearchOrchestrator:
    """User Query → Intent → Preferred Domains → Provider → Unified Results"""

    def __init__(self) -> None:
        self.last_intent: str = ""
        self.last_domains: list[str] = []
        self.last_providers: list[tuple[str, str]] = []   # (provider, preferred|general)
        self.last_fallback_used: bool = False
        self.last_trace: list[dict] = []                  # [{provider,status,error?,result_count,domains}]

    def run(self, query: str, min_preferred: int = MIN_PREFERRED,
            min_total: int = MIN_TOTAL, max_results: int = MAX_RESULTS,
            *, intent_override: str | None = None,
            domains_override: list[str] | None = None,
            strict_domains: bool = False) -> dict:
        intent = intent_override or classify_intent(query)
        explicit_sites = _explicit_sites(query)
        provider_query = re.sub(r"(?:^|\s)site:[a-z0-9.-]+", " ", query, flags=re.I).strip()
        domains = explicit_sites or (list(domains_override) if domains_override is not None else preferred_domains_for(intent, query))
        hard_domain_filter = bool(explicit_sites) or strict_domains
        plan = _PROVIDER_PLAN.get(intent, _PROVIDER_PLAN["user_experience"])
        providers_used: list[tuple[str, str]] = []
        trace: list[dict] = []
        fallback_used = False
        results: list[dict] = []
        selected_providers = [name for name in plan if _provider_configured(name)]

        # User-provided site: filters are hard constraints and must never
        # broaden. Intent preferences are a first-pass lane, then the query is
        # widened only when that lane returns too few distinct pages.
        first_pass_sites = domains if domains else None
        preferred_map, preferred_trace = _run_provider_batch(
            plan, provider_query, first_pass_sites, max(5, min_preferred)
        )
        trace.extend(preferred_trace)
        providers_used.extend((name, "explicit-domain" if explicit_sites else "preferred-domain")
                              for name in selected_providers)
        for name in plan:
            for item in preferred_map.get(name, []):
                results.extend(_to_unified([item], name, query, "explicit" if explicit_sites else "preferred"))
        results = _dedupe(results)

        if not hard_domain_filter and len(results) < min_total:
            # Widen only providers that returned no/very few targeted hits;
            # this preserves source diversity without needlessly charging all
            # providers twice for every query.
            sparse = [name for name in selected_providers
                      if len(preferred_map.get(name, [])) < 2 and name != "github"]
            if not sparse:
                sparse = [name for name in selected_providers if name != "github"][:2]
            if sparse:
                broad_map, broad_trace = _run_provider_batch(sparse, provider_query, None, max(4, min_total))
                trace.extend(broad_trace)
                providers_used.extend((name, "general") for name in sparse)
                fallback_used = True
                for name in sparse:
                    results.extend(_to_unified(broad_map.get(name, []), name, query, "general"))
                results = _dedupe(results)

        results = _fuse_order(results, intent, [] if explicit_sites else domains)[:max_results]
        results = _assign_source_ids(results)

        return {
            "query": query,
            "intent": intent,
            "preferred_domains": domains,
            "explicit_domains": explicit_sites,
            "searched_domains": _searched_domains(results),
            "providers_used": providers_used,
            "attempted_providers": [t["provider"] for t in trace if t.get("status") != "not_configured"],
            "successful_provider": [t["provider"] for t in trace if t.get("status") == "success"],
            "trace": trace,
            "fallback_used": fallback_used,
            "results": results,
        }

    def _record_trace(self, provider: str, items: list[dict], error: str | None) -> None:
        """记录一次 Provider 尝试：status = success(有结果) / empty(正常无结果) / error(异常)。"""
        entry: dict = {"provider": provider, "result_count": len(items)}
        if error:
            entry["status"] = "error"
            entry["error"] = error
        elif items:
            entry["status"] = "success"
        else:
            entry["status"] = "empty"
        # 从原始结果 url 解析实际域名（原始 items 无 domain 字段）
        entry["domains"] = _searched_domains(
            [{"domain": urlparse((it.get("url") or "")).netloc} for it in items]
        )
        self.last_trace.append(entry)


orchestrator = SearchOrchestrator()


# ---------------------------------------------------------------------------
# 可读文本格式化（给 LLM 的结果，带 [S1] 来源标记供回答引用）
# ---------------------------------------------------------------------------
def format_results(payload: dict) -> str:
    lines = []
    lines.append(f"【搜索意图】{payload['intent']}")
    lines.append(f"【优先来源】{', '.join(payload['preferred_domains']) if payload['preferred_domains'] else '无'}")
    provider_flow = " → ".join(
        f"{p}{'(域限定)' if st == 'preferred' else '(全网)'}" for p, st in payload["providers_used"]
    )
    lines.append(f"【搜索源】{provider_flow}")
    lines.append(f"【结果 {len(payload['results'])} 条】")
    for i, r in enumerate(payload["results"], 1):
        sid = r.get("sourceId", f"S{i}")
        head = f"[{sid}] {r['title']}"
        if r["source"]:
            head += f"  [{r['source']}]"
        lines.append(head)
        if r["snippet"]:
            lines.append(f"   {r['snippet']}")
        if r["url"]:
            lines.append(f"   来源：{r['url']}")
    if not payload["results"]:
        lines.append("未找到相关公开资料，请尝试换一种问法。")
    return "\n".join(lines)
