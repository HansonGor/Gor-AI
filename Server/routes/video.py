"""
视频路由
职责：视频任务查询、视频代理（解决 403）
"""
import json
import os
from typing import Optional

import httpx
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse

router = APIRouter()

# 视频任务持久化文件
TASKS_FILE = os.path.join(os.path.dirname(os.path.dirname(__file__)), "data", "video_tasks.json")


def _load_tasks() -> dict:
    """加载视频任务记录"""
    if os.path.exists(TASKS_FILE):
        with open(TASKS_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    return {}


@router.get("/tasks")
async def get_all_tasks():
    """获取所有视频任务列表"""
    tasks = _load_tasks()
    return {"success": True, "tasks": list(tasks.values())}


@router.get("/task/{task_id}")
async def get_task(task_id: str):
    """获取单个视频任务"""
    tasks = _load_tasks()
    task = tasks.get(task_id)
    if not task:
        raise HTTPException(status_code=404, detail="任务不存在")
    return {"success": True, "task": task}


@router.get("/proxy")
async def video_proxy(url: str, request: Request):
    """
    视频代理（解决浏览器直接请求视频 URL 返回 403 的问题）
    通过后端转发视频流
    """
    if not url:
        raise HTTPException(status_code=400, detail="缺少 url 参数")

    try:
        async def stream_video():
            async with httpx.AsyncClient(timeout=60.0) as client:
                async with client.stream("GET", url) as response:
                    if response.status_code != 200:
                        raise HTTPException(status_code=response.status_code, detail="视频请求失败")

                    content_type = response.headers.get("content-type", "video/mp4")
                    content_length = response.headers.get("content-length")

                    async for chunk in response.aiter_bytes(chunk_size=8192):
                        yield chunk

        headers = {}
        # 尝试获取 content-type 和 content-length
        async with httpx.AsyncClient(timeout=10.0) as client:
            head_resp = await client.head(url)
            if head_resp.status_code == 200:
                headers["Content-Type"] = head_resp.headers.get("content-type", "video/mp4")
                if head_resp.headers.get("content-length"):
                    headers["Content-Length"] = head_resp.headers["content-length"]

        return StreamingResponse(
            stream_video(),
            media_type=headers.get("Content-Type", "video/mp4"),
            headers=headers,
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"视频代理失败: {str(e)}")
