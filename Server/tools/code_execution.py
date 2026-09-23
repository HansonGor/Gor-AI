"""Judge0 隔离沙箱的 Agent 工具。"""
import base64

import httpx
from langchain_core.tools import tool

from config import config


def _encode(value: str) -> str:
    return base64.b64encode(value.encode("utf-8")).decode("utf-8")


def _decode(value: str | None) -> str:
    if not value:
        return ""
    return base64.b64decode(value).decode("utf-8", errors="replace")


@tool
async def execute_python(code: str, stdin: str = "") -> str:
    """在隔离的 Judge0 沙箱中执行 Python 代码并返回运行结果。

    仅在用户明确要求运行、验证或调试 Python 代码时调用。不要用它访问
    用户文件、网络凭证或绕过安全限制；代码会在无持久化的隔离环境中运行。
    """
    if not code.strip():
        return "执行失败：代码不能为空。"
    if len(code) > 30_000:
        return "执行失败：单次代码不能超过 30,000 个字符。"
    if len(stdin) > 8_000:
        return "执行失败：标准输入不能超过 8,000 个字符。"

    payload = {
        "source_code": _encode(code),
        "stdin": _encode(stdin),
        "language_id": 71,  # Python 3.8.1
        "enable_per_process_and_thread_time_limit": True,
        "enable_per_process_and_thread_memory_limit": True,
    }

    try:
        async with httpx.AsyncClient(timeout=20.0) as client:
            submitted = await client.post(
                f"{config.CodeSandbox.JUDGE0_URL}/submissions?base64_encoded=true",
                json=payload,
            )
            submitted.raise_for_status()
            token = submitted.json().get("token")
            if not token:
                return "执行失败：Judge0 未返回任务标识。"

            result: dict = {}
            for _ in range(20):
                import asyncio

                await asyncio.sleep(0.5)
                response = await client.get(
                    f"{config.CodeSandbox.JUDGE0_URL}/submissions/{token}?base64_encoded=true"
                )
                response.raise_for_status()
                result = response.json()
                status_id = result.get("status", {}).get("id", 0)
                if status_id not in (1, 2):
                    break

        status = result.get("status", {}).get("description", "Unknown")
        stdout = _decode(result.get("stdout"))
        stderr = _decode(result.get("stderr"))
        message = _decode(result.get("message"))
        details = [f"执行状态：{status}"]
        if stdout:
            details.append(f"标准输出：\n{stdout}")
        if stderr:
            details.append(f"标准错误：\n{stderr}")
        if message:
            details.append(f"运行信息：\n{message}")
        if result.get("time"):
            details.append(f"耗时：{result['time']} 秒")
        return "\n\n".join(details)
    except httpx.ConnectError:
        return "执行服务暂不可用：Judge0 沙箱尚未启动。"
    except httpx.HTTPStatusError as exc:
        return f"执行服务返回异常：HTTP {exc.response.status_code}。"
    except Exception as exc:
        return f"执行失败：{exc}"
