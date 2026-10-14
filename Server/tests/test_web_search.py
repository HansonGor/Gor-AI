import unittest
from unittest.mock import patch

from tools import web_search


class _FakeResponse:
    def __init__(self, payload, status_code=200):
        self._payload = payload
        self.status_code = status_code

    def raise_for_status(self):
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}")

    def json(self):
        return self._payload


class BochaSearchTest(unittest.TestCase):
    def test_missing_key_skips_without_request(self):
        with (patch.object(web_search.config.Search, "BOCHA_API_KEY", ""),
              patch.object(web_search.httpx, "post") as post):
            self.assertEqual(web_search._search_bocha("杭州天气"), [])
            post.assert_not_called()

    def test_maps_web_pages_and_include_sites(self):
        payload = {
            "code": 200,
            "data": {
                "webPages": {
                    "value": [
                        {
                            "name": "杭州天气",
                            "url": "https://weather.example/hangzhou",
                            "summary": "long summary",
                            "snippet": "short",
                            "siteName": "Weather",
                            "datePublished": "2026-10-14",
                        },
                        {
                            "name": "no url",
                            "url": "  ",
                            "summary": "drop me",
                        },
                    ]
                }
            },
        }
        with (patch.object(web_search.config.Search, "BOCHA_API_KEY", "sk-test"),
              patch.object(web_search.httpx, "post", return_value=_FakeResponse(payload)) as post):
            items = web_search._search_bocha("杭州天气", max_results=5, sites=["weather.example"])

        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]["title"], "杭州天气")
        self.assertEqual(items[0]["url"], "https://weather.example/hangzhou")
        self.assertEqual(items[0]["content"], "long summary")
        self.assertEqual(items[0]["source"], "bocha/Weather")
        self.assertEqual(items[0]["published_date"], "2026-10-14")
        body = post.call_args.kwargs["json"]
        self.assertEqual(body["freshness"], "noLimit")
        self.assertTrue(body["summary"])
        self.assertEqual(body["include"], "weather.example")
        self.assertEqual(
            post.call_args.args[0],
            "https://api.bochaai.com/v1/web-search",
        )

    def test_non_200_code_raises(self):
        payload = {"code": "401", "msg": "unauthorized", "log_id": "abc"}
        with (patch.object(web_search.config.Search, "BOCHA_API_KEY", "sk-test"),
              patch.object(web_search.httpx, "post", return_value=_FakeResponse(payload))):
            with self.assertRaisesRegex(RuntimeError, "bocha search error"):
                web_search._search_bocha("杭州天气")


if __name__ == "__main__":
    unittest.main()
