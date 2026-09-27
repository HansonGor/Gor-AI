"""Agent tool for versioned, validated Presentation Design Schema to PPTX output."""

from __future__ import annotations

import json
import re
import uuid
from pathlib import Path

from langchain_core.tools import tool
from pydantic import BaseModel, ConfigDict

from storage import GENERATED_ROOT, ensure_storage_dirs
from tools.presentation_design import PresentationDesign, apply_deterministic_fixes, run_visual_qa, story_outline
from tools.presentation_renderer import render_presentation
from tools.pexels import ensure_presentation_image_queries, resolve_presentation_photos


class CreatePresentationInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    presentation: PresentationDesign


def _photo_extension(image_bytes: bytes) -> str | None:
    if image_bytes.startswith(b"\xff\xd8\xff"):
        return ".jpg"
    if image_bytes.startswith(b"\x89PNG\r\n\x1a\n"):
        return ".png"
    return None


def build_presentation_artifact(raw_presentation: dict) -> dict:
    design, qa = apply_deterministic_fixes(raw_presentation)
    if not qa["passed"]:
        raise ValueError("Presentation Visual QA 未通过：" + "；".join(issue["message"] for issue in qa["issues"] if issue["severity"] == "error"))
    design = ensure_presentation_image_queries(design)

    artifact_id = str(uuid.uuid4())
    project_id = str(uuid.uuid4())
    snapshot_id = str(uuid.uuid4())
    safe_title = re.sub(r'[\\/:*?"<>|\x00-\x1f]', "-", design.title).strip(" .")[:100] or "演示文稿"
    display_name = f"{safe_title}.pptx"
    stored_name = f"{artifact_id}.pptx"
    ensure_storage_dirs()
    destination = (GENERATED_ROOT / stored_name).resolve()
    if destination.parent != GENERATED_ROOT.resolve():
        raise ValueError("PPTX 输出路径无效。")

    photo_assets = resolve_presentation_photos(design)
    pptx_bytes = render_presentation(design, photo_assets=photo_assets)
    if len(pptx_bytes) > 32 * 1024 * 1024:
        raise ValueError("PPTX 超过 32 MB 限制。")

    # The HTML preview needs the exact photos embedded in the PPTX. Store
    # bounded image copies separately so the semantic source schema stays
    # editable and the preview survives a page refresh.
    preview_backgrounds = {}
    created_paths: list[Path] = []
    try:
        for index, slide in enumerate(design.slides, start=1):
            photo = photo_assets.get(slide.id)
            if not photo or not (extension := _photo_extension(photo.image_bytes)):
                continue
            image_name = f"{artifact_id}-slide-{index:02d}{extension}"
            image_path = (GENERATED_ROOT / image_name).resolve()
            with image_path.open("xb") as output:
                output.write(photo.image_bytes)
            created_paths.append(image_path)
            preview_backgrounds[slide.id] = {
                "url": f"/api/download/{image_name}?inline=true",
                "photographer": photo.photographer,
                "photographerUrl": photo.photographer_url,
                "photoUrl": photo.photo_url,
            }
        with destination.open("xb") as output:
            output.write(pptx_bytes)
    except Exception:
        for path in created_paths:
            path.unlink(missing_ok=True)
        raise

    schema = design.model_dump(mode="json")
    mime_type = "application/vnd.openxmlformats-officedocument.presentationml.presentation"
    return {
        "success": True,
        "fileType": "ppt",
        "displayName": display_name,
        "downloadUrl": f"/api/download/{stored_name}",
        "artifactId": artifact_id,
        "projectId": project_id,
        "snapshotId": snapshot_id,
        "extension": ".pptx",
        "mimeType": mime_type,
        "previewRenderer": "presentation",
        "editableSource": True,
        "sourceFiles": {"/presentation.json": json.dumps(schema, ensure_ascii=False, indent=2)},
        "presentationSchema": schema,
        "presentationBackgrounds": preview_backgrounds,
        "storyOutline": story_outline(design),
        "visualQA": qa,
        "size": len(pptx_bytes),
    }


@tool(args_schema=CreatePresentationInput)
def create_presentation(presentation: dict) -> str:
    """Plan and render an editable PPTX from a semantic Presentation Design Schema.

    The assistant should first plan a narrative arc, vary slide types/layouts,
    and provide semantic content only; never supply pixel coordinates. To revise
    a deck, start from the latest schema in conversation context, change only
    requested content/theme, and call this tool again to create a new snapshot.
    """
    try:
        artifact = build_presentation_artifact(presentation)
        return json.dumps(artifact, ensure_ascii=False)
    except Exception as exc:
        return json.dumps({"success": False, "error": str(exc)}, ensure_ascii=False)
