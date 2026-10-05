import unittest
from unittest.mock import patch

from tools.search_orchestrator import (
    SearchOrchestrator, _canonical_url, _dedupe, classify_intent,
)


class SearchOrchestratorTest(unittest.TestCase):
    def test_routes_each_intent_to_domain_specialists(self):
        self.assertEqual(classify_intent("React useMemo 源码实现"), "code_example")
        self.assertEqual(classify_intent("广州陈家祠开放时间"), "official_fact")
        self.assertEqual(classify_intent("广州旅游攻略推荐"), "user_experience")

    def test_parallel_intent_plan_combines_specialist_and_general_results(self):
        def provider(name, query, max_results, sites=None):
            if name == "github":
                return ([{"title": "repo:file", "url": "https://github.com/a/b/blob/main/x.ts",
                          "content": "path: x.ts", "source": "github"}], None)
            return ([{"title": name, "url": f"https://{name}.example/docs",
                      "content": f"from {name}", "source": name}], None)

        with (patch("tools.search_orchestrator._provider_configured", return_value=True),
              patch("tools.search_orchestrator._call_provider", side_effect=provider) as call):
            payload = SearchOrchestrator().run("React hook 源码实现")

        self.assertEqual(payload["intent"], "code_example")
        self.assertEqual(set(payload["successful_provider"]), {"github", "tavily", "brave", "serper", "doubao"})
        self.assertEqual(call.call_count, 5)
        self.assertEqual(payload["results"][0]["providers"], ["github"])
        self.assertIn("sourceId", payload["results"][0])

    def test_explicit_site_filter_is_hard_and_result_urls_are_checked(self):
        def provider(name, query, max_results, sites=None):
            return ([
                {"title": "allowed", "url": "https://docs.acme.dev/a", "content": "yes", "source": name},
                {"title": "spoof", "url": "https://notexample.com/a", "content": "no", "source": name},
            ], None)

        with (patch("tools.search_orchestrator._provider_configured", return_value=True),
              patch("tools.search_orchestrator._call_provider", side_effect=provider) as call):
            payload = SearchOrchestrator().run("API docs site:acme.dev")

        self.assertEqual(payload["explicit_domains"], ["acme.dev"])
        self.assertEqual([item["url"] for item in payload["results"]], ["https://docs.acme.dev/a"])
        self.assertEqual(call.call_count, 5 if payload["intent"] == "code_example" else 4)
        self.assertFalse(payload["fallback_used"])

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


if __name__ == "__main__":
    unittest.main()
