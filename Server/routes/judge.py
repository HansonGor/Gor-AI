"""
代码执行沙箱路由
职责：代理 Judge0 沙箱 API，前端不直接暴露 Judge0 地址，
统一在后端做 base64 编码、参数补全和结果格式化。
"""
import base64
import httpx
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from config import config

router = APIRouter()

JUDGE0_URL = config.CodeSandbox.JUDGE0_URL


class ExecuteRequest(BaseModel):
    source_code: str
    language_id: int = 71  # 默认 Python 3.8.1
    stdin: str = ""


def _b64(s: str) -> str:
    return base64.b64encode(s.encode("utf-8")).decode("utf-8")


def _unb64(s: str | None) -> str:
    if not s:
        return ""
    return base64.b64decode(s).decode("utf-8", errors="replace")


@router.post("/judge/execute")
async def execute_code(req: ExecuteRequest):
    """提交代码到 Judge0 并返回执行结果（同步等待完成）"""
    payload = {
        "source_code": _b64(req.source_code),
        "stdin": _b64(req.stdin),
        "language_id": req.language_id,
        # WSL2 cgroups v2 兼容：禁用 cgroups，改用 rlimit
        "enable_per_process_and_thread_time_limit": True,
        "enable_per_process_and_thread_memory_limit": True,
    }

    try:
        async with httpx.AsyncClient(timeout=20.0) as client:
            # 1. 提交
            resp = await client.post(
                f"{JUDGE0_URL}/submissions?base64_encoded=true",
                json=payload,
            )
            data = resp.json()
            token = data.get("token")
            if not token:
                raise HTTPException(status_code=502, detail=f"Judge0 提交失败: {data}")

            # 2. 轮询结果（最多等 10 秒）
            for _ in range(20):
                import asyncio
                await asyncio.sleep(0.5)
                r = await client.get(
                    f"{JUDGE0_URL}/submissions/{token}?base64_encoded=true"
                )
                result = r.json()
                status_id = result.get("status", {}).get("id", 0)
                if status_id not in (1, 2):  # 1=In Queue, 2=Processing
                    break

            return {
                "status": result.get("status", {}).get("description", "Unknown"),
                "status_id": status_id,
                "stdout": _unb64(result.get("stdout")),
                "stderr": _unb64(result.get("stderr")),
                "time": result.get("time"),
                "memory": result.get("memory"),
                "message": _unb64(result.get("message")),
            }
    except httpx.ConnectError:
        raise HTTPException(status_code=503, detail="Judge0 沙箱未启动")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
