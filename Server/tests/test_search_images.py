import json
import unittest
from unittest.mock import Mock, patch

from tools.image_search import search_images


class PexelsSearchToolTest(unittest.TestCase):
    def test_returns_citable_photo_metadata_without_downloading_the_image(self):
        response = Mock()
        response.json.return_value = {"photos": [
            {"id": 7, "alt": "Guangzhou arcade street", "url": "https://www.pexels.com/photo/7/",
             "photographer": "Photographer", "photographer_url": "https://www.pexels.com/@photographer/",
             "width": 1600, "height": 900, "src": {"large": "https://images.pexels.com/photos/7/large.jpeg"}},
            {"id": 8, "url": "https://example.com/photo/8", "src": {"large": "https://example.com/image.jpg"}},
        ]}
        with (patch("tools.image_search.config.Pexels.API_KEY", "test-secret"),
              patch("tools.image_search.httpx.get", return_value=response) as get):
            payload = json.loads(search_images.func("广州骑楼 清晨", "landscape", "pexels"))

        self.assertEqual(payload["providers"][0]["provider"], "Pexels")
        self.assertEqual(len(payload["results"]), 1)
        self.assertEqual(payload["results"][0]["pageUrl"], "https://www.pexels.com/photo/7/")
        self.assertEqual(get.call_count, 1)
        self.assertNotIn("test-secret", json.dumps(payload))

    def test_missing_api_key_skips_keyed_provider(self):
        with patch("tools.image_search.config.ImageSearch.PIXABAY_API_KEY", ""), patch("tools.image_search.httpx.get") as get:
            payload = json.loads(search_images.func("Guangzhou arcade street", "landscape", "pixabay"))
        self.assertEqual(payload["results"], [])
        self.assertEqual(payload["providers"][0]["status"], "skipped")
        get.assert_not_called()

    def test_openverse_results_preserve_creative_commons_metadata(self):
        response = Mock()
        response.json.return_value = {"results": [{
            "id": "image-1", "title": "Guangzhou street", "url": "https://images.example.org/image.jpg",
            "thumbnail": "https://images.example.org/thumb.jpg", "foreign_landing_url": "https://example.org/photo/1",
            "creator": "Photographer", "license": "by", "license_version": "4.0",
            "license_url": "https://creativecommons.org/licenses/by/4.0/", "width": 1600, "height": 900,
        }]}
        with patch("tools.image_search.httpx.get", return_value=response):
            payload = json.loads(search_images.func("Guangzhou", "landscape", "openverse"))
        self.assertEqual(payload["results"][0]["license"], "by 4.0")
        self.assertEqual(payload["results"][0]["licenseUrl"], "https://creativecommons.org/licenses/by/4.0/")

    def test_unsplash_uses_access_key_and_returns_attribution_and_download_location(self):
        response = Mock()
        response.json.return_value = {"results": [{
            "id": "photo-1", "alt_description": "Guangzhou at night", "urls": {"regular": "https://images.unsplash.com/photo-1"},
            "links": {"html": "https://unsplash.com/photos/photo-1", "download_location": "https://api.unsplash.com/photos/photo-1/download"},
            "user": {"name": "Photographer", "links": {"html": "https://unsplash.com/@photographer"}},
            "width": 1600, "height": 900,
        }]}
        with (patch("tools.image_search.config.ImageSearch.UNSPLASH_ACCESS_KEY", "test-access-key"),
              patch("tools.image_search.httpx.get", return_value=response) as get):
            payload = json.loads(search_images.func("Guangzhou", "landscape", "unsplash"))
        self.assertIn("Client-ID test-access-key", get.call_args.kwargs["headers"]["Authorization"])
        self.assertIn("utm_source=gor", payload["results"][0]["creatorUrl"])
        self.assertTrue(payload["results"][0]["downloadLocation"].endswith("/download"))
        self.assertNotIn("test-access-key", json.dumps(payload))

    def test_wikimedia_results_include_license_metadata(self):
        response = Mock()
        response.json.return_value = {"query": {"pages": [{
            "pageid": 42, "title": "File:Guangzhou.jpg", "imageinfo": [{
                "thumburl": "https://upload.wikimedia.org/thumb.jpg", "descriptionurl": "https://commons.wikimedia.org/wiki/File:Guangzhou.jpg",
                "width": 1600, "height": 900, "extmetadata": {
                    "Artist": {"value": "<a>Photographer</a>"}, "LicenseShortName": {"value": "CC BY-SA 4.0"},
                    "LicenseUrl": {"value": "https://creativecommons.org/licenses/by-sa/4.0/"},
                },
            }],
        }]}}
        with patch("tools.image_search.httpx.get", return_value=response):
            payload = json.loads(search_images.func("Guangzhou", "landscape", "wikimedia"))
        self.assertEqual(payload["results"][0]["creator"], "Photographer")
        self.assertEqual(payload["results"][0]["license"], "CC BY-SA 4.0")


if __name__ == "__main__":
    unittest.main()
