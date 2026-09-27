import io
import json
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

from PIL import Image
from pptx import Presentation

from tools.presentation import build_presentation_artifact
from tools.presentation_design import PresentationDesign, apply_deterministic_fixes, run_visual_qa, story_outline
from tools.presentation_renderer import render_presentation
from tools.pexels import PexelsPhoto


def fixture_design():
    return {
        "version": "1.0",
        "title": "季度业务复盘",
        "audience": "管理团队",
        "purpose": "复盘进展并对齐下一步",
        "theme": "modern-dark",
        "aspectRatio": "16:9",
        "slides": [
            {"id": "cover", "type": "cover", "title": "季度业务复盘", "subtitle": "增长与下一阶段", "eyebrow": "Q3 REVIEW"},
            {"id": "metrics", "type": "metrics", "title": "关键指标", "metrics": [
                {"label": "收入", "value": "¥12.8M", "note": "同比 +18%"},
                {"label": "留存", "value": "76%", "note": "提升 4pt"},
            ]},
            {"id": "chart", "type": "chart", "title": "月度表现", "chart": {
                "type": "bar", "categories": ["4月", "5月", "6月"],
                "series": [{"name": "营收", "values": [3.0, 3.8, 4.2]}], "unit": "M",
            }},
            {"id": "table", "type": "table", "title": "行动清单", "table": {
                "headers": ["工作流", "负责人"], "rows": [["稳定性", "平台组"], ["留存", "产品组"]],
                "highlightRows": [0],
            }},
        ],
    }


class PresentationDesignTest(unittest.TestCase):
    def test_schema_and_outline_are_semantic_and_unique(self):
        design = PresentationDesign.model_validate(fixture_design())
        outline = story_outline(design)
        self.assertEqual([slide["slideId"] for slide in outline], ["cover", "metrics", "chart", "table"])
        self.assertTrue(all("x" not in slide and "y" not in slide for slide in outline))
        invalid = fixture_design()
        invalid["slides"][1]["id"] = "cover"
        with self.assertRaises(ValueError):
            PresentationDesign.model_validate(invalid)

    def test_bounded_qa_and_renderer_create_native_chart_and_table(self):
        fixed, qa = apply_deterministic_fixes(fixture_design())
        self.assertTrue(qa["passed"], qa["issues"])
        self.assertEqual(qa["attempts"], 1)
        self.assertTrue(run_visual_qa(fixed)["passed"])
        presentation = Presentation(io.BytesIO(render_presentation(fixed)))
        self.assertEqual(len(presentation.slides), 4)
        self.assertTrue(any(shape.has_chart for shape in presentation.slides[2].shapes))
        self.assertTrue(any(shape.has_table for shape in presentation.slides[3].shapes))

    def test_all_fifteen_slide_types_and_native_chart_variants_render(self):
        slides = []
        for index, slide_type in enumerate((
            "cover", "section", "title-content", "image-text", "full-image", "big-number", "metrics",
            "comparison", "timeline", "process", "cards", "chart", "table", "quote", "summary",
        )):
            slide = {"id": f"slide-{index}", "type": slide_type, "title": slide_type, "supportingPoints": ["核心信息", "补充信息"]}
            if slide_type in {"big-number", "metrics"}:
                slide["metrics"] = [{"label": "指标", "value": "42"}]
            if slide_type in {"timeline", "process"}:
                slide["timeline"] = [{"label": "阶段一", "title": "推进", "detail": "完成关键工作"}]
            if slide_type == "chart":
                slide["chart"] = {"type": "bar", "categories": ["一月", "二月"], "series": [{"name": "数量", "values": [2, 3]}]}
            if slide_type == "table":
                slide["table"] = {"headers": ["项目"], "rows": [["内容"]]}
            if slide_type == "quote":
                slide["quote"] = "保持简洁"
            slides.append(slide)
        chart_slides = [
            {"id": f"chart-{kind}", "type": "chart", "title": kind, "chart": {
                "type": kind, "categories": ["A", "B", "C"], "series": [{"name": "Series", "values": [1, 2, 3]}],
            }} for kind in ("bar", "line", "area", "donut")
        ]
        design = PresentationDesign.model_validate({**fixture_design(), "slides": slides + chart_slides})
        rendered = Presentation(io.BytesIO(render_presentation(design)))
        self.assertEqual(len(rendered.slides), 19)

    def test_dense_content_is_paginated_and_every_rendered_shape_stays_on_canvas(self):
        long_text = "广州旅游攻略：地理位置优越，公共交通便捷，适合安排三天深度游并体验当地美食。 " * 12
        source_rows = [[f"景点{i}", f"介绍第{i}个景点的路线、交通与游玩建议"] for i in range(8)]
        raw = {
            **fixture_design(),
            "slides": [
                {"id": "metrics-overflow", "type": "metrics", "title": "行前关键数据", "layoutVariant": "hero-metric", "metrics": [
                    {"label": name, "value": str(index), "note": "供行程规划参考"}
                    for index, name in enumerate(("天气", "预算", "交通", "住宿"), start=1)
                ]},
                {"id": "cards-overflow", "type": "comparison", "title": "住宿区域比较", "supportingPoints": ["荔湾：老城美食与传统街区", "天河：交通枢纽与现代商圈", "海珠：江景与会展片区"]},
                {"id": "content-overflow", "type": "title-content", "title": "详细行程安排", "supportingPoints": [long_text]},
                {"id": "table-overflow", "type": "table", "title": "景点信息", "table": {"headers": ["景点", "说明"], "rows": source_rows, "highlightRows": [0, 6]}},
            ],
        }
        fixed, qa = apply_deterministic_fixes(raw)
        self.assertTrue(qa["passed"], qa["issues"])
        self.assertEqual(fixed.slides[0].layoutVariant, "2-column")
        self.assertEqual(len(fixed.slides), 6)  # cards 1 + body 2 + table 2, plus metrics 1
        body_slides = [slide for slide in fixed.slides if slide.id.startswith("content-overflow")]
        self.assertGreater(len(body_slides), 1)
        self.assertEqual("".join(point for slide in body_slides for point in slide.supportingPoints), long_text)
        table_slides = [slide for slide in fixed.slides if slide.id.startswith("table-overflow")]
        self.assertEqual([len(slide.table.rows) for slide in table_slides], [5, 3])
        self.assertEqual(table_slides[0].table.highlightRows, [0])
        self.assertEqual(table_slides[1].table.highlightRows, [1])

        rendered = Presentation(io.BytesIO(render_presentation(fixed)))
        for slide in rendered.slides:
            for shape in slide.shapes:
                self.assertGreaterEqual(shape.left, 0, shape.name)
                self.assertGreaterEqual(shape.top, 0, shape.name)
                self.assertLessEqual(shape.left + shape.width, rendered.slide_width + 20000, shape.name)
                self.assertLessEqual(shape.top + shape.height, rendered.slide_height + 20000, shape.name)


    def test_generation_returns_message_ready_artifact_metadata_and_exclusive_file(self):
        image = Image.new("RGB", (120, 80), (80, 110, 160))
        image_buffer = io.BytesIO()
        image.save(image_buffer, format="PNG")
        photo = PexelsPhoto(image_buffer.getvalue(), "Photographer", "https://www.pexels.com/@photographer", "https://www.pexels.com/photo/123/")

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            with patch("tools.presentation.GENERATED_ROOT", root), patch("tools.presentation.ensure_storage_dirs"), patch(
                "tools.presentation.resolve_presentation_photos",
                side_effect=lambda design: {slide.id: photo for slide in design.slides},
            ):
                artifact = build_presentation_artifact(fixture_design())
                self.assertEqual(artifact["displayName"], "季度业务复盘.pptx")
                self.assertEqual(artifact["extension"], ".pptx")
                self.assertEqual(artifact["previewRenderer"], "presentation")
                self.assertEqual(artifact["editableSource"], True)
                self.assertIn("/presentation.json", artifact["sourceFiles"])
                self.assertTrue(all(slide["imageQuery"] for slide in artifact["presentationSchema"]["slides"]))
                self.assertEqual(len(artifact["presentationBackgrounds"]), 4)
                for background in artifact["presentationBackgrounds"].values():
                    self.assertTrue((root / background["url"].split("/api/download/")[1].split("?")[0]).is_file())
                stored_file = root / Path(artifact["downloadUrl"]).name
                self.assertGreater(stored_file.stat().st_size, 1000)
                self.assertEqual(json.loads(artifact["sourceFiles"]["/presentation.json"])["title"], "季度业务复盘")
                with self.assertRaises(FileExistsError):
                    stored_file.open("xb")

    def test_generation_without_photo_key_still_delivers_theme_backgrounds(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            with patch("tools.presentation.GENERATED_ROOT", root), patch("tools.presentation.ensure_storage_dirs"), patch("tools.pexels.config.Pexels.API_KEY", ""):
                artifact = build_presentation_artifact(fixture_design())
            self.assertEqual(artifact["presentationBackgrounds"], {})
            self.assertEqual(len(Presentation(io.BytesIO((root / Path(artifact["downloadUrl"]).name).read_bytes())).slides), 4)

    def test_photo_background_overlay_is_translucent_in_pptx(self):
        image = Image.new("RGB", (120, 80), (80, 110, 160))
        image_buffer = io.BytesIO()
        image.save(image_buffer, format="PNG")
        photo = PexelsPhoto(image_buffer.getvalue(), "Photographer", "https://www.pexels.com/@photographer", "https://www.pexels.com/photo/123/")
        rendered = render_presentation(fixture_design(), {"cover": photo})
        with zipfile.ZipFile(io.BytesIO(rendered)) as archive:
            slide_xml = archive.read("ppt/slides/slide1.xml")
        self.assertIn(b'<a:alpha val="55000"', slide_xml)
        presentation = Presentation(io.BytesIO(rendered))
        self.assertTrue(any(shape.shape_type == 13 for shape in presentation.slides[0].shapes))


if __name__ == "__main__":
    unittest.main()
