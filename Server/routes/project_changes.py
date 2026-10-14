"""Explicit confirmation and undo API shared by both project providers."""
from fastapi import APIRouter, HTTPException, Response
from project_api.changes import UndoService
from project_api.review import ApplyService
from pydantic import BaseModel
from typing import Literal
from project_api.types import ProjectAPIError
from project_api.providers.preview import PreviewProjectProvider
from project_api.providers.vscode import VSCodeProjectProvider
from services.preview_project_service import PreviewProjectService
from services.preview.workspace import PreviewProjectWorkspace
from db.project_changes import change_sets, get_edit_mode, set_edit_mode
from db.supabase_chat import get_session_preview_project, update_session_preview_project_if_revision, create_session_preview_project

router = APIRouter()


async def provider_factory(ref, record):
    if ref.provider == "vscode":
        return VSCodeProjectProvider()
    if ref.provider != "preview":
        raise ProjectAPIError("UNSUPPORTED_OPERATION", "未知项目 Provider。")
    row = await get_session_preview_project(record["sessionId"])
    new_candidate = bool(record.get("previewNewProject") and record.get("previewCandidate")
                         and (not row or row["project"].get("id") != ref.project_id))
    if new_candidate:
        if (row or {}).get("revision") != record.get("previewParentRevision") or (row or {}).get("project", {}).get("id") != record.get("previewParentProjectId"):
            raise ProjectAPIError("VERSION_CONFLICT", "项目在本轮修改期间已发生变化。")
        baseline = record["previewBaseProject"]
    elif not row or row["project"].get("id") != ref.project_id:
        raise ProjectAPIError("PROJECT_NOT_CURRENT", "此项目不是会话当前虚拟项目，请先恢复该项目再撤销。")
    else:
        baseline = row["project"]
    provider = PreviewProjectProvider(PreviewProjectService(PreviewProjectWorkspace.from_request(baseline)))

    async def commit(workspace):
        project = {**baseline, **(record.get("previewCandidate") or {}), "files": workspace.files, "revision": workspace.revision}
        if new_candidate and any(file["status"] == "pending" for file in record["files"]):
            # Confirm individual files into a private virtual draft. Do not replace
            # the current preview until every candidate has been confirmed.
            record["previewBaseProject"] = project
            return
        saved = await update_session_preview_project_if_revision(record["sessionId"], project, row["revision"]) if row else await create_session_preview_project(record["sessionId"], project)
        if not saved:
            raise ProjectAPIError("VERSION_CONFLICT", "项目在撤销期间发生变化，未保存撤销。")
        if any(file["status"] == "applying" for file in record["files"]) and not any(file["status"] == "pending" for file in record["files"]):
            record["previewPublishedSnapshot"] = {**project, "projectId": project["id"],
                "messageId": record.get("messageId"),
                "outputExtension": ".glb" if project.get("template") == "html" and "/src/scene.json" in project["files"] else ".html"}
        provider.sync_result = {"previewProject": project, "serverRevision": saved["revision"]}
    provider.commit_restore = commit
    return provider


service = UndoService(change_sets, provider_factory)
apply_service = ApplyService(change_sets, provider_factory)


async def invoke(session_id, change_set_id, action, file_id=None):
    try:
        record = await service.getChangeSet(change_set_id)
        if record["sessionId"] != session_id:
            raise HTTPException(404, "变更记录不属于此会话。")
        if action == "get":
            return record
        if action == "apply":
            return await apply_service.applyFile(change_set_id, file_id) if file_id else await apply_service.applyChangeSet(change_set_id)
        return await service.undoFile(change_set_id, file_id) if file_id else await service.undoChangeSet(change_set_id)
    except ProjectAPIError as error:
        raise HTTPException(409, {"code": error.code, "message": error.message}) from error


@router.get("/session/{session_id}/change-sets/{change_set_id}")
async def get_change_set(session_id: str, change_set_id: str):
    return await invoke(session_id, change_set_id, "get")


@router.post("/session/{session_id}/change-sets/{change_set_id}/undo")
async def undo_change_set(session_id: str, change_set_id: str):
    return await invoke(session_id, change_set_id, "undo")


@router.post("/session/{session_id}/change-sets/{change_set_id}/files/{file_id}/undo")
async def undo_file(session_id: str, change_set_id: str, file_id: str):
    return await invoke(session_id, change_set_id, "undo", file_id)


@router.post("/session/{session_id}/change-sets/{change_set_id}/apply")
async def apply_change_set(session_id: str, change_set_id: str):
    return await invoke(session_id, change_set_id, "apply")


@router.post("/session/{session_id}/change-sets/{change_set_id}/files/{file_id}/apply")
async def apply_file(session_id: str, change_set_id: str, file_id: str):
    return await invoke(session_id, change_set_id, "apply", file_id)


class EditPreference(BaseModel):
    editMode: Literal["auto", "review"]


@router.get("/session/{session_id}/edit-mode")
async def read_edit_preference(session_id: str, response: Response):
    response.headers["Cache-Control"] = "no-store"
    return {"editMode": await get_edit_mode(session_id)}


@router.put("/session/{session_id}/edit-mode")
async def write_edit_preference(session_id: str, body: EditPreference, response: Response):
    response.headers["Cache-Control"] = "no-store"
    await set_edit_mode(session_id, body.editMode)
    return body
