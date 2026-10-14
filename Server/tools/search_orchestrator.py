"""
SearchOrchestrator —— 统一搜索编排层
=====================================
User Query
  → Search Intent           （意图识别：official_fact / user_experience /
                              technical_docs / code_example / news /
                              deep_research / visual_inspiration）
  → Source Type             （preferred domain / general web / github）
  → Preferred Domains       （意图 + 关键词驱动的优先来源域名）
  → Provider                （豆包 / Tavily / 博查 / Serper / Brave / Exa / GitHub）
  → Unified Results         （统一结果结构）

设计原则：
1. web_search 编排候选网页来源；新闻/最新版本优先查询话题权威域名。
2. 当前版本/新闻先查话题权威来源，并并行补充相关媒体、行业/技术来源；
   新鲜度只参与排序，搜索候选随后交给 web_reader 读取正文。GitHub 使用独立 search_github_code。
3. "优先网站"不是只搜这些网站：先查 preferred domains，结果不足自动扩大到
   普通 Web Search（sourceType 区分 preferred / general）。
4. Provider 抛异常时继续 fallback（不是只有空结果才降级）。
5. 不为小红书等平台新增专用 Skill / 爬虫；没有官方 API 时仅通过现有
   Web Search 搜索公开可索引页面，搜不到就正常回退 Web，绝不伪造结果。
"""
from __future__ import annotations

import re
import json
from datetime import date, datetime, timedelta, timezone
from concurrent.futures import ThreadPoolExecutor, wait
from urllib.parse import parse_qsl, urlencode, urlparse, urlunparse

from tools.web_search import (
    _search_doubao,
    _search_github_repositories,
    _search_tavily,
    _search_bocha,
    _search_serper,
    _search_brave,
    _search_exa,
    _search_github_code,
)

# ---------------------------------------------------------------------------
# 常量
# ---------------------------------------------------------------------------
MIN_PREFERRED = 3      # 命中优先来源的最少条数，不足则扩大搜索
MIN_TOTAL = 1          # 仅无结果时扩大检索；不为数量补齐资讯
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

_CN_NEWS_DOMAINS = [
    "xinhuanet.com", "news.cn", "people.com.cn", "cctv.com", "cctv.cn",
    "caixin.com", "thepaper.cn", "yicai.com", "36kr.com", "ithome.com",
]
_INTERNATIONAL_NEWS_DOMAINS = [
    "reuters.com", "apnews.com", "bbc.com", "bloomberg.com", "ft.com",
    "cnbc.com", "nytimes.com", "theguardian.com", "asia.nikkei.com",
    "channelnewsasia.com", "nhk.or.jp",
]
_TECH_NEWS_DOMAINS = [
    "36kr.com", "ithome.com", "techcrunch.com", "theverge.com", "arstechnica.com", "technologyreview.com",
    "wired.com", "techradar.com", "venturebeat.com", "theinformation.com",
    "qbitai.com", "jiqizhixin.com", "geekpark.net",
]
_CN_OFFICIAL_DOMAINS = ["gov.cn", "cac.gov.cn", "pbc.gov.cn", "csrc.gov.cn"]
_INTERNATIONAL_OFFICIAL_DOMAINS = [
    "un.org", "who.int", "imf.org", "worldbank.org", "europa.eu",
    "gov.uk", "sec.gov", "federalreserve.gov", "ecb.europa.eu",
]
_SPECIFIED_REGION_DOMAINS: dict[str, list[str]] = {
    "US": ["apnews.com", "nytimes.com", "cnbc.com", "bloomberg.com", "sec.gov", "federalreserve.gov"],
    "UK": ["bbc.com", "theguardian.com", "ft.com", "gov.uk"],
    "Japan": ["nhk.or.jp", "asia.nikkei.com", "japantimes.co.jp", "japan.go.jp"],
    "India": ["thehindu.com", "indianexpress.com", "pib.gov.in"],
    "Singapore": ["channelnewsasia.com", "gov.sg"],
    "EU": ["europa.eu", "ec.europa.eu", "euronews.com"],
    "Korea": ["koreaherald.com", "yonhapnews.co.kr", "korea.kr"],
    "Taiwan": ["focustaiwan.tw", "taiwannews.com.tw", "gov.tw"],
    "Germany": ["dw.com", "tagesschau.de", "bund.de"],
    "France": ["france24.com", "lemonde.fr", "gouvernement.fr"],
    "Canada": ["cbc.ca", "canada.ca"],
    "Australia": ["abc.net.au", "sbs.com.au", "australia.gov.au"],
}

_NEWS_INTENT_PATTERN = re.compile(
    r"新闻|时事|热点|突发|资讯|新闻稿|媒体报道|重要消息|报道|\bnews\b|\bbreaking\b|"
    r"(?:最新|目前|当前|现行|现在|最新版).{0,18}(?:版本|型号|release|version|model)|"
    r"(?:版本|型号|release|version|model).{0,18}(?:最新|目前|当前|现行|现在|最新版)|"
    r"(?:(?:最近|近期|最新|今年|今天|现在|目前).{0,16}(?:发布|推出|上线|更新|模型|产品|政策|动态|消息|新闻|进展)|"
    r"(?:发布|推出|上线|更新).{0,12}(?:什么新|哪些新|新模型|新版本|模型|产品|政策)|"
    r"新模型|新版本|有什么新|有啥新|"
    r"(?:latest|recent|new|current).{0,20}(?:news|model|release|version|launch|announcement|policy|update))", re.I,
)
_GITHUB_EXPLICIT_PATTERN = re.compile(
    r"github|gitlab|开源|open[- ]source|仓库|\brepo(?:sitory)?\b|repository|"
    r"issue|\bPR\b|参考项目|示例源码|真实实现", re.I,
)
_GITHUB_RESEARCH_ACTION = re.compile(
    r"搜索|搜一下|找几个|找一些|找下|查找|参考|看看|有哪些|分析|研究|对比|"
    r"find|search|look\s+up|show\s+me|compare|analy[sz]e|research", re.I,
)
_GITHUB_CODE_TOPIC = re.compile(
    r"代码|\bcode\b|实现|implementation|示例|example|项目|仓库|repository|"
    r"开源|open[- ]source|issue|\bPR\b|源码|源代码|source\s+code", re.I,
)
_GITHUB_CODE_SEARCH_INTENT = re.compile(
    r"代码|源码|源代码|实现|implementation|source\s*code|\bcode\b|示例|example|用法|how\s+to|"
    r"组件|component|issue|pull\s*request|\bPR\b|\brepo\s*:", re.I,
)
_GITHUB_REPOSITORY_LOOKUP_INTENT = re.compile(
    r"repo(?:sitory)?|仓库|开源项目|组件库|ui\s*库|package", re.I,
)


def _github_search_intent(query: str) -> bool:
    return bool(_GITHUB_EXPLICIT_PATTERN.search(query) or (
        _GITHUB_RESEARCH_ACTION.search(query) and _GITHUB_CODE_TOPIC.search(query)
    ))


def infer_search_language(query: str) -> str:
    """Return the dominant language of the supplied search wording."""
    value = query or ""
    if re.search(r"[\u3040-\u30ff]", value):
        return "ja"
    if re.search(r"[\uac00-\ud7af]", value):
        return "ko"
    cjk = len(re.findall(r"[\u3400-\u9fff]", value))
    latin = len(re.findall(r"[A-Za-z]", value))
    if cjk and cjk >= latin * .35:
        return "zh"
    return "en" if latin else "unknown"


def news_search_regions(query: str) -> list[str]:
    """Classify news scope independently of the query's language."""
    explicit_sites = _explicit_sites(query)
    if explicit_sites:
        return [f"specified:{site}" for site in explicit_sites]
    q = query.casefold()
    if re.search(r"全球|全世界|世界各地|全球视角|世界范围|global|worldwide|around the world", q):
        return ["domestic", "international"]
    country_patterns = {
        "US": r"美国|美國|美方|华盛顿|華盛頓|united states|\bu\.s\.?\b|\busa\b|\bus\b",
        "UK": r"英国|英國|伦敦|倫敦|united kingdom|\buk\b|britain|british",
        "Japan": r"日本|东京|東京|japan|tokyo|japanese",
        "India": r"印度|india|indian",
        "Singapore": r"新加坡|singapore",
        "EU": r"欧盟|歐盟|欧洲|歐洲|欧洲央行|歐洲央行|european union|\beu\b|europe",
        "Korea": r"韩国|韓國|南韩|南韓|korea|seoul",
        "Taiwan": r"台湾|臺灣|taiwan",
        "Germany": r"德国|德國|柏林|germany|berlin|german",
        "France": r"法国|法國|巴黎|france|paris|french",
        "Canada": r"加拿大|渥太华|渥太華|canada|ottawa|canadian",
        "Australia": r"澳大利亚|澳洲|堪培拉|australia|canberra|australian",
    }
    specified = [region for region, pattern in country_patterns.items() if re.search(pattern, q, re.I)]
    domestic = bool(re.search(
        r"(?:中国|中國|china|chinese|国内|國內|本土|大陆|大陸).{0,24}(?:新闻|消息|热点|动态|发布|资讯|进展|情况|news|update)|"
        r"(?:新闻|消息|热点|动态|发布|资讯|进展|情况|news|update).{0,24}(?:中国|中國|china|chinese|国内|國內|本土|大陆|大陸)|"
        r"(?:北京|上海|天津|重庆|重慶|深圳|广州|廣州|杭州|成都|武汉|武漢|南京|苏州|蘇州|西安|长沙|長沙|青岛|青島|大连|大連|郑州|鄭州|合肥|福州|厦门|廈門|昆明|哈尔滨|哈爾濱|沈阳|瀋陽|济南|濟南|宁波|寧波|无锡|無錫|佛山|东莞|珠海|南宁|南寧|贵阳|貴陽|乌鲁木齐|烏魯木齊|拉萨|拉薩|兰州|蘭州|银川|銀川|石家庄|石家莊|南昌|长春|長春|海口|香港|澳门|澳門).{0,16}(?:新闻|消息|热点|动态|资讯|报道|进展)|"
        r"[\u3400-\u9fff]{2,10}(?:市|省|自治区|自治州|县|區|区).{0,16}(?:新闻|消息|热点|动态|资讯|报道|进展)",
        q,
    ))
    broad_international = bool(re.search(r"国际|海外|国外|國外|international|overseas|foreign", q))
    domestic_and_international = bool(re.search(r"国内外|國內外|中外|domestic\s*(?:and|&)\s*international", q))
    if domestic_and_international or (domestic and broad_international):
        if specified:
            return ["domestic", *(f"specified:{region}" for region in specified)]
        return ["domestic", "international"]
    if domestic and specified:
        return ["domestic", *(f"specified:{region}" for region in specified)]
    if domestic:
        return ["domestic"]
    if len(specified) == 1:
        return [f"specified:{specified[0]}"]
    if len(specified) > 1:
        # A comparison or multi-country request must not silently pick the
        # first country mentioned. Search an international source mix.
        return [*(f"specified:{region}" for region in specified)]
    if broad_international:
        return ["international"]
    # Broad industry, science, politics, and unspecified news get a global
    # source mix by default, regardless of whether the query is Chinese.
    return ["domestic", "international"]


def news_preferred_domains(query: str, regions: list[str] | None = None) -> list[str]:
    regions = news_search_regions(query) if regions is None else regions
    domains: list[str] = []
    for region in regions:
        if region == "domestic":
            candidates = [*_CN_OFFICIAL_DOMAINS, *_CN_NEWS_DOMAINS]
        elif region == "international":
            candidates = [*_INTERNATIONAL_OFFICIAL_DOMAINS, *_INTERNATIONAL_NEWS_DOMAINS]
        elif region.startswith("specified:"):
            label = region.split(":", 1)[1]
            candidates = [*_SPECIFIED_REGION_DOMAINS.get(label, []), *_INTERNATIONAL_NEWS_DOMAINS]
        else:
            candidates = []
        domains.extend(domain for domain in candidates if domain not in domains)

    q = query.casefold()
    if re.search(
        r"(?<![a-z0-9])(?:ai|artificial intelligence|mcp|llm|grok|xai|gpt|claude|gemini|copilot|model|models)(?![a-z0-9])|"
        r"人工智能|大模型|模型|芯片|科技|机器人|深度学习",
        q, re.I,
    ):
        official = ["openai.com", "x.ai", "anthropic.com", "deepmind.google", "nvidia.com"]
        domains.extend(domain for domain in official if domain not in domains)
        domains.extend(domain for domain in _TECH_NEWS_DOMAINS if domain not in domains)
    if re.search(r"央行|利率|通胀|监管|政策|金融|bank|inflation|regulat|policy", q):
        official = ["pbc.gov.cn", "federalreserve.gov", "ecb.europa.eu", "bankofengland.co.uk", "imf.org"]
        domains.extend(domain for domain in official if domain not in domains)
    return domains


def routing_search_metadata(query: str) -> dict:
    has_news = bool(_NEWS_INTENT_PATTERN.search(query))
    has_github = _github_search_intent(query)
    regions = news_search_regions(query) if has_news else []
    domains = news_preferred_domains(query, regions) if regions else []
    if has_github:
        for domain in _BASE_DOMAINS["code_example"]:
            if domain not in domains:
                domains.append(domain)
    skills = [name for name, enabled in (
        ("news_research", has_news), ("github_code", has_github),
        ("web_search", not has_news and not has_github),
    ) if enabled]
    return {"selected_skills": skills, "search_regions": regions,
            "source_domains": domains, "github_skill_used": False,
            "github_skill_status": "pending" if has_github else "not_requested"}


def _compound_search_lanes(query: str) -> list[tuple[str, str]]:
    """Split a combined news/code request when the user's wording has clauses."""
    news_pattern = _NEWS_INTENT_PATTERN
    code_pattern = r"github|开源|open[- ]source|源码|源代码|source\s+code|代码|\bcode\b|实现|implementation|仓库|\brepo(?:sitory)?\b|repository|issue|\bPR\b|示例源码|参考项目"
    if not news_pattern.search(query) or not _github_search_intent(query):
        return []

    clauses = [part.strip() for part in re.split(
        r"[,，;；。]+|(?:然后|接着|同时|并且|另外|再|以及|及|并)(?=.{0,18}(?:找|搜|查|搜索|查看|看看|GitHub|code|repository))|"
        r"(?:并|和)(?=.{0,18}(?:找|搜|查|搜索|查看|看看|GitHub|code|repository))|"
        r"\s+(?:and|plus|also)\s+(?=.{0,18}(?:find|search|look|GitHub|code|repository))",
        query,
        flags=re.I,
    ) if part.strip()]
    news_clause = next((part for part in clauses if news_pattern.search(part)), "")
    code_clause = next((part for part in clauses if re.search(code_pattern, part, re.I)), "")
    if not news_clause or not code_clause:
        # Keep both tasks alive even when a compact or mixed-language request
        # has no reliable clause boundary. Each specialist still gets a lane.
        return [("news", query), ("code_example", query)]

    # Carry shared product/acronym names into the second search without
    # translating the user's query into another language.
    subjects = [token for token in re.findall(r"\b[A-Z][A-Za-z0-9.+#-]{1,}\b", query)
                if token.casefold() not in {"github", "issue", "news", "code", "pr"}]
    missing = [token for token in subjects if token.casefold() not in code_clause.casefold()]
    if missing:
        code_clause = " ".join([*missing, code_clause])
    return [("news", news_clause), ("code_example", code_clause)]


def _domain_news_region(domain: str) -> str:
    host = (domain or "").casefold().removeprefix("www.")
    if any(_site_matches(host, [item]) for item in [*_CN_NEWS_DOMAINS, *_CN_OFFICIAL_DOMAINS]):
        return "domestic"
    if host.endswith(".cn") or host == "cn":
        return "domestic"
    return "international"


def _domain_news_country(domain: str) -> str:
    host = (domain or "").casefold().removeprefix("www.")
    if host.endswith(".cn") or any(_site_matches(host, [item]) for item in [*_CN_NEWS_DOMAINS, *_CN_OFFICIAL_DOMAINS]):
        return "China"
    country_domains = {
        "US": ["apnews.com", "bloomberg.com", "cnbc.com", "nytimes.com", "sec.gov", "federalreserve.gov"],
        "UK": ["bbc.com", "ft.com", "theguardian.com", "gov.uk"],
        "Japan": ["asia.nikkei.com", "nhk.or.jp", "japantimes.co.jp", "japan.go.jp"],
        "Singapore": ["channelnewsasia.com", "gov.sg"],
        "EU": ["europa.eu", "ec.europa.eu", "ecb.europa.eu"],
        "India": ["thehindu.com", "indianexpress.com", "pib.gov.in"],
        "Korea": ["koreaherald.com", "yonhapnews.co.kr", "korea.kr"],
        "Taiwan": ["focustaiwan.tw", "taiwannews.com.tw", "gov.tw"],
        "Canada": ["cbc.ca", "canada.ca"],
        "Germany": ["dw.com", "tagesschau.de", "bund.de"],
        "France": ["france24.com", "lemonde.fr", "gouvernement.fr"],
        "Australia": ["abc.net.au", "sbs.com.au", "australia.gov.au"],
    }
    for country, domains in country_domains.items():
        if any(_site_matches(host, [item]) for item in domains):
            return country
    if _site_matches(host, ["reuters.com", "un.org", "who.int", "imf.org", "worldbank.org"]):
        return "International"
    if _site_matches(host, ["cbc.ca", "canada.ca"]):
        return "Canada"
    if _site_matches(host, ["dw.com", "tagesschau.de", "bund.de"]):
        return "Germany"
    if _site_matches(host, ["france24.com", "lemonde.fr", "gouvernement.fr"]):
        return "France"
    if _site_matches(host, ["abc.net.au", "sbs.com.au", "australia.gov.au"]):
        return "Australia"
    return "Other"


def _domain_news_type(domain: str) -> str:
    host = (domain or "").casefold().removeprefix("www.")
    groups = {
        "official": [*_CN_OFFICIAL_DOMAINS, *_INTERNATIONAL_OFFICIAL_DOMAINS, "x.ai", "openai.com", "anthropic.com", "nvidia.com", "deepmind.google"],
        "wire": ["reuters.com", "apnews.com", "xinhuanet.com", "news.cn", "people.com.cn"],
        "broadcast": ["bbc.com", "cctv.com", "cctv.cn", "nhk.or.jp", "channelnewsasia.com"],
        "financial": ["bloomberg.com", "ft.com", "cnbc.com", "caixin.com", "yicai.com"],
        "technology": ["36kr.com", "ithome.com", *_TECH_NEWS_DOMAINS],
        "newspaper": ["nytimes.com", "theguardian.com", "asia.nikkei.com", "thepaper.cn"],
    }
    for source_type, domains in groups.items():
        if any(_site_matches(host, [item]) for item in domains):
            return source_type
    return "other"


_CURRENT_VERSION_QUERY_STOPWORDS = {
    "latest", "current", "new", "newest", "version", "release", "model", "edition",
    "news", "update", "updates", "what", "which", "is", "the", "of", "for", "now",
    "information", "as", "today", "status", "official", "ai", "api",
}
_CURRENT_VERSION_EVIDENCE = re.compile(
    r"\b(?:release|launch|launched|announc\w*|rollout|training)\b|"
    r"\b(?:latest|current|newest)\s+(?:[a-z0-9.+#-]+\s+)?models?\b|"
    r"\bmodels?\s+(?:launch|release|announc\w*)\b|"
    r"正式发布|发布|推出|上线|新模型|最新模型|模型.{0,8}(?:发布|推出|上线)|版本.{0,8}(?:发布|推出|上线)|训练完成",
    re.I,
)


def _current_version_subject_terms(query: str) -> list[str]:
    terms = [term.casefold() for term in re.findall(r"[A-Za-z][A-Za-z0-9.+#-]{1,}", query or "")
             if term.casefold() not in _CURRENT_VERSION_QUERY_STOPWORDS]
    aliases = {
        "grok": ["grok", "xai", "spacexai"],
        "xai": ["xai", "grok", "spacexai"],
        "chatgpt": ["chatgpt", "openai", "gpt"],
        "claude": ["claude", "anthropic"],
        "gemini": ["gemini", "deepmind"],
    }
    expanded = list(terms)
    for term in terms:
        expanded.extend(aliases.get(term, []))
    return list(dict.fromkeys(expanded))


def _current_version_result_matches_subject(query: str, item: dict) -> bool:
    """Reject unrelated search hits before they can masquerade as corroboration."""
    terms = _current_version_subject_terms(query)
    if not terms:
        return True
    searchable = " ".join((item.get("title", ""), item.get("snippet", ""), item.get("url", ""))).casefold()
    has_subject = any(term in searchable for term in terms)
    host = urlparse(item.get("url", "")).netloc.casefold().removeprefix("www.")
    is_status_page = host.startswith("status.") or bool(re.search(
        r"\b(?:outage|incident|temporarily unavailable|service status)\b|不可用|中断|故障",
        searchable, re.I,
    ))
    official_model_catalog = (
        _domain_news_type(host) == "official"
        and bool(re.search(r"\bmodels?\b|模型", searchable, re.I))
        and not is_status_page
    )
    has_version_evidence = bool(_CURRENT_VERSION_EVIDENCE.search(searchable)) or official_model_catalog or bool(
        re.search(r"\b\d+(?:\.\d+){1,2}\b", searchable)
    )
    return has_subject and has_version_evidence and not is_status_page


def _discovered_current_version(query: str, results: list[dict], official_domains: list[str]) -> tuple[str, str] | None:
    """Extract an explicitly reported product/version pair for official cross-checking."""
    subject_terms = _current_version_subject_terms(query)
    if not subject_terms:
        return None
    primary_subject = subject_terms[0]
    for item in results:
        if _site_matches(item.get("domain", ""), official_domains):
            continue
        if not _current_version_result_matches_subject(query, item):
            continue
        text = " ".join((item.get("title", ""), item.get("snippet", "")))
        match = re.search(r"(?<!\d)(\d+\.\d+(?:\.\d+)?)(?!\d)", text)
        if match:
            return primary_subject, match.group(1)
    return None


def _news_scope_matches(domain: str, region: str) -> bool:
    if region == "domestic":
        return _domain_news_region(domain) == "domestic"
    if region == "international":
        return _domain_news_region(domain) == "international"
    if region.startswith("specified:"):
        return _domain_news_country(domain) == region.split(":", 1)[1]
    return False


def _diversify_news_results(results: list[dict], regions: list[str], limit: int) -> list[dict]:
    """Cap publisher concentration and interleave domestic/global sources."""
    needs_both = len(set(regions)) > 1
    pools = {
        "domestic": [item for item in results if _domain_news_region(item.get("domain", "")) == "domestic"],
        "international": [item for item in results if _domain_news_region(item.get("domain", "")) == "international"],
    }
    chosen: list[dict] = []
    seen_urls: set[str] = set()
    domain_counts: dict[str, int] = {}
    country_counts: dict[str, int] = {}
    type_counts: dict[str, int] = {}

    def add(item: dict, balanced: bool = True) -> bool:
        url_key = _canonical_url(item.get("url", ""))
        domain = (item.get("domain", "") or "").casefold().removeprefix("www.")
        country = _domain_news_country(domain)
        source_type = _domain_news_type(domain)
        if url_key in seen_urls or domain_counts.get(domain, 0) >= 2:
            return False
        if balanced and needs_both:
            if source_type != "other" and type_counts.get(source_type, 0) >= 2:
                return False
            if _domain_news_region(domain) == "international" and country != "Other" \
                    and country_counts.get(country, 0) >= 2:
                return False
        seen_urls.add(url_key)
        domain_counts[domain] = domain_counts.get(domain, 0) + 1
        country_counts[country] = country_counts.get(country, 0) + 1
        type_counts[source_type] = type_counts.get(source_type, 0) + 1
        chosen.append(item)
        return True

    if needs_both and pools["domestic"] and pools["international"]:
        cursors = {key: 0 for key in pools}
        order = ["international", "domestic"]
        while len(chosen) < limit and any(cursors[key] < len(pools[key]) for key in order):
            for region in order:
                while cursors[region] < len(pools[region]):
                    item = pools[region][cursors[region]]
                    cursors[region] += 1
                    if add(item):
                        break
                if len(chosen) >= limit:
                    break
    for item in results:
        if len(chosen) >= limit:
            break
        add(item)
    return chosen

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
    if _NEWS_INTENT_PATTERN.search(q):
        return "news"

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
        *_CN_OFFICIAL_DOMAINS, *_CN_NEWS_DOMAINS,
        *_INTERNATIONAL_OFFICIAL_DOMAINS, *_INTERNATIONAL_NEWS_DOMAINS,
    ],
    "code_example": [
        "github.com", "developer.mozilla.org", "docs.python.org", "react.dev",
        "vuejs.org", "nodejs.org", "vitejs.dev", "esbuild.github.io",
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

# Product aliases are source preferences, never fabricated result URLs.
# More specific aliases precede broader families (Ant Design Mobile vs Ant).
_PRODUCT_OFFICIAL_SITES = [
    (r"麦当劳|麥當勞|mcdonald'?s?", ["mcdonalds.com.cn", "mcdonalds.com"]),
    (r"小红书|小紅書|xiaohongshu|rednote", ["xiaohongshu.com"]),
    (r"今日头条|今日頭條|toutiao", ["toutiao.com"]),
    (r"白宫|白宮|white\s*house", ["whitehouse.gov"]),
    (r"\b(?:antd?|ant\s*(?:design|desgin|desing))(?:\s*(?:design|desgin|desing))?\s*[- ]*mobile\b", ["mobile.ant.design"]),
    (r"新浪微博|微博|weibo", ["weibo.com"]),
    (r"\breact\b", ["react.dev"]),
    (r"\bvue(?:\.js)?\b", ["vuejs.org"]),
    (r"\bopenai\b|chatgpt", ["openai.com"]),
    (r"(?<![A-Za-z0-9])(?:grok|xai)(?![A-Za-z0-9])", ["x.ai", "docs.x.ai"]),
    (r"\bnvidia\b|英伟达", ["nvidia.com"]),
]

_CURRENT_VERSION_OFFICIAL_SITES = [
    (r"(?<![A-Za-z0-9])(?:grok|xai)(?![A-Za-z0-9])", ["x.ai", "docs.x.ai"]),
    (r"\bpython\b", ["python.org", "docs.python.org"]),
    (r"\bnode(?:\.js)?\b", ["nodejs.org"]),
    (r"\b(?:vite|vitest)\b", ["vite.dev"]),
    (r"\btypescript\b", ["typescriptlang.org"]),
    (r"\b(?:chrome|chromium)\b", ["developer.chrome.com"]),
    (r"\b(?:postgres(?:ql)?|postgresql)\b", ["postgresql.org"]),
    (r"\bredis\b", ["redis.io"]),
    (r"\bfastapi\b", ["fastapi.tiangolo.com"]),
    (r"\b(?:kubernetes|k8s)\b", ["kubernetes.io"]),
]

_CURRENT_VERSION_QUERY = re.compile(
    r"(?:最新|目前|当前|现行|现在|最新版|最新的).{0,18}(?:版本|型号|模型|大模型|release|version|edition)|"
    r"(?:版本|型号|模型|大模型|release|version|edition).{0,18}(?:最新|目前|当前|现行|现在|最新版)|"
    r"\b(?:latest|current)\s+(?:version|release|model|edition)\b|"
    r"\b(?:version|release|model)\s+(?:is\s+)?(?:latest|current)\b",
    re.I,
)
_CURRENT_TOPIC_QUERY = re.compile(
    r"(?:最新|目前|当前|现行|现在|最新版|最近|近期).{0,20}(?:新闻|资讯|发布|动态|消息|进展|版本|型号|模型|大模型|release|version|model|update|announcement)|"
    r"(?:新闻|资讯|发布|动态|消息|进展|版本|型号|模型|大模型|release|version|model|update|announcement).{0,20}(?:最新|目前|当前|现行|现在|最新版|最近|近期)|"
    r"\b(?:latest|current|recent)\s+(?:news|release|version|model|update|announcement)\b",
    re.I,
)
_EXPLICIT_TIME_SCOPE = re.compile(
    r"(?:20\d{2}[-/.年]\d{1,2}(?:[-/.月]\d{1,2}日?)?|\b20\d{2}\b|今天|今日|昨天|昨日|上周|过去\d+天|近\d+天|"
    r"\btoday\b|\byesterday\b|\blast\s+(?:week|month|\d+\s+days?)\b|\bpast\s+\d+\s+days?\b)",
    re.I,
)


def _add_current_date_hint(query: str, subject: str, language: str) -> str:
    """Anchor latest/current lookups to today without imposing a fixed age cutoff."""
    if not (_NEWS_INTENT_PATTERN.search(subject) or _CURRENT_TOPIC_QUERY.search(subject)) or _EXPLICIT_TIME_SCOPE.search(subject):
        return query
    if _CURRENT_VERSION_QUERY.search(subject) and re.search(r"\b\d+\.\d+(?:\.\d+)?\b", subject):
        # An explicitly requested semantic version is not an unspecified latest-version lookup.
        return query
    today = datetime.now(_SHANGHAI_TZ).date().isoformat()
    suffix = {
        "zh": f"最新信息 截至 {today}",
        "ja": f"最新情報 {today} 時点",
        "ko": f"최신 정보 {today} 기준",
        "en": f"latest current information as of {today}",
    }.get(language)
    return f"{query.strip()} {suffix}".strip() if suffix and today not in query else query


def current_version_domains_for(query: str) -> list[str]:
    """Known first-party release/documentation domains for current-version queries."""
    if not _CURRENT_VERSION_QUERY.search(query):
        return []
    return list(dict.fromkeys(
        domain for pattern, domains in _CURRENT_VERSION_OFFICIAL_SITES
        if re.search(pattern, query, re.I) for domain in domains
    ))


def official_domains_for(query: str) -> list[str]:
    """Resolve recognized products in user wording, retaining every subject."""
    return list(dict.fromkeys(
        domain for pattern, domains in _PRODUCT_OFFICIAL_SITES
        if re.search(pattern, query, re.I) for domain in domains
    ))


def code_topic_from_search(payload: dict) -> bool:
    """Only structured classification/URLs can expand tool availability.

    Search snippets are untrusted data and cannot prescribe calls or arguments.
    """
    if payload.get("intent") in {"code_example", "technical_docs"}:
        return True
    technical_sites = ["github.com", "gitlab.com", "mobile.ant.design", *_BASE_DOMAINS["technical_docs"]]
    return any(_site_matches(urlparse(item.get("url", "")).netloc, technical_sites)
               for item in payload.get("results", []) if isinstance(item, dict))


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
    "code_example": ["tavily", "bocha", "brave", "serper", "doubao"],
    "technical_docs": ["tavily", "bocha", "brave", "serper", "doubao"],
    "official_fact": ["tavily", "bocha", "brave", "serper", "doubao"],
    "user_experience": ["tavily", "bocha", "brave", "serper", "doubao"],
    "news": ["tavily", "bocha", "brave", "serper", "doubao"],
    "deep_research": ["exa", "tavily", "bocha", "brave", "serper", "doubao"],
    "visual_inspiration": ["tavily", "bocha", "brave", "serper", "doubao"],
}


def _provider_configured(name: str) -> bool:
    from config import config
    return {
        "doubao": bool(config.Search.DOUBAO_SEARCH_API_KEY),
        "tavily": bool(config.Search.TAVILY_API_KEY),
        "bocha": bool(config.Search.BOCHA_API_KEY),
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
        if name == "bocha":
            return _search_bocha(query, max_results=max_results, sites=sites), None
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
            "publishedDate": _clean_date_value(
                it.get("published_date") or it.get("publishedDate") or it.get("datePublished")
            ),
            "dateHint": _clean_date_value(it.get("date_hint")),
        })
    return out


def _clean_date_value(value: object) -> str:
    """Keep bounded, single-line date metadata from search providers."""
    if value is None:
        return ""
    return str(value).replace("\r", " ").replace("\n", " ").strip()[:80]


def _news_freshness_boost(item: dict) -> float:
    """Prefer newer material while keeping relevant older coverage eligible."""
    value = item.get("publishedDate", "")
    parsed_date: date | None = None
    if value:
        try:
            parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
            parsed_date = parsed.astimezone(_SHANGHAI_TZ).date() if parsed.tzinfo else parsed.date()
        except (TypeError, ValueError):
            try:
                parsed_date = date.fromisoformat(str(value)[:10])
            except (TypeError, ValueError):
                parsed_date = None
    if parsed_date is None:
        hint = str(item.get("dateHint", "")).casefold()
        if any(token in hint for token in ("today", "今天", "今日", "刚刚", "小时前", "hours ago", "minutes ago")):
            parsed_date = datetime.now(_SHANGHAI_TZ).date()
        elif any(token in hint for token in ("yesterday", "昨天", "1 day ago", "1天前")):
            parsed_date = datetime.now(_SHANGHAI_TZ).date() - timedelta(days=1)
    if parsed_date is None:
        return 0.0
    today = datetime.now(_SHANGHAI_TZ).date()
    age_days = (today - parsed_date).days
    if age_days < 0:
        return 0.0
    if age_days == 0:
        return .012
    if age_days == 1:
        return .010
    if age_days <= 3:
        return .008
    if age_days <= 7:
        return .006
    if age_days <= 14:
        return .004
    if age_days <= 30:
        return .002
    if age_days <= 90:
        return .001
    return 0.0


def _news_publication_date(item: dict) -> date:
    value = item.get("publishedDate", "")
    if not value:
        return date.min
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        return parsed.astimezone(_SHANGHAI_TZ).date() if parsed.tzinfo else parsed.date()
    except (TypeError, ValueError):
        try:
            return date.fromisoformat(str(value)[:10])
        except (TypeError, ValueError):
            return date.min


_TRACKING_PARAMS = {"fbclid", "gclid", "ref", "source"}
_SHANGHAI_TZ = timezone(timedelta(hours=8))


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
        for field in ("publishedDate", "dateHint"):
            if not current.get(field) and result.get(field):
                current[field] = result[field]
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
        if intent == "news" and _domain_news_type(host) == "official":
            score_value += .004
        if intent == "news":
            score_value += _news_freshness_boost(item)
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
            strict_domains: bool = False,
            original_query: str = "",
            user_language: str = "") -> dict:
        original = original_query.strip() or query
        language = user_language or infer_search_language(original)
        query_language = infer_search_language(query)
        effective_query = query
        if language not in {"unknown", "mixed"} and query_language not in {language, "unknown", "mixed"}:
            # Keep the user's requested language even if the model rewrote the
            # search terms in another language. Preserve an explicit site filter.
            sites = _explicit_sites(query)
            effective_query = original + (" " + " ".join(f"site:{site}" for site in sites) if sites else "")
        elif _NEWS_INTENT_PATTERN.search(original) and not _NEWS_INTENT_PATTERN.search(effective_query):
            # Do not let a shortened tool query silently discard the user's
            # freshness/version intent and return an older, generic result set.
            effective_query = original
        effective_query = _add_current_date_hint(effective_query, original, language)

        # A model may shorten/rephrase the tool query and accidentally drop
        # the words that identified the user's intent. Preserve specialist
        # routing from the original user message rather than trusting only the
        # rewritten search string.
        effective_intent = intent_override
        if effective_intent is None:
            if _NEWS_INTENT_PATTERN.search(original):
                effective_intent = "news"
            elif _github_search_intent(original) or _github_search_intent(effective_query):
                effective_intent = "code_example"
        payload = self._run_single(
            effective_query, min_preferred, min_total, max_results,
            intent_override=effective_intent, domains_override=domains_override,
            strict_domains=strict_domains, subject_query=original,
        )
        intent = payload["intent"]
        regions = payload.get("search_regions", [])
        github_attempted = any(entry.get("provider") == "github" and entry.get("status") != "not_configured"
                               for entry in payload["trace"])
        github_status = next((entry.get("status") for entry in payload["trace"] if entry.get("provider") == "github"), "not_requested")
        payload.update({
            "selected_skills": ["web_search", "news_research"] if intent == "news" else ["web_search"],
            "search_language": language,
            "source_domains": payload["searched_domains"],
            "github_skill_used": github_attempted,
            "github_skill_status": github_status,
        })
        print("[RoutingAudit] " + json.dumps({
            key: payload[key] for key in (
                "selected_skills", "search_regions", "source_domains", "github_skill_used",
                "github_skill_status",
            )
        }, ensure_ascii=False))
        return payload

    def run_github(self, query: str, *, original_query: str = "", user_language: str = "") -> dict:
        """Search GitHub repositories first, then source code when the request needs it."""
        lookup_query = original_query if re.search(r"github\.com/[^\s]+", original_query or "", re.I) else query
        repo_error = None
        try:
            repo_items = _search_github_repositories(lookup_query, max_results=8)
            repo_status = "success" if repo_items else "empty"
        except Exception as exc:  # noqa: BLE001 - repository discovery is an independent lane
            repo_items = []
            repo_status = "error"
            repo_error = f"{type(exc).__name__}: {exc}"
            print(f"[SearchOrchestrator] provider=github_repositories 异常: {repo_error}")

        search_text = f"{query or ''} {original_query or ''}"
        code_search_requested = bool(_GITHUB_CODE_SEARCH_INTENT.search(search_text))
        repository_lookup_requested = bool(_GITHUB_REPOSITORY_LOOKUP_INTENT.search(search_text)) or not code_search_requested
        exact_repo = next((item for item in repo_items if item.get("repository_match") == "exact"), None)
        scoped_repo = exact_repo or (repo_items[0] if repository_lookup_requested and repo_items else None)
        repo_name = scoped_repo.get("repository_name", "") if scoped_repo else ""
        code_query = query.strip()
        code_query = re.sub(r"https?://(?:www\.)?github\.com/[^\s]+", " ", code_query, flags=re.I)
        code_query = re.sub(r"\b[\w.-]+/[\w.-]+\b", " ", code_query)
        code_query = re.sub(
            r"github|repository|repo|仓库|项目|搜索|查找|代码|源码|源代码|实现|implementation|source\s*code|\bcode\b|"
            r"示例|example|用法|how\s+to|组件|component|issue|pull\s*request|\bPR\b",
            " ", code_query, flags=re.I,
        )
        code_query = re.sub(r"\s+", " ", code_query).strip(" .,:：，;；!?！？\"'` ")
        code_payload = None
        code_status = "not_requested"
        code_error = None
        if code_search_requested and code_query:
            if repo_name and "/" in repo_name:
                code_query = f"repo:{repo_name} {code_query}"
            code_payload = self._run_single(
                code_query, min_total=0, intent_override="code_example", domains_override=[],
                provider_plan=["github"],
            )
            code_status = next((entry["status"] for entry in code_payload["trace"]
                                if entry["provider"] == "github"), "not_configured")
            code_error = next((entry.get("error") for entry in code_payload["trace"]
                               if entry["provider"] == "github" and entry.get("error")), None)

        payload = code_payload or self._run_single(
            query, min_total=0, intent_override="code_example", domains_override=[], provider_plan=[],
        )
        visible_repo_items = repo_items if repository_lookup_requested else ([exact_repo] if exact_repo else [])
        repo_results = _to_unified(visible_repo_items, "github", query, "repository")
        for result, item in zip(repo_results, visible_repo_items):
            result["repositoryMatch"] = item.get("repository_match", "fuzzy")
        code_results = code_payload["results"] if code_payload else []
        # Reserve the first slots for the exact/popular repository candidates;
        # append implementation references only when code search was requested.
        results = [*repo_results[:3], *code_results[:max(0, 8 - min(3, len(repo_results)))]]
        payload["results"] = _assign_source_ids(_dedupe(results))
        repo_trace = {
            "provider": "github_repositories",
            "status": repo_status,
            "result_count": len(repo_items),
            "domains": ["github.com"] if repo_items else [],
        }
        if repo_error:
            repo_trace["error"] = repo_error
        payload["trace"] = [repo_trace, *(payload.get("trace") or [])]
        payload["providers_used"] = [("github_repositories", "exact-name/popular-name")] + (payload.get("providers_used") or [])
        payload["attempted_providers"] = [entry["provider"] for entry in payload["trace"]
                                          if entry.get("status") != "not_configured"]
        payload["successful_provider"] = [entry["provider"] for entry in payload["trace"]
                                           if entry.get("status") == "success"]
        payload["searched_domains"] = _searched_domains(payload["results"])
        payload["query"] = query
        payload["github_repositories_status"] = repo_status
        payload["github_repositories_found"] = len(repo_items)
        payload["github_repository_names"] = [item.get("repository_name", "") for item in visible_repo_items[:3]]
        payload["github_code_search_status"] = code_status
        payload["github_code_search_error"] = code_error
        status = ("success" if code_status == "success" or repo_status == "success"
                  else code_status if code_status not in ("empty", "not_requested") else repo_status)
        payload.update({
            "selected_skills": ["github_code"], "source_domains": payload["searched_domains"],
            "search_language": user_language or infer_search_language(original_query or query),
            "github_skill_used": repo_status in ("success", "empty", "error")
            or code_status not in ("not_configured", "not_requested"),
            "github_skill_status": status,
        })
        print("[RoutingAudit] " + json.dumps({key: payload[key] for key in (
            "selected_skills", "search_regions", "source_domains", "github_skill_used", "github_skill_status",
            "github_repositories_status", "github_repositories_found", "github_code_search_status",
        )}, ensure_ascii=False))
        return payload

    def _run_single(self, query: str, min_preferred: int = MIN_PREFERRED,
            min_total: int = MIN_TOTAL, max_results: int = MAX_RESULTS,
            *, intent_override: str | None = None,
            domains_override: list[str] | None = None,
            strict_domains: bool = False,
            subject_query: str = "", provider_plan: list[str] | None = None) -> dict:
        intent = intent_override or classify_intent(query)
        explicit_sites = list(dict.fromkeys([*_explicit_sites(subject_query), *_explicit_sites(query)]))
        provider_query = re.sub(r"(?:^|\s)site:[a-z0-9.-]+", " ", query, flags=re.I).strip()
        subject = subject_query or query
        # A news request is inherently time-sensitive, even when the user did
        # not explicitly say "latest" or "today".
        current_query = intent == "news"
        current_version_query = intent == "news" and bool(_CURRENT_VERSION_QUERY.search(subject))
        regions = news_search_regions(subject) if intent == "news" and not current_version_query else []
        official_domains = official_domains_for(subject) if provider_plan is None and domains_override is None else []
        if provider_plan is None and domains_override is None:
            official_domains = list(dict.fromkeys([
                *official_domains, *current_version_domains_for(subject),
            ]))
        if explicit_sites:
            domains = explicit_sites
        elif domains_override is not None:
            domains = list(domains_override)
        elif intent == "news":
            domains = news_preferred_domains(subject, regions)
        else:
            domains = preferred_domains_for(intent, subject)
        if official_domains and not explicit_sites:
            domains = list(dict.fromkeys([*official_domains, *domains]))
        if current_version_query and not explicit_sites:
            # Current-version questions need a dedicated technology/industry
            # lane even when the official source is recent or undated.
            fallback_news_domains = (
                [*_CN_NEWS_DOMAINS, *_INTERNATIONAL_NEWS_DOMAINS, *_TECH_NEWS_DOMAINS]
                if official_domains else news_preferred_domains(subject, ["domestic", "international"])
            )
            domains = list(dict.fromkeys([*domains, *fallback_news_domains]))
        authority_domains = list(official_domains)
        if intent == "news" and not explicit_sites and not current_version_query:
            authority_domains = list(dict.fromkeys([
                *authority_domains,
                *(domain for domain in domains if _domain_news_type(domain) == "official"),
            ]))
        hard_domain_filter = bool(explicit_sites) or strict_domains
        plan = provider_plan if provider_plan is not None else _PROVIDER_PLAN.get(intent, _PROVIDER_PLAN["user_experience"])
        providers_used: list[tuple[str, str]] = []
        trace: list[dict] = []
        fallback_used = False
        results: list[dict] = []
        selected_providers = [name for name in plan if _provider_configured(name)]

        # User-provided site: filters are hard constraints and must never
        # broaden. Intent preferences are a first-pass lane, then the query is
        # widened only when that lane returns too few distinct pages.
        first_pass_sites = explicit_sites or authority_domains or domains or None
        preferred_map, preferred_trace = _run_provider_batch(
            plan, provider_query, first_pass_sites, max(5, min_preferred)
        )
        trace.extend(preferred_trace)
        providers_used.extend((name, "explicit-domain" if explicit_sites else "preferred-domain")
                              for name in selected_providers)
        for name in plan:
            for item in preferred_map.get(name, []):
                results.extend(_to_unified([item], name, query, "explicit" if explicit_sites else "official" if authority_domains else "preferred"))
        results = _dedupe(results)

        # Product searches always visit their own indexed official pages first.
        # Other sources supplement that lane; failures never invent official hits.
        if authority_domains and not hard_domain_filter:
            supporting_domains = (
                list(_TECH_NEWS_DOMAINS)
                if current_version_query
                else [domain for domain in domains if domain not in authority_domains]
            )
            has_independent_news_results = intent == "news" and any(
                not _site_matches(item.get("domain", ""), authority_domains)
                and _domain_news_type(item.get("domain", "")) != "official"
                and (not current_version_query or _current_version_result_matches_subject(subject, item))
                for item in results
            )
            # First-party material anchors factual claims, but it must not end
            # a news/current-version lookup by itself. Always try relevant
            # independent publishers when the official pass found none.
            should_supplement = not current_query or not has_independent_news_results
            if supporting_domains and should_supplement:
                supporting, supporting_trace = _run_provider_batch(plan, provider_query, supporting_domains, 3)
                trace.extend(supporting_trace)
                providers_used.extend((name, "supporting-domain") for name in selected_providers)
                for name in plan:
                    results.extend(_to_unified(supporting.get(name, []), name, query, "supporting"))
                results = _dedupe(results)

        has_independent_news_results = intent == "news" and any(
            not _site_matches(item.get("domain", ""), authority_domains)
            and _domain_news_type(item.get("domain", "")) != "official"
            and (not current_version_query or _current_version_result_matches_subject(subject, item))
            for item in results
        )
        should_discover_unlisted_news_sources = (
            intent == "news" and not hard_domain_filter and not has_independent_news_results
        )
        if not hard_domain_filter and (len(results) < min_total or should_discover_unlisted_news_sources):
            # Widen only providers that returned no/very few targeted hits;
            # for news, also allow general discovery when curated official and
            # supporting domains failed to yield independent coverage.
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

        if current_version_query and authority_domains and not hard_domain_filter:
            discovered_version = _discovered_current_version(subject, results, authority_domains)
            if discovered_version:
                product, version = discovered_version
                release_word = {"zh": "发布", "ja": "発表", "ko": "출시", "en": "release"}.get(
                    infer_search_language(subject), "release"
                )
                exact_version_query = f"{product} {version} {release_word}"
                exact_official, exact_trace = _run_provider_batch(
                    plan, exact_version_query, authority_domains, 3
                )
                trace.extend(exact_trace)
                providers_used.extend((name, "official-version-followup") for name in plan if name in exact_official)
                for name in plan:
                    results.extend(_to_unified(
                        exact_official.get(name, []), name, query, "official-version-followup"
                    ))
                results = _dedupe(results)

        # Do not let a global/multi-region or country-specific request silently
        # collapse to whichever region a general provider happened to return.
        missing_regions: list[str] = []
        if intent == "news" and not explicit_sites and regions:
            missing_regions = [
                region for region in regions
                if not any(_news_scope_matches(item.get("domain", ""), region) for item in results)
            ]
            for missing_region in missing_regions:
                regional_domains = news_preferred_domains(query, [missing_region])
                supplemental, supplemental_trace = _run_provider_batch(
                    plan, provider_query, regional_domains, max(5, min_preferred)
                )
                trace.extend(supplemental_trace)
                providers_used.extend((name, "regional-supplement") for name in plan if name in supplemental)
                for name in plan:
                    for item in supplemental.get(name, []):
                        results.extend(_to_unified([item], name, query, "regional-supplement"))
                results = _dedupe(results)
            missing_regions = [
                region for region in regions
                if not any(_news_scope_matches(item.get("domain", ""), region) for item in results)
            ]

        if current_version_query and not explicit_sites:
            results = [item for item in results if _current_version_result_matches_subject(subject, item)]
            official_results = [
                item for item in results
                if _site_matches(item.get("domain", ""), authority_domains)
            ]
            official_results.sort(key=lambda item: item.get("sourceType") != "official-version-followup")
            independent_results = [item for item in results if item not in official_results]
            # One or two first-party references are enough to anchor the answer;
            # don't let duplicate status/docs pages crowd out independent coverage.
            results = [*official_results[:2], *independent_results]

        results = _fuse_order(results, intent, [] if explicit_sites else domains)
        if authority_domains and not explicit_sites and intent != "news":
            results.sort(key=lambda item: not _site_matches(item.get("domain", ""), authority_domains))
        if intent == "code_example":
            # Relevance fusion may score broad web pages above source files.
            # Keep concrete GitHub code hits first whenever GitHub returned any.
            github_results = [item for item in results if "github" in item.get("providers", [])]
            other_results = [item for item in results if "github" not in item.get("providers", [])]
            results = github_results + other_results
        if intent == "news" and not explicit_sites:
            results.sort(key=_news_publication_date, reverse=True)
            results = _diversify_news_results(results, regions, max_results)
        else:
            results = results[:max_results]
        if intent == "news" and not explicit_sites:
            results.sort(key=_news_publication_date, reverse=True)
        elif authority_domains and not explicit_sites:
            results.sort(key=lambda item: not _site_matches(item.get("domain", ""), authority_domains))
        results = _assign_source_ids(results)

        return {
            "query": query,
            "intent": intent,
            "search_regions": regions,
            "missing_search_regions": missing_regions if intent == "news" else [],
            "preferred_domains": domains,
            "official_domains": official_domains if not explicit_sites else [],
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
    if payload.get("github_repositories_status"):
        visible_count = len(payload.get("github_repository_names", []))
        queried_count = payload.get("github_repositories_found", 0)
        lines.append(f"【仓库发现】同名优先、模糊匹配按 Stars 热度排序；本轮展示 {visible_count} 个候选（检索命中 {queried_count} 个）。")
    lines.append(f"【结果 {len(payload['results'])} 条】")
    for i, r in enumerate(payload["results"], 1):
        sid = r.get("sourceId", f"S{i}")
        head = f"[{sid}] {r['title']}"
        if r["source"]:
            head += f"  [{r['source']}]"
        lines.append(head)
        if r.get("publishedDate"):
            lines.append(f"   发布时间：{r['publishedDate']}")
        elif r.get("dateHint"):
            lines.append(f"   时间线索（搜索引擎提供，未核验）：{r['dateHint']}")
        if r["snippet"]:
            lines.append(f"   {r['snippet']}")
        if r["url"]:
            lines.append(f"   来源：{r['url']}")
    if not payload["results"]:
        lines.append("未找到相关公开资料，请尝试换一种问法。")
    return "\n".join(lines)
