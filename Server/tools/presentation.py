"""Agent tool for versioned, validated Presentation Design Schema to PPTX output."""

from __future__ import annotations

import json
import re
import uuid
from pathlib import Path

from langchain_core.tools import tool
from pydantic import BaseModel, ConfigDict, model_validator

from storage import GENERATED_ROOT, ensure_storage_dirs
from tools.presentation_design import MAX_QA_ROUNDS, PresentationDesign, anti_ai_pattern_report, apply_deterministic_fixes, compose_design, run_visual_qa, story_outline
from tools.presentation_renderer import render_presentation
from tools.pexels import PexelsProvider, PresentationAssetProvider, SharedImageSearchProvider, ensure_presentation_image_queries
from tools.presentation_render import RenderedSlide, create_render_provider
from tools.presentation_critique import apply_safe_critique_patches, critique_rendered_slides
from tools.presentation_motion import direct_motion, SlideTransition, inspect_motion
from tools.presentation_reference import PublicIndexedReferenceProvider, apply_reference_system
from tools.presentation_revision import PresentationRevision, merge_revision, revision_source, restore_unaffected


def create_presentation_asset_provider() -> PresentationAssetProvider:
    """Bridge PPT asset embedding to the same image search used by search_images."""
    return SharedImageSearchProvider()


class CreatePptInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    presentation: PresentationDesign | None = None
    revision: PresentationRevision | None = None

    @model_validator(mode="after")
    def exactly_one_input(self):
        if (self.presentation is None) == (self.revision is None):
            raise ValueError("新稿传 presentation，修改传 revision，必须且只能选择一种。")
        return self


def _photo_extension(image_bytes: bytes) -> str | None:
    if image_bytes.startswith(b"\xff\xd8\xff"):
        return ".jpg"
    if image_bytes.startswith(b"\x89PNG\r\n\x1a\n"):
        return ".png"
    return None


def build_presentation_artifact(raw_presentation: dict, *, affected_slides: set[str] | None = None) -> dict:
    # Recompute the weighted source plan and fetch only public-indexed page
    # metadata before deterministic composition. No template file is downloaded.
    initial = PresentationDesign.model_validate(raw_presentation)
    def preserve(candidate):
        return restore_unaffected(candidate, initial, affected_slides) if affected_slides is not None else candidate
    local_revision = affected_slides is not None and affected_slides != {slide.id for slide in initial.slides}
    reference_design = (initial if local_revision and initial.referencePlan else apply_reference_system(
        initial, provider=PublicIndexedReferenceProvider()
    ))
    design, qa = apply_deterministic_fixes(reference_design, preserve_existing_pages=affected_slides is not None)
    if not qa["passed"]:
        raise ValueError("Presentation Visual QA 未通过：" + "；".join(issue["message"] for issue in qa["issues"] if issue["severity"] == "error"))
    design = preserve(compose_design(ensure_presentation_image_queries(design)))

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

    photo_assets = create_presentation_asset_provider().resolve(design)
    # Be defensive around injected/legacy providers: only schema-authorized
    # image roles may influence the PPTX or its preview assets.
    photo_assets = {
        slide.id: photo_assets[slide.id]
        for slide in design.slides
        if slide.id in photo_assets and slide.imageRole != "none"
    }
    render_provider = create_render_provider()
    rendered_slides: list[RenderedSlide] = []
    render_status = "schema-fallback"
    critique = {"status": "unavailable", "summary": "没有可用的 LibreOffice 渲染器，使用 Schema 预览和程序化设计检查。", "issues": [], "patches": []}
    rounds = 0
    pptx_bytes = b""
    motion_qa = {}
    while rounds < MAX_QA_ROUNDS:
        rounds += 1
        design, motion_qa = direct_motion(design, set(photo_assets))
        design = preserve(design)
        warnings = []
        render_args = {"photo_assets": photo_assets, "motion_warnings": warnings}
        if affected_slides is not None:
            render_args["prepared"] = True
        pptx_bytes = render_presentation(design, **render_args)
        if warnings:
            failed = {warning["slideId"] for warning in warnings}
            design = design.model_copy(update={"slides": [slide.model_copy(update={"animationTimeline": [], "transition": SlideTransition(effect="none"), "motionDisabled": True}) if slide.id in failed else slide for slide in design.slides]})
            motion_qa.update(inspect_motion(design))
            motion_qa["nativeFallbacks"] = warnings
        if render_provider is None:
            break
        try:
            rendered_slides = render_provider.render(pptx_bytes)
            render_status = "rendered"
        except Exception as exc:
            # A host-level renderer outage is not a PPTX generation failure.
            render_status = f"fallback:{type(exc).__name__}"
            rendered_slides = []
            break
        critique_result = critique_rendered_slides(rendered_slides, design)
        critique = critique_result.model_dump(mode="json")
        if rounds >= MAX_QA_ROUNDS or not critique_result.patches:
            break
        try:
            patched = apply_safe_critique_patches(design, critique_result)
            if patched.model_dump(mode="json") == design.model_dump(mode="json"):
                break
            design, _ = apply_deterministic_fixes(patched, preserve_existing_pages=affected_slides is not None)
            design = preserve(compose_design(ensure_presentation_image_queries(design)))
        except (ValueError, TypeError):
            # Invalid model-proposed edits are ignored; the original valid deck remains deliverable.
            break
    qa = run_visual_qa(design)
    qa["attempts"] = rounds
    qa["maxAttempts"] = MAX_QA_ROUNDS
    qa["renderStatus"] = render_status
    qa["renderProvider"] = render_provider.name if render_status == "rendered" and render_provider else None
    qa["designCritique"] = critique
    qa["motionQA"] = motion_qa
    qa["referenceQA"] = {
        "mode": design.referencePlan.providerStatus if design.referencePlan else "unavailable",
        "primarySources": design.referencePlan.primarySources if design.referencePlan else [],
        "calibrationSources": design.referencePlan.calibrationSources if design.referencePlan else [],
        "retrievedPageCount": len(design.referencePlan.retrievedReferences) if design.referencePlan else 0,
        "copyrightBoundary": "public-search-metadata-only-no-template-files-copied",
    }
    photo_keys = [photo.photo_url for photo in photo_assets.values()]
    pattern_report = anti_ai_pattern_report(design, photo_keys)
    qa["antiAIPatternReport"] = pattern_report
    if not critique.get("issues"):
        qa["designCritique"] = {
            **critique,
            "issues": pattern_report["issues"],
            "ruleBasedFallback": True,
        }
    if len(pptx_bytes) > 32 * 1024 * 1024:
        raise ValueError("PPTX 超过 32 MB 限制。")

    # The HTML preview needs the exact photos embedded in the PPTX. Store
    # bounded image copies separately so the semantic source schema stays
    # editable and the preview survives a page refresh.
    preview_backgrounds = {}
    preview_slides = []
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
                "imageRole": slide.imageRole,
            }
        for index, rendered in enumerate(rendered_slides):
            if index >= len(design.slides):
                break
            image_name = f"{artifact_id}-render-{index + 1:02d}.png"
            image_path = (GENERATED_ROOT / image_name).resolve()
            with image_path.open("xb") as output:
                output.write(rendered.image_bytes)
            created_paths.append(image_path)
            preview_slides.append({
                "slideId": design.slides[index].id,
                "index": index,
                "url": f"/api/download/{image_name}?inline=true",
                "thumbnailUrl": f"/api/download/{image_name}?inline=true",
                "mimeType": rendered.mime_type,
            })
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
        "renderedSlides": preview_slides,
        "storyOutline": story_outline(design),
        "visualQA": qa,
        "antiAIPatternReport": pattern_report,
        "designCritique": qa["designCritique"],
        "size": len(pptx_bytes),
    }


@tool(args_schema=CreatePptInput)
def create_ppt(presentation: dict | None = None, revision: dict | None = None) -> str:
    """Plan and render an editable PPTX from a semantic Presentation Design Schema.

    The assistant should first plan a narrative arc, vary slide types/layouts,
    and provide semantic content only; never supply pixel coordinates. To revise
    a deck, use revision with the exact baseFingerprint from the request's
    presentation-schema-data. updates contains slideId and changes (changed
    fields only; nested objects merge, lists replace). deckChanges changes global
    fields, appendSlides adds complete slides, removeSlideIds deletes exact IDs.
    Untouched pages are retained server-side. Never reconstruct a whole deck from
    a partial context. New decks use the full presentation parameter. Supply
    exactly one parameter. Both paths generate a new independent snapshot.
    """
    try:
        if revision is not None:
            presentation, affected = merge_revision(revision_source.get(), revision)
            artifact = build_presentation_artifact(presentation, affected_slides=affected)
        elif presentation is not None:
            source = revision_source.get()
            if source and not {slide["id"] for slide in source.get("slides", [])}.issubset(
                    {slide.get("id") for slide in presentation.get("slides", [])}):
                raise ValueError("完整 presentation 缺少原稿页面；局部修改或删除请使用 revision 补丁，不能用部分上下文覆盖整稿。")
            artifact = build_presentation_artifact(presentation)
        else:
            raise ValueError("缺少 PPT 内容或修改补丁。")
        return json.dumps(artifact, ensure_ascii=False)
    except Exception as exc:
        return json.dumps({"success": False, "error": str(exc)}, ensure_ascii=False)
