"""Repeatable real acceptance artifacts; no model calls or invented product facts.

Run from Server: venv/Scripts/python.exe tests/generate_motion_acceptance.py
Pexels is optional. Missing photos are honestly reported in the manifest.
"""
import io
import json
import sys
import uuid
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from tools.presentation import build_presentation_artifact
from tools.presentation_design import compose_design
from tools.presentation_motion import direct_motion
from tools.presentation_renderer import render_presentation
from storage import GENERATED_ROOT
from presentation_samples import acceptance_designs


def motion_designs():
    slides = [
        {"id": "launch-cover", "type": "cover", "title": "把远方，带回日常", "subtitle": "新能源汽车新品发布 · 概念验收", "imageRole": "hero", "imageQuery": "electric car side profile dark studio soft light", "slideRole": "hero"},
        {"id": "launch-hero", "type": "image-text", "title": "不是更多参数，而是更好的抵达", "supportingPoints": ["安静的座舱", "自然的交互", "从容的补能"], "imageRole": "product", "imageQuery": "electric vehicle interior detail natural window light", "slideRole": "hero"},
        {"id": "launch-number", "type": "big-number", "title": "把注意力，还给旅程", "layoutVariant": "minimal-number", "metrics": [{"label": "设计原则", "value": "3", "note": "理解你 · 少打断 · 可掌控"}], "slideRole": "data"},
        {"id": "launch-product", "type": "image-text", "title": "舒适，来自每一次细节选择", "supportingPoints": ["触感材料", "自然光线", "顺手布局"], "imageRole": "product", "imageQuery": "car interior leather seat detail warm natural light", "slideRole": "explanation"},
        {"id": "launch-cards", "type": "cards", "title": "日常体验的三次升级", "supportingPoints": ["出发：少一步准备", "途中：少一次打断", "抵达：多一点从容"], "slideRole": "explanation"},
        {"id": "launch-chart", "type": "chart", "title": "让体验的变化可以被看见", "chart": {"type": "bar", "categories": ["出发", "途中", "抵达"], "series": [{"name": "演示评分", "values": [2, 3, 4]}], "chartInsight": "围绕完整旅程，持续改善体验", "annotation": "动画验收示意数据，不是产品性能承诺"}, "slideRole": "data"},
        {"id": "launch-contrast", "type": "comparison", "title": "从功能堆叠，到自然协同", "supportingPoints": ["过去：围绕功能寻找入口", "现在：围绕意图完成任务"], "slideRole": "comparison"},
        {"id": "launch-process", "type": "process", "title": "理解意图，不替你做重要决定", "timeline": [{"label": "01", "title": "理解", "detail": "识别旅程需求"}, {"label": "02", "title": "建议", "detail": "给出清晰选择"}, {"label": "03", "title": "确认", "detail": "重要操作由你掌控"}], "slideRole": "explanation"},
        {"id": "launch-breath", "type": "title-content", "title": "真正的智能，是让复杂退后一步。", "keyMessage": "真正的智能，是让复杂退后一步。", "slideRole": "breath"},
        {"id": "launch-close", "type": "summary", "title": "下一程，更从容", "supportingPoints": ["把设计留在体验里，把选择留给你。"], "slideRole": "summary"},
    ]
    launch = {"title": "新能源汽车新品发布会", "theme": "technology", "designDNA": {"compositionStyle": "dramatic", "imageTreatment": "cinematic", "whitespace": "dramatic", "decorationLevel": "minimal"}, "motionLanguage": {"style": "cinematic", "energy": "medium", "transitionFamily": "smooth"}, "slides": slides}
    consulting = acceptance_designs()["enterprise-ai-consulting"]
    consulting["motionLanguage"] = {"style": "data-driven", "energy": "low"}
    return {"launch": launch, "consulting": consulting}


def main():
    output = Path(__file__).resolve().parents[2] / ".runlogs" / "motion-acceptance"
    output.mkdir(parents=True, exist_ok=True)
    manifest = []
    for name, raw in motion_designs().items():
        artifact = build_presentation_artifact(raw)
        binary = GENERATED_ROOT / Path(artifact["downloadUrl"]).name
        (output / f"{name}.pptx").write_bytes(binary.read_bytes())
        (output / f"{name}.json").write_text(artifact["sourceFiles"]["/presentation.json"], encoding="utf-8")
        manifest.append(artifact)
        print(json.dumps({"name": name, "pages": len(artifact["presentationSchema"]["slides"]), "photos": len(artifact["presentationBackgrounds"]), "motionQA": artifact["visualQA"]["motionQA"], "path": str(output / f"{name}.pptx")}, ensure_ascii=False), flush=True)
    # A diagnostic deck lets native Office inspect every supported effect.
    effects = ["appear", "fade", "rise", "wipe", "fly", "zoom", "grow", "pulse", "colorEmphasis", "fadeOut"]
    raw = {"title": "Native motion diagnostic", "slides": [{"id": str(i), "type": "title-content", "title": effect, "slideRole": "explanation", "transition": {"effect": ["fade", "push", "wipe"][i % 3]}, "animationTimeline": [{"target": "headline", "effect": effect, "trigger": "withPrevious", "duration": .42, "order": 1}]} for i, effect in enumerate(effects)]}
    design, _ = direct_motion(compose_design(raw))
    (output / "effects.pptx").write_bytes(render_presentation(design))
    # Click edition reuses existing assets cached by query and changes no content.
    revised = json.loads(manifest[0]["sourceFiles"]["/presentation.json"])
    revised["motionLanguage"]["playback"] = "onClick"
    for slide in revised["slides"]:
        slide["animationTimeline"] = None
    click = build_presentation_artifact(revised)
    (output / "launch-click.pptx").write_bytes((GENERATED_ROOT / Path(click["downloadUrl"]).name).read_bytes())
    manifest.append(click)
    filename = f"motion-acceptance-{uuid.uuid4()}.json"
    (GENERATED_ROOT / filename).write_text(json.dumps(manifest, ensure_ascii=False), encoding="utf-8")
    (output / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Browser harness: http://127.0.0.1:5173/scripts/motion-smoke.html?manifest={filename}", flush=True)


if __name__ == "__main__":
    main()
