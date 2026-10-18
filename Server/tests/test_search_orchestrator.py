import unittest
from unittest.mock import patch

from tools.search_orchestrator import (
    SearchOrchestrator, _PROVIDER_PLAN, _canonical_url, _dedupe, classify_intent, official_domains_for,
)


class SearchOrchestratorTest(unittest.TestCase):
    def test_routes_each_intent_to_domain_specialists(self):
        self.assertEqual(classify_intent("React useMemo 源码实现"), "code_example")
        self.assertEqual(classify_intent("广州陈家祠开放时间"), "official_fact")
        self.assertEqual(classify_intent("广州旅游攻略推荐"), "user_experience")

    def test_web_and_independent_github_use_separate_provider_plans(self):
        def provider(name, query, max_results, sites=None, **_kwargs):
            if name == "github":
                return ([{"title": "repo:file", "url": "https://github.com/a/b/blob/main/x.ts",
                          "content": "path: x.ts", "source": "github"}], None)
            return ([{"title": name, "url": f"https://{name}.example/docs",
                      "content": f"from {name}", "source": name}], None)

        with (patch("tools.search_orchestrator._provider_configured", return_value=True),
              patch("tools.search_orchestrator._call_provider", side_effect=provider) as call):
            payload = SearchOrchestrator().run("React hook 源码实现")
            web_calls = list(call.call_args_list)
            call.reset_mock()
            code = SearchOrchestrator().run_github("useMemo repo:facebook/react")

        self.assertEqual(payload["intent"], "code_example")
        self.assertFalse(payload["github_skill_used"])
        self.assertNotIn("github", {args.args[0] for args in web_calls})
        self.assertEqual(call.call_count, 1)
        self.assertEqual(call.call_args.args[0], "github")
        self.assertEqual(code["results"][0]["providers"], ["github"])
        self.assertEqual(code["selected_skills"], ["github_code"])
        self.assertIn("sourceId", payload["results"][0])

    def test_original_github_code_intent_survives_a_shortened_search_query(self):
        def provider(name, query, max_results, sites=None, **_kwargs):
            return ([{
                "title": f"{name} result",
                "url": "https://github.com/example/hanui/blob/main/src/index.ts" if name == "github"
                    else f"https://{name}.example/hanui",
                "content": f"from {name}",
                "source": name,
            }], None)

        with (patch("tools.search_orchestrator._provider_configured", return_value=True),
              patch("tools.search_orchestrator._call_provider", side_effect=provider)):
            payload = SearchOrchestrator().run(
                "HanUI",
                original_query="GitHub代码搜索 HanUI",
                user_language="zh",
            )

        self.assertEqual(payload["intent"], "code_example")
        self.assertEqual(payload["selected_skills"], ["web_search"])
        self.assertFalse(payload["github_skill_used"])
        self.assertNotIn("github", payload["attempted_providers"])

    def test_github_results_stay_first_when_fusion_prefers_general_pages(self):
        def provider(name, query, max_results, sites=None, **_kwargs):
            return ([{
                "title": name,
                "url": "https://github.com/example/source/blob/main/index.ts" if name == "github"
                    else f"https://{name}.example/guide",
                "content": f"from {name}",
                "source": name,
            }], None)

        with (patch("tools.search_orchestrator._provider_configured", return_value=True),
              patch("tools.search_orchestrator._call_provider", side_effect=provider),
              patch("tools.search_orchestrator._fuse_order", side_effect=lambda items, *args: list(reversed(items)))):
            payload = SearchOrchestrator().run_github("useMemo repo:facebook/react")

        self.assertEqual(payload["intent"], "code_example")
        self.assertEqual(payload["results"][0]["providers"], ["github"])

    def test_explicit_site_filter_is_hard_and_result_urls_are_checked(self):
        def provider(name, query, max_results, sites=None, **_kwargs):
            return ([
                {"title": "allowed", "url": "https://docs.acme.dev/a", "content": "yes", "source": name},
                {"title": "spoof", "url": "https://notexample.com/a", "content": "no", "source": name},
            ], None)

        with (patch("tools.search_orchestrator._provider_configured", return_value=True),
              patch("tools.search_orchestrator._call_provider", side_effect=provider) as call):
            payload = SearchOrchestrator().run("API docs site:acme.dev")

        self.assertEqual(payload["explicit_domains"], ["acme.dev"])
        self.assertEqual([item["url"] for item in payload["results"]], ["https://docs.acme.dev/a"])
        self.assertEqual(call.call_count, 5)
        self.assertEqual(
            payload["attempted_providers"],
            ["tavily", "bocha", "brave", "serper", "doubao"],
        )
        self.assertFalse(payload["fallback_used"])

    def test_provider_plan_places_bocha_after_tavily(self):
        web = ["tavily", "bocha", "brave", "serper", "doubao"]
        for intent in ("user_experience", "official_fact", "technical_docs", "visual_inspiration", "code_example"):
            with self.subTest(intent=intent):
                self.assertEqual(_PROVIDER_PLAN[intent], web)
        # News also queries Exa so a free-tier key adds an overseas source.
        self.assertEqual(_PROVIDER_PLAN["news"], ["tavily", "exa", "bocha", "brave", "serper", "doubao"])
        self.assertEqual(
            _PROVIDER_PLAN["deep_research"],
            ["exa", "tavily", "bocha", "brave", "serper", "doubao"],
        )

    def test_disabled_providers_are_skipped_even_with_keys(self):
        from config import config
        from tools.search_orchestrator import _provider_configured

        def provider(name, query, max_results, sites=None, **_kwargs):
            return ([{"title": name, "url": f"https://{name}.example/news",
                      "content": f"from {name}", "source": name}], None)

        with (patch.object(config.Search, "DOUBAO_SEARCH_API_KEY", "k"),
              patch.object(config.Search, "BOCHA_API_KEY", "k"),
              patch.object(config.Search, "TAVILY_API_KEY", "k"),
              patch.object(config.Search, "EXA_API_KEY", "k"),
              patch.object(config.Search, "SERPER_API_KEY", ""),
              patch.object(config.Search, "BRAVE_API_KEY", ""),
              patch.object(config.Search, "DISABLED_PROVIDERS", frozenset({"doubao", "bocha"})),
              patch("tools.search_orchestrator._call_provider", side_effect=provider) as call):
            self.assertFalse(_provider_configured("doubao"))
            self.assertFalse(_provider_configured("bocha"))
            self.assertTrue(_provider_configured("tavily"))
            payload = SearchOrchestrator().run("美国最新新闻", original_query="美国最新新闻")

        called = {args.args[0] for args in call.call_args_list}
        self.assertEqual(called, {"tavily", "exa"})
        self.assertEqual(set(payload["attempted_providers"]), {"tavily", "exa"})

    def test_news_uses_fast_exa_and_other_intents_keep_default(self):
        def provider(name, query, max_results, sites=None, **_kwargs):
            return ([{"title": name, "url": f"https://{name}.example/page",
                      "content": f"from {name}", "source": name}], None)

        with (patch("tools.search_orchestrator._provider_configured", return_value=True),
              patch("tools.search_orchestrator._call_provider", side_effect=provider) as call):
            SearchOrchestrator().run("美国最新新闻", original_query="美国最新新闻")
            news_calls = list(call.call_args_list)
            call.reset_mock()
            SearchOrchestrator().run("Transformer 论文 深度调研", intent_override="deep_research")
            research_calls = list(call.call_args_list)

        news_exa = [c for c in news_calls if c.args[0] == "exa"]
        self.assertTrue(news_exa)
        self.assertTrue(all(c.kwargs.get("exa_type") == "fast" for c in news_exa))
        self.assertTrue(all("exa_type" not in c.kwargs for c in news_calls if c.args[0] != "exa"))
        research_exa = [c for c in research_calls if c.args[0] == "exa"]
        self.assertTrue(research_exa)
        self.assertTrue(all("exa_type" not in c.kwargs for c in research_exa))

    def test_call_provider_forwards_exa_type_with_auto_default(self):
        from tools.search_orchestrator import _call_provider

        with patch("tools.search_orchestrator._search_exa", return_value=[]) as exa:
            _call_provider("exa", "q", 5, None, exa_type="fast")
            self.assertEqual(exa.call_args.kwargs["search_type"], "fast")
            _call_provider("exa", "q", 5)
            self.assertEqual(exa.call_args.kwargs["search_type"], "auto")

    def test_duplicate_tracking_urls_merge_provider_attribution(self):
        first = {"url": "https://www.example.com/page?utm_source=one", "title": "Page",
                 "snippet": "short", "provider": "tavily", "providerRank": 2,
                 "providers": ["tavily"], "providerRanks": {"tavily": 2}}
        second = {"url": "https://example.com/page#part", "title": "Page",
                  "snippet": "longer snippet", "provider": "brave", "providerRank": 1,
                  "providers": ["brave"], "providerRanks": {"brave": 1}}
        merged = _dedupe([first, second])
        self.assertEqual(_canonical_url(first["url"]), _canonical_url(second["url"]))
        self.assertEqual(len(merged), 1)
        self.assertEqual(set(merged[0]["providers"]), {"tavily", "brave"})
        self.assertEqual(merged[0]["snippet"], "longer snippet")

    def test_user_product_aliases_choose_their_official_sites_first(self):
        for name, domain in [
            ("麦当劳", "mcdonalds.com.cn"), ("小红书", "xiaohongshu.com"),
            ("今日头条", "toutiao.com"), ("白宫", "whitehouse.gov"),
            ("Antd desgin mobile", "mobile.ant.design"), ("新浪微博", "weibo.com"),
        ]:
            with self.subTest(name=name):
                self.assertIn(domain, official_domains_for(name))
                calls = []
                def provider(provider_name, query, max_results, sites=None, **_kwargs):
                    calls.append(sites)
                    host = sites[0] if sites else "secondary.example"
                    return ([{"title": "actual page", "url": f"https://{host}/page", "content": "bounded"}], None)
                with (patch("tools.search_orchestrator._provider_configured", side_effect=lambda p: p == "tavily"),
                      patch("tools.search_orchestrator._call_provider", side_effect=provider)):
                    payload = SearchOrchestrator().run("使用方法", original_query=f"{name} 使用方法", user_language="zh")
                self.assertIn(domain, calls[0])
                self.assertEqual(payload["results"][0]["domain"], domain)
                self.assertEqual(payload["official_domains"][0], domain)

    def test_explicit_site_overrides_product_preference_even_when_query_was_shortened(self):
        def provider(name, query, max_results, sites=None, **_kwargs):
            self.assertEqual(sites, ["example.com"])
            return ([{"title": "actual", "url": "https://example.com/a", "content": "text"}], None)
        with (patch("tools.search_orchestrator._provider_configured", side_effect=lambda p: p == "tavily"),
              patch("tools.search_orchestrator._call_provider", side_effect=provider)):
            payload = SearchOrchestrator().run("Ant Design Mobile", original_query="Ant Design Mobile site:example.com")
        self.assertEqual(payload["explicit_domains"], ["example.com"])
        self.assertEqual(payload["official_domains"], [])

    def test_news_with_three_sources_is_not_padded_to_eight(self):
        items = [{"title": f"news {i}", "url": f"https://{domain}/story", "content": "actual"}
                 for i, domain in enumerate(["reuters.com", "people.com.cn", "bbc.com"])]
        with (patch("tools.search_orchestrator._provider_configured", side_effect=lambda p: p == "tavily"),
              patch("tools.search_orchestrator._call_provider", return_value=(items, None)) as call):
            payload = SearchOrchestrator().run("全球最近有什么重要新闻")
        self.assertEqual(len(payload["results"]), 3)
        # A second targeted pass may look for dated authoritative pages; it
        # must not add synthetic results merely to reach an item-count target.
        self.assertLessEqual(call.call_count, 2)
        self.assertFalse(payload["fallback_used"])

    def test_news_has_no_fixed_three_day_cutoff_and_supplements_official_results(self):
        from datetime import datetime, timedelta
        from tools.search_orchestrator import _SHANGHAI_TZ

        calls = []
        old_date = (datetime.now(_SHANGHAI_TZ).date() - timedelta(days=4)).isoformat()
        today = datetime.now(_SHANGHAI_TZ).date().isoformat()

        def provider(name, query, max_results, sites=None, **_kwargs):
            calls.append((query, sites))
            if sites and "whitehouse.gov" in sites:
                return ([{"title": "old official news", "url": "https://whitehouse.gov/news/old",
                          "content": "official context", "publishedDate": old_date, "source": name}], None)
            return ([{"title": "recent coverage", "url": "https://reuters.com/world/news",
                      "content": "recent reporting", "publishedDate": today, "source": name}], None)

        with (patch("tools.search_orchestrator._provider_configured", side_effect=lambda p: p == "tavily"),
              patch("tools.search_orchestrator._call_provider", side_effect=provider)):
            payload = SearchOrchestrator().run(
                "白宫新闻", original_query="白宫新闻", user_language="zh", min_total=1,
            )

        self.assertIn(today, calls[0][0])
        self.assertNotIn("近3天", calls[0][0])
        self.assertNotIn("过去3天", calls[0][0])
        self.assertGreaterEqual(len(calls), 2)
        self.assertTrue(any(
            sites and any("reuters.com" in domain for domain in sites)
            for _, sites in calls
        ))
        self.assertEqual(payload["intent"], "news")

    def test_latest_version_query_checks_official_then_independent_technology_sources(self):
        from datetime import datetime, timedelta
        from tools.search_orchestrator import _SHANGHAI_TZ

        calls = []
        today = datetime.now(_SHANGHAI_TZ).date().isoformat()
        recent_official_date = (datetime.now(_SHANGHAI_TZ).date() - timedelta(days=20)).isoformat()

        def provider(name, query, max_results, sites=None, **_kwargs):
            calls.append((query, sites))
            if sites and any(domain in {"python.org", "docs.python.org"} for domain in sites):
                return ([{
                    "title": "Python release",
                    "url": "https://python.org/downloads/",
                    "content": "official release",
                    "publishedDate": recent_official_date,
                    "source": name,
                }], None)
            return ([{
                "title": "Independent Python release coverage",
                "url": "https://techcrunch.com/python-release/",
                "content": "independent report",
                "publishedDate": today,
                "source": name,
            }], None)

        with (patch("tools.search_orchestrator._provider_configured", side_effect=lambda p: p == "tavily"),
              patch("tools.search_orchestrator._call_provider", side_effect=provider)):
            payload = SearchOrchestrator().run(
                "Python 最新版本", original_query="Python 最新版本", user_language="zh", min_total=1,
            )

        self.assertEqual(payload["intent"], "news")
        self.assertEqual(payload["search_regions"], [])
        self.assertEqual(len(calls), 2)
        self.assertIn(today, calls[0][0])
        self.assertIn("最新信息", calls[0][0])
        self.assertTrue(any(domain in calls[0][1] for domain in ("python.org", "docs.python.org")))
        self.assertIn("techcrunch.com", calls[1][1])
        self.assertEqual({item["domain"] for item in payload["results"]}, {"python.org", "techcrunch.com"})
        self.assertFalse(payload["fallback_used"])

    def test_grok_latest_model_cjk_word_boundary_searches_official_and_independent_sources(self):
        from datetime import datetime, timedelta
        from tools.search_orchestrator import _SHANGHAI_TZ, current_version_domains_for

        query = "Grok最新模型是什么"
        self.assertEqual(classify_intent(query), "news")
        self.assertIn("x.ai", official_domains_for(query))
        self.assertIn("docs.x.ai", current_version_domains_for(query))
        calls = []
        today = datetime.now(_SHANGHAI_TZ).date().isoformat()
        official_date = (datetime.now(_SHANGHAI_TZ).date() - timedelta(days=18)).isoformat()

        def provider(name, search_query, max_results, sites=None, **_kwargs):
            calls.append((search_query, sites))
            if sites and "x.ai" in sites:
                if "4.7" in search_query:
                    return ([{
                        "title": "Introducing Grok 4.7",
                        "url": "https://x.ai/news/grok-4-7",
                        "content": "The latest Grok model is Grok 4.7.",
                        "publishedDate": official_date,
                        "source": name,
                    }], None)
                return ([{
                    "title": "Grok Models & Pricing",
                    "url": "https://docs.x.ai/developers/models",
                    "content": "Official model catalogue.",
                    "publishedDate": official_date,
                    "source": name,
                }], None)
            return ([{
                "title": "Grok 4.7 release coverage",
                "url": "https://techcrunch.com/grok-4-7/",
                "content": "Independent coverage of Grok 4.7.",
                "publishedDate": today,
                "source": name,
            }], None)

        with (patch("tools.search_orchestrator._provider_configured", side_effect=lambda p: p == "tavily"),
              patch("tools.search_orchestrator._call_provider", side_effect=provider)):
            payload = SearchOrchestrator().run(query, original_query=query, user_language="zh")

        self.assertEqual(len(calls), 3)
        self.assertIn("x.ai", calls[0][1])
        self.assertTrue(any(domain in calls[1][1] for domain in ("techcrunch.com", "36kr.com", "theverge.com")))
        self.assertIn("grok 4.7 发布", calls[2][0].casefold())
        self.assertIn("x.ai", calls[2][1])
        self.assertEqual({item["domain"] for item in payload["results"]}, {"docs.x.ai", "x.ai", "techcrunch.com"})
        self.assertEqual(payload["results"][0]["domain"], "techcrunch.com")
        self.assertTrue(any("x.ai/news/grok-4-7" in item["url"] for item in payload["results"]))

    def test_unrelated_technical_hit_does_not_stop_grok_source_discovery(self):
        query = "Grok最新模型是什么"
        calls = []

        def provider(name, search_query, max_results, sites=None, **_kwargs):
            calls.append((search_query, sites))
            if sites and "x.ai" in sites:
                if "4.7" in search_query:
                    return ([{
                        "title": "Introducing Grok 4.7",
                        "url": "https://x.ai/news/grok-4-7",
                        "content": "Grok 4.7 release.",
                        "source": name,
                    }], None)
                return ([{
                    "title": "Grok Models & Pricing",
                    "url": "https://docs.x.ai/developers/models/grok-4.7",
                    "content": "Grok 4.7 is available.",
                    "source": name,
                }, {
                    "title": "Models outage - API temporarily unavailable",
                    "url": "https://status.x.ai/api/INC123",
                    "content": "A service status incident.",
                    "source": name,
                }], None)
            if sites:
                return ([{
                    "title": "Gemini Pro update",
                    "url": "https://techcrunch.com/gemini-update/",
                    "content": "An unrelated Google model update.",
                    "source": name,
                }], None)
            return ([{
                "title": "Grok 4.7 coverage",
                "url": "https://techcrunch.com/grok-4-7/",
                "content": "Grok 4.7 is the current model.",
                "source": name,
            }], None)

        with (patch("tools.search_orchestrator._provider_configured", side_effect=lambda p: p == "tavily"),
              patch("tools.search_orchestrator._call_provider", side_effect=provider)):
            payload = SearchOrchestrator().run(query, original_query=query, user_language="zh")

        self.assertEqual(len(calls), 4)
        self.assertIsNone(calls[2][1])
        self.assertIn("x.ai", calls[3][1])
        self.assertTrue(any("Grok 4.7" in item["title"] for item in payload["results"]))
        self.assertFalse(any("Gemini" in item["title"] for item in payload["results"]))
        self.assertFalse(any("outage" in item["title"].casefold() for item in payload["results"]))

    def test_stale_official_version_result_is_supplemented_by_mainstream_sources(self):
        calls = []
        def provider(name, query, max_results, sites=None, **_kwargs):
            calls.append(sites)
            if sites and any(domain in {"python.org", "docs.python.org"} for domain in sites):
                item = {"title": "old official release", "url": "https://python.org/old",
                        "content": "old", "publishedDate": "2024-01-01", "source": name}
            else:
                item = {"title": "Python release coverage", "url": "https://techcrunch.com/technology/python",
                        "content": "Python release coverage", "source": name}
            return ([item], None)

        with (patch("tools.search_orchestrator._provider_configured", side_effect=lambda p: p == "tavily"),
              patch("tools.search_orchestrator._call_provider", side_effect=provider)):
            payload = SearchOrchestrator().run(
                "Python 最新版本", original_query="Python 最新版本", user_language="zh",
            )

        self.assertEqual(len(calls), 2)
        self.assertTrue(any(domain in {"python.org", "docs.python.org"} for domain in calls[0]))
        self.assertTrue(any("techcrunch.com" in domain for domain in calls[1]))
        self.assertEqual({item["domain"] for item in payload["results"]}, {"python.org", "techcrunch.com"})
        self.assertEqual(payload["search_regions"], [])

    def test_global_news_still_supplements_a_missing_region(self):
        def provider(name, query, max_results, sites=None, **_kwargs):
            host = "people.com.cn" if sites and "reuters.com" not in sites else "reuters.com"
            return ([{"title": host, "url": f"https://{host}/news", "content": "actual"}], None)
        with (patch("tools.search_orchestrator._provider_configured", side_effect=lambda p: p == "tavily"),
              patch("tools.search_orchestrator._call_provider", side_effect=provider)):
            payload = SearchOrchestrator().run("最近全球有什么重要新闻")
        self.assertEqual(set(payload["searched_domains"]), {"reuters.com", "people.com.cn"})
        self.assertEqual(payload["missing_search_regions"], [])

    def test_github_missing_empty_and_failure_are_distinct_without_web_fallback(self):
        for configured, response, expected in [
            (False, ([], None), "not_configured"), (True, ([], None), "empty"),
            (True, ([], "HTTP 401"), "error"),
        ]:
            with self.subTest(expected=expected):
                query = "repo:example/project render button implementation"
                with (patch("tools.search_orchestrator._provider_configured", return_value=configured),
                      patch("tools.search_orchestrator._search_github_repositories", return_value=[]),
                      patch("tools.search_orchestrator._call_provider", return_value=response) as call):
                    payload = SearchOrchestrator().run_github(query)
                self.assertEqual(payload["github_skill_status"], expected)
                # Public repository discovery can run anonymously; the token
                # only gates code search, not the independent repository lane.
                self.assertTrue(payload["github_skill_used"])
                self.assertFalse(payload["fallback_used"])
                self.assertEqual(call.call_count, int(configured))


if __name__ == "__main__":
    unittest.main()
