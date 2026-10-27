"""遥斋接口（均需登录，只能看到和操作本账号的书斋）：

- GET  /api/remote/workspaces                      本账号的书斋：在线 / 离线、是否允许遥控；
- POST /api/remote/workspaces/{remote_id}/attach   网页选中某个书斋或心跳，桌面端据此显示「正在遥控」；返回尚未回答的审阅；
- POST /api/remote/workspaces/{remote_id}/detach   网页离开遥斋或换书斋；
- POST /api/remote/workspaces/{remote_id}/toolchain 网页对施行卡片的回答（审阅、删除确认、止令），转给桌面端。
"""
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from routes.auth import current_account
from services.remote_shuzhai import RemoteAccessError, page_message, remote_shuzhai

router = APIRouter()


class AttachRequest(BaseModel):
    deviceId: str = Field(max_length=80)
    label: str | None = Field(default=None, max_length=80)


class ToolchainMessageRequest(BaseModel):
    deviceId: str = Field(max_length=80)
    message: dict


async def _account_id(request: Request) -> str:
    account = await current_account(request)
    if not account:
        raise HTTPException(status_code=401, detail="遥斋需要先登录")
    return str(account["id"])


async def _authorize(request: Request, remote_id: str, device_id: str):
    account_id = await _account_id(request)
    try:
        return remote_shuzhai.authorize(remote_id, account_id, device_id)
    except RemoteAccessError as error:
        raise HTTPException(status_code=403, detail=str(error)) from error


@router.get("/workspaces")
async def list_workspaces(request: Request):
    return {"success": True, "workspaces": remote_shuzhai.list_for(await _account_id(request))}


@router.post("/workspaces/{remote_id}/attach")
async def attach(remote_id: str, body: AttachRequest, request: Request):
    entry = await _authorize(request, remote_id, body.deviceId)
    remote_shuzhai.touch(entry, body.deviceId, body.label)
    # 带上尚未回答的审阅：手机稍后打开、锁屏后重新载入也能补上卡片并回答
    return {"success": True, "workspace": entry.public(), "pendingApprovals": entry.pending_approvals()}


@router.post("/workspaces/{remote_id}/detach")
async def detach(remote_id: str, body: AttachRequest, request: Request):
    account_id = await _account_id(request)
    try:
        entry = remote_shuzhai.authorize(remote_id, account_id, body.deviceId)
    except RemoteAccessError:
        return {"success": True}
    remote_shuzhai.detach(entry, body.deviceId)
    return {"success": True}


@router.post("/workspaces/{remote_id}/toolchain")
async def toolchain_answer(remote_id: str, body: ToolchainMessageRequest, request: Request):
    entry = await _authorize(request, remote_id, body.deviceId)
    message = page_message(body.message)
    if message is None:
        raise HTTPException(status_code=400, detail="不支持的施行消息")
    remote_shuzhai.touch(entry, body.deviceId)
    try:
        await entry.websocket.send_json({"type": "remote_page_message", "message": message})
    except Exception as error:
        raise HTTPException(status_code=503, detail=f"{entry.device_name} 连接中断，请稍后重试") from error
    return {"success": True}
