"""
会话管理路由
职责：会话创建、消息查询、会话列表、消息保存、会话删除
"""
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import Optional

from db.supabase_chat import (
    create_session,
    delete_session,
    list_sessions,
    load_messages,
    save_message,
)

router = APIRouter()


class CreateSessionRequest(BaseModel):
    userId: str = "default"


class SaveMessageRequest(BaseModel):
    sessionId: str
    role: str
    content: str
    tokenUsage: Optional[dict] = None
    attachments: Optional[list] = None


@router.post("/session/create")
async def create_session_endpoint(body: CreateSessionRequest):
    """创建新会话"""
    try:
        session = await create_session(body.userId)
        return {"success": True, "sessionId": session["id"], "session": session}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"创建会话失败: {str(e)}")


@router.get("/session/{session_id}/messages")
async def get_session_messages(session_id: str):
    """查询会话全部消息"""
    try:
        messages = await load_messages(session_id)
        return {"success": True, "messages": messages}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"查询消息失败: {str(e)}")


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
