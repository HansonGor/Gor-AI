"""Generate five offline design-reference QA decks; no third-party templates/assets."""

from __future__ import annotations

import json
import shutil
import sys
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from tools.presentation import build_presentation_artifact


ROOT = Path(__file__).resolve().parents[2]
OUTPUT = ROOT / ".runlogs" / "reference-acceptance"


class NoPhotos:
    def resolve(self, design):
        return {}


CASES = {
    "saas-pitch": {
        "title": "AI SaaS 融资 PPT", "theme": "modern-dark", "audience": "投资人",
        "slides": [
            {"id": "cover", "type": "cover", "title": "面向企业的 AI 工作平台", "subtitle": "产品构想 · 设计参考验收"},
            {"id": "problem", "type": "title-content", "title": "问题与机会", "supportingPoints": [
                "分散的工具让工作流难以连续", "团队需要清晰的权限与交付记录", "产品重点是可复用的任务流程"],
             "keyMessage": "把频繁任务组织为可复用的工作流"},
            {"id": "summary", "type": "summary", "title": "下一步验证", "supportingPoints": [
                "与目标团队验证高频场景", "以实际使用反馈决定产品优先级"]},
        ],
    },
    "annual-cn": {
        "title": "2026 年中文企业年度工作总结", "theme": "business", "audience": "公司管理层",
        "slides": [
            {"id": "cover", "type": "cover", "title": "年度工作总结", "subtitle": "2026 年 · 设计参考验收"},
            {"id": "review", "type": "table", "title": "工作复盘框架", "table": {
                "headers": ["领域", "本次关注"], "rows": [["产品", "核心使用场景"], ["交付", "重点项目进度"], ["协作", "跨团队流程"]]}},
            {"id": "summary", "type": "summary", "title": "下一年度重点", "supportingPoints": [
                "优先解决关键流程中的阻塞", "明确每项工作的负责人和验收节点"]},
        ],
    },
    "vehicle-launch": {
        "title": "新能源汽车旗舰车型发布会", "theme": "technology", "audience": "消费者",
        "slides": [
            {"id": "cover", "type": "cover", "title": "旗舰车型发布", "subtitle": "产品概念 · 设计参考验收"},
            {"id": "experience", "type": "big-number", "title": "设计的起点", "metrics": [
                {"label": "核心理念", "value": "01", "note": "从真实出行体验出发"}]},
            {"id": "summary", "type": "summary", "title": "产品叙事", "supportingPoints": [
                "先呈现整体形象，再讲解细节", "画面留白服务于产品本身"]},
        ],
    },
    "government-report": {
        "title": "政府部门年度工作汇报", "theme": "business", "audience": "部门管理层",
        "slides": [
            {"id": "cover", "type": "cover", "title": "年度工作汇报", "subtitle": "结构示例 · 设计参考验收"},
            {"id": "process", "type": "process", "title": "工作推进流程", "timeline": [
                {"label": "01", "title": "梳理", "detail": "明确事项与责任"},
                {"label": "02", "title": "落实", "detail": "按节点推进"},
                {"label": "03", "title": "复盘", "detail": "记录结果与问题"}]},
            {"id": "summary", "type": "summary", "title": "后续安排", "supportingPoints": [
                "对未完成事项逐项跟进", "以清晰口径汇报阶段进展"]},
        ],
    },
    "fashion-launch": {
        "title": "高级时尚品牌发布会", "theme": "minimal", "audience": "消费者",
        "slides": [
            {"id": "cover", "type": "cover", "title": "品牌新季发布", "subtitle": "视觉方向 · 设计参考验收"},
            {"id": "statement", "type": "quote", "title": "设计主张", "quote": "让材料、廓形与穿着体验成为画面的主角。"},
            {"id": "summary", "type": "summary", "title": "呈现重点", "supportingPoints": [
                "减少无意义装饰", "以清晰的视觉焦点组织页面"]},
        ],
    },
}


def main() -> None:
    OUTPUT.mkdir(parents=True, exist_ok=True)
    manifest = []
    with (patch("tools.presentation.GENERATED_ROOT", OUTPUT),
          patch("tools.presentation.ensure_storage_dirs"),
          patch("tools.presentation.create_presentation_asset_provider", return_value=NoPhotos()),
          patch("tools.presentation.create_render_provider", return_value=None)):
        for name, design in CASES.items():
            artifact = build_presentation_artifact(design)
            source = OUTPUT / f"{artifact['artifactId']}.pptx"
            destination = OUTPUT / f"{name}.pptx"
            shutil.copyfile(source, destination)
            plan = artifact["presentationSchema"]["referencePlan"]
            manifest.append({"case": name, "path": str(destination),
                             "primarySources": plan["primarySources"],
                             "secondarySources": plan["secondarySources"],
                             "calibrationSources": plan["calibrationSources"],
                             "designDNA": artifact["presentationSchema"]["designDNA"],
                             "motionStyle": artifact["presentationSchema"]["motionLanguage"]["style"]})
    (OUTPUT / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    for item in manifest:
        print(f"{item['case']}: {item['primarySources']} / {item['calibrationSources']} -> {item['path']}")


if __name__ == "__main__":
    main()
