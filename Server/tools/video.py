"""
小云雀 AI 视频生成工具
职责：调用火山引擎小云雀 API 生成视频
"""
import asyncio
import hashlib
import hmac
import json
import os
from datetime import datetime
from typing import Optional

import httpx
from langchain_core.tools import tool

from config import config

# 小云雀 API 配置
API_HOST = "visual.volcengineapi.com"
API_REGION = "cn-north-1"
API_SERVICE = "cv"
API_VERSION = "2022-08-31"
REQ_KEY = "pippit_iv2v_cvtob"

# 视频任务持久化文件
TASKS_FILE = os.path.join(os.path.dirname(os.path.dirname(__file__)), "data", "video_tasks.json")


def _load_tasks() -> dict:
    """加载视频任务记录"""
    if os.path.exists(TASKS_FILE):
        with open(TASKS_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    return {}


def _save_tasks(tasks: dict):
    """保存视频任务记录"""
    os.makedirs(os.path.dirname(TASKS_FILE), exist_ok=True)
    with open(TASKS_FILE, "w", encoding="utf-8") as f:
        json.dump(tasks, f, ensure_ascii=False, indent=2)


def _sign_request(method: str, query: dict, body: str) -> dict:
    """
    火山引擎 API 签名（HMAC-SHA256）
    """
    ak = config.Xiaoyunque.ACCESS_KEY_ID
    sk = config.Xiaoyunque.SECRET_ACCESS_KEY

    # 1. 规范查询字符串
    canonical_query = "&".join(
        f"{k}={v}" for k, v in sorted(query.items())
    )

    # 2. 规范请求
    payload_hash = hashlib.sha256(body.encode("utf-8")).hexdigest()
    canonical_request = f"{method}\n/\n{canonical_query}\nhost:{API_HOST}\nx-content-sha256:{payload_hash}\nx-date:{datetime.utcnow().strftime('%Y%m%dT%H%M%SZ')}\n\nhost;x-content-sha256;x-date\n{payload_hash}"

    # 3. 计算签名
    date = datetime.utcnow().strftime("%Y%m%d")
    credential_scope = f"{date}/{API_REGION}/{API_SERVICE}/request"
    string_to_sign = f"HMAC-SHA256\n{datetime.utcnow().strftime('%Y%m%dT%H%M%SZ')}\n{credential_scope}\n{hashlib.sha256(canonical_request.encode('utf-8')).hexdigest()}"

    def _hmac(key: bytes, msg: str) -> bytes:
        return hmac.new(key, msg.encode("utf-8"), hashlib.sha256).digest()

    k_date = _hmac(sk.encode("utf-8"), date)
    k_region = _hmac(k_date, API_REGION)
    k_service = _hmac(k_region, API_SERVICE)
    k_signing = _hmac(k_service, "request")
    signature = hmac.new(k_signing, string_to_sign.encode("utf-8"), hashlib.sha256).hexdigest()

    # 4. 构建授权头
    authorization = f"HMAC-SHA256 Credential={ak}/{credential_scope}, SignedHeaders=host;x-content-sha256;x-date, Signature={signature}"

    return {
        "Authorization": authorization,
        "Host": API_HOST,
        "X-Content-Sha256": payload_hash,
        "X-Date": datetime.utcnow().strftime("%Y%m%dT%H%M%SZ"),
        "Content-Type": "application/json",
    }


async def _submit_video_task(prompt: str, duration: int = 10, img_url_list: list = None) -> dict:
    """提交视频生成任务"""
    body = json.dumps({
        "req_key": REQ_KEY,
        "prompt": prompt,
        "duration": duration,
        "img_url_list": img_url_list or [],
    }, ensure_ascii=False)

    query = {"Action": "SubmitVideoGenerationTask", "Version": API_VERSION}
    headers = _sign_request("POST", query, body)

    url = f"https://{API_HOST}/?Action={query['Action']}&Version={query['Version']}"

    async with httpx.AsyncClient(timeout=30.0) as client:
        response = await client.post(url, content=body.encode("utf-8"), headers=headers)
        return response.json()


async def _query_video_task(task_id: str) -> dict:
    """查询视频生成任务状态"""
    body = json.dumps({"task_id": task_id})
    query = {"Action": "GetVideoGenerationTask", "Version": API_VERSION}
    headers = _sign_request("POST", query, body)

    url = f"https://{API_HOST}/?Action={query['Action']}&Version={query['Version']}"

    async with httpx.AsyncClient(timeout=30.0) as client:
        response = await client.post(url, content=body.encode("utf-8"), headers=headers)
        return response.json()


@tool
async def generate_xiaoyunque_video(prompt: str, duration: int = 10, img_url_list: list = None) -> str:
    """
    小云雀 AI 视频生成工具，生成短视频、宣传片、剧情短片、MV、产品演示视频、动画短片等。

    Args:
        prompt: 视频完整创作指令，包含剧情、分镜、镜头运镜、画面风格、光影氛围
        duration: 期望视频时长，单位秒，默认10秒
        img_url_list: 可选参考图片公网URL数组

    Returns:
        JSON 字符串，包含 success、taskId、videoUrl、message
    """
    try:
        # 1. 提交任务
        result = await _submit_video_task(prompt, duration, img_url_list)
        task_id = result.get("data", {}).get("task_id")

        if not task_id:
            error_msg = result.get("ResponseMetadata", {}).get("Error", {}).get("Message", "未知错误")
            return json.dumps({
                "success": False,
                "error": f"提交任务失败: {error_msg}",
                "message": "视频生成失败，请稍后重试或调整描述后再次尝试。",
            }, ensure_ascii=False)

        # 2. 保存任务记录
        tasks = _load_tasks()
        tasks[task_id] = {
            "id": task_id,
            "status": "running",
            "prompt": prompt,
            "created_at": datetime.now().isoformat(),
        }
        _save_tasks(tasks)

        # 3. 轮询任务状态（最多 5 分钟）
        max_polls = 60
        poll_interval = 5

        for i in range(max_polls):
            await asyncio.sleep(poll_interval)

            task_result = await _query_video_task(task_id)
            status = task_result.get("data", {}).get("status", "running")
            video_url = task_result.get("data", {}).get("video_url")

            # 更新任务记录
            tasks = _load_tasks()
            if task_id in tasks:
                tasks[task_id]["status"] = status
                if video_url:
                    tasks[task_id]["video_url"] = video_url
                tasks[task_id]["updated_at"] = datetime.now().isoformat()
                _save_tasks(tasks)

            if status == "done" and video_url:
                return json.dumps({
                    "success": True,
                    "taskId": task_id,
                    "videoUrl": video_url,
                    "message": "视频生成成功！",
                }, ensure_ascii=False)

            if status == "failed":
                return json.dumps({
                    "success": False,
                    "taskId": task_id,
                    "error": "视频生成失败",
                    "message": "视频生成失败，请稍后重试或调整描述后再次尝试。",
                }, ensure_ascii=False)

        # 超时
        return json.dumps({
            "success": False,
            "taskId": task_id,
            "error": "视频生成超时",
            "message": "视频生成时间较长，任务仍在后台渲染中，请稍后通过任务ID查询结果。",
        }, ensure_ascii=False)

    except Exception as e:
        return json.dumps({
            "success": False,
            "error": f"视频生成异常: {str(e)}",
            "message": "视频生成失败，请稍后重试或调整描述后再次尝试。",
        }, ensure_ascii=False)
