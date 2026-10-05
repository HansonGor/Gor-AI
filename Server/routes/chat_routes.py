"""
会话管理路由
职责：会话创建、消息查询、会话列表、消息保存、会话删除
"""
from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel, Field
from typing import Optional
import re
import uuid
import json
from pathlib import Path

from db.supabase_chat import (
    create_session,
    delete_pending_session_attachment,
    delete_session,
    delete_session_preview_project,
    get_session_preview_project,
    get_session_attachment,
    get_session_generated_artifact,
    list_sessions,
    load_messages,
    save_session_preview_project,
    save_session_attachment,
    save_session_generated_artifact,
    save_message,
    session_exists,
)
from services.preview.workspace import BINARY_EXTENSIONS, PreviewProjectWorkspace, normalize_virtual_path
from tools.scene_spec import SceneSpec
from storage import GENERATED_ROOT, UPLOAD_ROOT, ensure_storage_dirs
from glb_validation import GlbValidationError, validate_glb_stream

router = APIRouter()


class CreateSessionRequest(BaseModel):
    userId: str = "default"
    sessionId: Optional[uuid.UUID] = None


class SaveMessageRequest(BaseModel):
    sessionId: str
    role: str
    content: str
    tokenUsage: Optional[dict] = None
    attachments: Optional[list] = None


class SavePreviewProjectRequest(BaseModel):
    project: dict
    origin: str = "generated"
    uploadName: Optional[str] = None
    expectedRevision: Optional[int] = None


class ReadPreviewProjectFilesRequest(BaseModel):
    projectId: str = Field(min_length=1, max_length=120)
    paths: list[str] = Field(min_length=1, max_length=100)
    expectedRevision: int = Field(ge=0)


MAX_UPLOAD_BYTES = 50 * 1024 * 1024
MAX_GENERATED_GLB_BYTES = 32 * 1024 * 1024


def _validate_uploaded_source_project(project: dict) -> dict:
    """Validate imported text source using the importer's 100-file / 5 MB limits.

    The AI editing workspace intentionally has tighter limits; persistence should not
    silently reject otherwise-supported uploads just because they exceed AI context limits.
    """
    if not isinstance(project, dict):
        raise ValueError("Preview Project 格式无效。")
    project_id = project.get("id")
    name = project.get("name")
    template = project.get("template")
    files = project.get("files")
    revision = project.get("revision", 0)
    if not isinstance(project_id, str) or not 1 <= len(project_id) <= 100:
        raise ValueError("Preview Project ID 无效。")
    if not isinstance(name, str) or not name.strip() or len(name) > 80:
        raise ValueError("项目名称无效。")
    if template not in {"react", "html"} or not isinstance(files, dict):
        raise ValueError("Preview Project 模板或文件集无效。")
    if type(revision) is not int or not 0 <= revision <= 9_007_199_254_740_990:
        raise ValueError("Preview Project revision 无效。")
    if not 1 <= len(files) <= 100:
        raise ValueError("源码项目文件数量无效，最多支持 100 个文本文件。")

    validated_files = {}
    total_bytes = 0
    for path, content in files.items():
        try:
            normalized_path = normalize_virtual_path(path)
        except (TypeError, ValueError) as exc:
            raise ValueError(f"源码文件路径无效：{exc}") from exc
        if normalized_path != path:
            raise ValueError("源码文件路径必须使用以 / 开头的规范格式。")
        extension = "." + path.rsplit(".", 1)[-1].lower() if "." in path.rsplit("/", 1)[-1] else ""
        if extension in BINARY_EXTENSIONS:
            raise ValueError("二进制产物请使用附件/产物上传，不要放入源码项目。")
        if not isinstance(content, str) or "\x00" in content:
            raise ValueError("源码文件内容必须是文本。")
        total_bytes += len(content.encode("utf-8"))
        if total_bytes > 5_000_000:
            raise ValueError("源码项目超过 5 MB 保存限制。")
        validated_files[path] = content
    if "/index.html" not in validated_files:
        raise ValueError("项目必须包含根目录 /index.html。")
    return {"id": project_id, "name": name.strip(), "template": template, "files": validated_files, "revision": revision}


@router.post("/session/create")
async def create_session_endpoint(body: CreateSessionRequest):
    """创建新会话"""
    try:
        session = await create_session(body.userId, str(body.sessionId) if body.sessionId else None)
        return {"success": True, "sessionId": session["id"], "session": session}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"创建会话失败: {str(e)}")


@router.post("/session/{session_id}/attachments")
async def upload_session_attachment(
    session_id: str,
    file: UploadFile = File(...),
    name: str = Form(...),
    kind: str = Form("file"),
):
    """Store an attachment in durable server storage, scoped to a chat session."""
    if kind not in {"file", "folder", "archive"}:
        raise HTTPException(status_code=422, detail="附件类型无效")
    safe_name = Path(name.replace("\\", "/")).name.strip()
    if not safe_name or len(safe_name) > 255:
        raise HTTPException(status_code=422, detail="附件名称无效")
    if not await session_exists(session_id):
        raise HTTPException(status_code=404, detail="会话不存在")

    attachment_id = str(uuid.uuid4())
    ensure_storage_dirs()
    attachment_dir = UPLOAD_ROOT / attachment_id
    attachment_dir.mkdir(parents=True, exist_ok=False)
    filepath = attachment_dir / safe_name
    size = 0
    try:
        with filepath.open("wb") as destination:
            while chunk := await file.read(1024 * 1024):
                size += len(chunk)
                if size > MAX_UPLOAD_BYTES:
                    raise HTTPException(status_code=413, detail="单个附件不能超过 50 MB")
                destination.write(chunk)
        relative_path = filepath.relative_to(UPLOAD_ROOT).as_posix()
        await save_session_attachment(
            attachment_id, session_id, safe_name, kind, relative_path,
            file.content_type or "application/octet-stream", size,
        )
    except Exception:
        filepath.unlink(missing_ok=True)
        try:
            attachment_dir.rmdir()
        except OSError:
            pass
        raise
    finally:
        await file.close()
    return {
        "success": True,
        "attachment": {
            "storageId": attachment_id,
            "name": safe_name,
            "kind": kind,
            "size": size,
            "downloadUrl": f"/api/chat/session/{session_id}/attachments/{attachment_id}",
        },
    }


@router.post("/session/{session_id}/generated-artifacts")
async def save_generated_glb(session_id: str, file: UploadFile = File(...)):
    """Persist a validated GLB and attach its metadata to the latest assistant message."""
    if not (file.filename or "").lower().endswith(".glb"):
        raise HTTPException(status_code=415, detail="目前只支持保存 GLB 文件。")
    if not await session_exists(session_id):
        raise HTTPException(status_code=404, detail="会话不存在")

    artifact_id = str(uuid.uuid4())
    raw_name = Path(file.filename.replace("\\", "/")).name
    safe_name = re.sub(r"[^\w.()\- ]", "_", raw_name, flags=re.UNICODE).strip(" .")[:180]
    if not safe_name or not safe_name.lower().endswith(".glb"):
        raise HTTPException(status_code=422, detail="GLB 文件名无效。")
    stored_name = f"{artifact_id}.glb"
    ensure_storage_dirs()
    destination = GENERATED_ROOT / stored_name
    size = 0
    try:
        with destination.open("xb") as output:
            while chunk := await file.read(1024 * 1024):
                size += len(chunk)
                if size > MAX_GENERATED_GLB_BYTES:
                    raise HTTPException(status_code=413, detail="GLB 文件不能超过 32 MB。")
                output.write(chunk)
        with destination.open("rb") as saved:
            validate_glb_stream(saved, size)
        reference = {
            "artifactId": artifact_id,
            "fileType": "3d",
            "displayName": safe_name,
            "downloadUrl": f"/api/chat/session/{session_id}/generated-artifacts/{artifact_id}",
        }
        await save_session_generated_artifact(
            artifact_id, session_id, safe_name, stored_name,
            "model/gltf-binary", size, reference,
        )
        return {"success": True, "file": reference, "size": size}
    except HTTPException:
        destination.unlink(missing_ok=True)
        raise
    except GlbValidationError as exc:
        destination.unlink(missing_ok=True)
        raise HTTPException(status_code=422, detail=str(exc))
    except ValueError as exc:
        destination.unlink(missing_ok=True)
        raise HTTPException(status_code=409, detail=str(exc))
    except Exception as exc:
        destination.unlink(missing_ok=True)
        raise HTTPException(status_code=500, detail=f"保存 GLB 失败：{exc}")
    finally:
        await file.close()


@router.get("/session/{session_id}/generated-artifacts/{artifact_id}")
async def download_generated_artifact(session_id: str, artifact_id: str):
    record = await get_session_generated_artifact(session_id, artifact_id)
    if not record:
        raise HTTPException(status_code=404, detail="生成产物不存在")
    relative_path = Path(record["relative_path"])
    if relative_path.is_absolute() or ".." in relative_path.parts:
        raise HTTPException(status_code=400, detail="产物路径无效")
    filepath = (GENERATED_ROOT / relative_path).resolve()
    if not filepath.is_relative_to(GENERATED_ROOT) or filepath.is_symlink() or not filepath.is_file():
        raise HTTPException(status_code=404, detail="生成文件不存在")
    return FileResponse(filepath, media_type=record["content_type"], filename=record["name"])


@router.get("/session/{session_id}/attachments/{attachment_id}")
async def download_session_attachment(session_id: str, attachment_id: str):
    """Download an attachment only through the session that owns it."""
    record = await get_session_attachment(session_id, attachment_id)
    if not record:
        raise HTTPException(status_code=404, detail="附件不存在")
    relative_path = Path(record["relative_path"])
    if relative_path.is_absolute() or ".." in relative_path.parts:
        raise HTTPException(status_code=400, detail="附件路径无效")
    filepath = (UPLOAD_ROOT / relative_path).resolve()
    if not filepath.is_relative_to(UPLOAD_ROOT) or filepath.is_symlink() or not filepath.is_file():
        raise HTTPException(status_code=404, detail="附件文件不存在")
    return FileResponse(
        filepath,
        media_type=record["content_type"],
        filename=record["name"],
        content_disposition_type="attachment",
    )


@router.delete("/session/{session_id}/attachments/{attachment_id}")
async def delete_pending_attachment(session_id: str, attachment_id: str):
    relative = await delete_pending_session_attachment(session_id, attachment_id)
    if relative == "":
        raise HTTPException(status_code=409, detail="已发送的附件不能移除")
    if relative is None:
        return {"success": True}
    target = (UPLOAD_ROOT / relative).resolve()
    if target.is_relative_to(UPLOAD_ROOT) and not target.is_symlink():
        target.unlink(missing_ok=True)
        try:
            target.parent.rmdir()
        except OSError:
            pass
    return {"success": True}


@router.get("/session/{session_id}/messages")
async def get_session_messages(session_id: str):
    """查询会话全部消息"""
    try:
        messages = await load_messages(session_id)
        return {"success": True, "messages": messages}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"查询消息失败: {str(e)}")


@router.get("/session/{session_id}/preview-project")
async def get_session_preview_project_endpoint(session_id: str):
    """读取会话当前的 Preview Project 源码快照。"""
    try:
        if not await session_exists(session_id):
            raise HTTPException(status_code=404, detail="会话不存在")
        snapshot = await get_session_preview_project(session_id)
        return {"success": True, "snapshot": snapshot}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"读取 Preview Project 失败: {str(e)}")


@router.post("/session/{session_id}/preview-project/files/read")
async def read_session_preview_project_files_endpoint(
    session_id: str,
    body: ReadPreviewProjectFilesRequest,
):
    """Batch-read authoritative changed source files for one exact content revision."""
    if not await session_exists(session_id):
        raise HTTPException(status_code=404, detail="会话不存在")
    snapshot = await get_session_preview_project(session_id)
    if not snapshot:
        raise HTTPException(status_code=404, detail="Preview Project 不存在")

    project = snapshot.get("project")
    if not isinstance(project, dict) or project.get("id") != body.projectId:
        raise HTTPException(status_code=409, detail="Preview Project ID 与当前会话项目不匹配。")
    current_revision = project.get("revision", 0)
    if type(current_revision) is not int or current_revision < 0:
        raise HTTPException(status_code=500, detail="服务器 Preview Project revision 无效。")
    if body.expectedRevision != current_revision:
        current_code = "PREVIEW_REVISION_ADVANCED" if body.expectedRevision < current_revision else "PREVIEW_REVISION_UNAVAILABLE"
        return JSONResponse(status_code=409, content={
            "success": False,
            "code": current_code,
            "requestedRevision": body.expectedRevision,
            "currentRevision": current_revision,
        })

    files = project.get("files")
    if not isinstance(files, dict):
        raise HTTPException(status_code=500, detail="服务器 Preview Project 文件集无效。")

    requested_paths = list(dict.fromkeys(body.paths))
    selected_files = []
    content_bytes = 0
    for requested_path in requested_paths:
        try:
            path = normalize_virtual_path(requested_path)
        except (TypeError, ValueError) as exc:
            raise HTTPException(status_code=422, detail=f"源码路径无效：{exc}") from exc
        if path != requested_path:
            raise HTTPException(status_code=422, detail="源码路径必须使用规范的绝对虚拟路径。")
        extension = "." + path.rsplit(".", 1)[-1].lower() if "." in path.rsplit("/", 1)[-1] else ""
        if extension in BINARY_EXTENSIONS:
            raise HTTPException(status_code=422, detail="二进制文件不能通过源码同步接口读取。")
        content = files.get(path)
        if not isinstance(content, str) or "\x00" in content:
            raise HTTPException(status_code=404, detail=f"源码文件不存在：{path}")
        content_bytes += len(content.encode("utf-8"))
        selected_files.append({"path": path, "content": content})

    result = {
        "success": True,
        "projectId": body.projectId,
        "revision": current_revision,
        "serverRevision": snapshot.get("revision", 0),
        "files": selected_files,
    }
    payload_bytes = len(json.dumps(result, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))
    print(
        f"[PreviewSync] session={session_id} project={body.projectId} revision={current_revision} "
        f"files={len(selected_files)} content_bytes={content_bytes} response_bytes={payload_bytes}"
    )
    return result


@router.put("/session/{session_id}/preview-project")
async def save_session_preview_project_endpoint(session_id: str, body: SavePreviewProjectRequest):
    """校验并保存会话 Preview Project；只接受浏览器虚拟文件系统内容。"""
    if body.origin not in {"generated", "uploaded-source"}:
        raise HTTPException(status_code=422, detail="Preview Project 来源无效")
    if body.uploadName is not None and (len(body.uploadName) > 255 or not body.uploadName.strip()):
        raise HTTPException(status_code=422, detail="上传名称无效")
    try:
        if body.origin == "uploaded-source":
            if not body.uploadName:
                raise ValueError("源码项目需要上传文件名。")
            validated_project = _validate_uploaded_source_project(body.project)
        else:
            workspace = PreviewProjectWorkspace.from_request(body.project)
            if workspace is None or "/index.html" not in workspace.files:
                raise ValueError("项目必须包含根目录 /index.html。")
            name = body.project.get("name", "Preview Project")
            if not isinstance(name, str) or not name.strip() or len(name) > 80:
                raise ValueError("项目名称无效。")
            validated_project = {
                "id": workspace.project_id,
                "name": name.strip(),
                "template": workspace.template,
                "files": workspace.files,
                "revision": workspace.revision,
            }
            if "/src/scene.json" in workspace.files:
                try:
                    scene_spec = SceneSpec.model_validate(json.loads(workspace.files["/src/scene.json"]))
                except (json.JSONDecodeError, ValueError) as exc:
                    raise ValueError(f"SceneSpec 无效：{exc}")
                validated_project["files"]["/src/scene.json"] = json.dumps(
                    scene_spec.model_dump(mode="json"), ensure_ascii=False, separators=(",", ":")
                )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))

    if not await session_exists(session_id):
        raise HTTPException(status_code=404, detail="会话不存在")

    try:
        result = await save_session_preview_project(
            session_id,
            validated_project,
            body.origin,
            body.uploadName.strip() if body.uploadName else None,
            body.expectedRevision,
        )
        return {"success": True, **result}
    except RuntimeError as e:
        if str(e) == "PREVIEW_PROJECT_REVISION_CONFLICT":
            raise HTTPException(status_code=409, detail="Preview 项目已被其他操作更新，请刷新后重试。")
        raise HTTPException(status_code=500, detail=f"保存 Preview Project 失败: {str(e)}")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"保存 Preview Project 失败: {str(e)}")


@router.delete("/session/{session_id}/preview-project")
async def delete_session_preview_project_endpoint(session_id: str):
    """清除指定会话的 Preview Project 快照。"""
    try:
        await delete_session_preview_project(session_id)
        return {"success": True}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"删除 Preview Project 失败: {str(e)}")


@router.get("/sessions")
async def get_sessions(userId: str = "default"):
    """查询用户会话列表"""
    try:
        sessions = await list_sessions(userId)
        return {"success": True, "sessions": sessions}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"查询会话列表失败: {str(e)}")


@router.post("/message/save")
async def save_message_endpoint(body: SaveMessageRequest):
    """保存单条消息"""
    try:
        await save_message(body.sessionId, body.role, body.content, body.tokenUsage, attachments=body.attachments)
        return {"success": True}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"保存消息失败: {str(e)}")


@router.delete("/session/{session_id}")
async def delete_session_endpoint(session_id: str):
    """删除会话及关联消息"""
    try:
        await delete_session(session_id)
        return {"success": True}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"删除会话失败: {str(e)}")
