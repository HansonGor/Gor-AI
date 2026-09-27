import io
import unittest
from unittest.mock import patch

from PIL import Image
from pptx import Presentation

from tools.pexels import PexelsPhoto, PexelsPhotoError, resolve_presentation_photos
from tools.presentation_design import PresentationDesign
from tools.presentation_renderer import render_presentation


def tiny_png() -> bytes:
    image = Image.new("RGB", (120, 80), (80, 110, 160))
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


class PresentationPexelsTest(unittest.TestCase):
    def test_photo_search_covers_every_slide_type(self):
        design = PresentationDesign.model_validate({
            "title": "City guide",
            "slides": [
                {"id": "cover", "type": "cover", "title": "Guangzhou", "imageQuery": "Guangzhou skyline"},
                {"id": "text", "type": "title-content", "title": "Details", "imageQuery": "city"},
                {"id": "image", "type": "image-text", "title": "Pearl River", "imageQuery": "Pearl River Guangzhou"},
            ],
        })
        photo = PexelsPhoto(tiny_png(), "Photographer", "https://www.pexels.com/@photographer", "https://www.pexels.com/photo/123/")
        with patch("tools.pexels.config.Pexels.API_KEY", "test-key"), patch("tools.pexels._get_photo", return_value=photo) as search:
            result = resolve_presentation_photos(design)
        self.assertEqual(set(result), {"cover", "text", "image"})
        self.assertEqual(search.call_count, 3)

    def test_missing_key_uses_theme_background_without_searching(self):
        design = PresentationDesign.model_validate({
            "title": "City guide",
            "slides": [{"id": "cover", "type": "cover", "title": "Guangzhou", "imageQuery": "Guangzhou skyline"}],
        })
        with patch("tools.pexels.config.Pexels.API_KEY", ""), patch("tools.pexels._get_photo") as search:
            self.assertEqual(resolve_presentation_photos(design), {})
        search.assert_not_called()

    def test_older_schema_gets_content_query_and_every_slide_has_photo_and_credit(self):
        design = PresentationDesign.model_validate({
            "title": "City guide",
            "slides": [
                {"id": "cover", "type": "cover", "title": "Guangzhou"},
                {"id": "food", "type": "cards", "title": "Cantonese food", "supportingPoints": ["dim sum" ]},
            ],
        })
        photo = PexelsPhoto(tiny_png(), "Photographer", "https://www.pexels.com/@photographer", "https://www.pexels.com/photo/123/")
        with patch("tools.pexels.config.Pexels.API_KEY", "test-key"), patch("tools.pexels._get_photo", return_value=photo) as search:
            assets = resolve_presentation_photos(design)
        self.assertEqual(search.call_count, 2)
        self.assertTrue(all(call.args[0] for call in search.call_args_list))

        deck = Presentation(io.BytesIO(render_presentation(design, assets)))
        self.assertEqual(len(deck.slides), 2)
        for slide in deck.slides:
            self.assertTrue(any(shape.shape_type == 13 for shape in slide.shapes))
            links = [rel.target_ref for rel in slide.part.rels.values() if rel.reltype.endswith("/hyperlink")]
            self.assertIn(photo.photographer_url, links)
            self.assertIn(photo.photo_url, links)
            self.assertIn("https://www.pexels.com", links)

    def test_missing_match_only_falls_back_on_affected_slide(self):
        design = PresentationDesign.model_validate({
            "title": "City guide",
            "slides": [
                {"id": "cover", "type": "cover", "title": "Guangzhou"},
                {"id": "food", "type": "cards", "title": "Cantonese food"},
            ],
        })
        photo = PexelsPhoto(tiny_png(), "Photographer", "https://www.pexels.com/@photographer", "https://www.pexels.com/photo/123/")
        with patch("tools.pexels.config.Pexels.API_KEY", "test-key"), patch(
            "tools.pexels._get_photo", side_effect=lambda query: photo if query == "Guangzhou" else None,
        ) as search:
            self.assertEqual(set(resolve_presentation_photos(design)), {"cover"})
        self.assertGreaterEqual(search.call_count, 3)


if __name__ == "__main__":
    unittest.main()
