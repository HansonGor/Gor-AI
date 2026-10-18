"""Gor Runner P0：在一次性沙箱容器中执行 git 只读命令。

启动：python -X utf8 -m uvicorn app:app --host 127.0.0.1 --port 4000
"""

from __future__ import annotations

import asyncio
import contextlib
import json
from collections import OrderedDict

from fastapi import FastAPI, File, Form, Request, UploadFile
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

import policy
import sandbox
import snapshot
from config import settings
from sweeper import sweep_forever

ALLOWED_LANGUAGES = {"git"}
RESULT_CACHE_LIMIT = 200


class ApiError(Exception):
    def __init__(self, status: int, code: str, message: str):
        super().__init__(message)
        self.status, self.code, self.message = status, code, message


@contextlib.asynccontextmanager
async def lifespan(_: FastAPI):
    task = asyncio.create_task(sweep_forever())
    try:
        yield
    finally:
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task


app = FastAPI(title="Gor Runner", version=settings.version, lifespan=lifespan)
# 本进程内已完成运行的摘要（不含快照内容）
_results: OrderedDict[str, dict] = OrderedDict()


def _error(status: int, code: str, message: str) -> JSONResponse:
    return JSONResponse(status_code=status, content={"error": {"code": code, "message": message}})


@app.exception_handler(ApiError)
async def _api_error(_: Request, exc: ApiError):
    return _error(exc.status, exc.code, exc.message)


@app.exception_handler(RequestValidationError)
async def _validation_error(_: Request, exc: RequestValidationError):
    fields = ", ".join(".".join(str(p) for p in e.get("loc", [])[1:]) or "请求" for e in exc.errors())
    return _error(400, "BAD_REQUEST", f"请求参数缺失或格式错误：{fields}")


@app.exception_handler(Exception)
async def _unexpected_error(_: Request, exc: Exception):
    # 不回显异常详情，避免泄露环境信息
    print(f"[Runner] 未预期错误：{type(exc).__name__}")
    return _error(500, "INTERNAL_ERROR", f"执行失败：{type(exc).__name__}")


@app.get("/health")
async def health():
    body = {"version": settings.version, "docker_reachable": False, "image_present": False, "image": settings.image}
    try:
        client = await asyncio.to_thread(sandbox.get_client)
        body["docker_reachable"] = True
        body["image_present"] = await asyncio.to_thread(sandbox.image_present, client)
    except sandbox.DockerUnavailable as exc:
        return JSONResponse(status_code=503, content={**body, "error": {"code": "DOCKER_UNAVAILABLE", "message": str(exc)}})
    return body


def _parse_argv(raw: str) -> list[str]:
    try:
        value = json.loads(raw)
    except json.JSONDecodeError:
        raise ApiError(400, "BAD_REQUEST", "argv 必须是 JSON 数组字符串，例如 [\"git\",\"status\"]") from None
    if not isinstance(value, list) or not all(isinstance(a, str) for a in value):
        raise ApiError(400, "BAD_REQUEST", "argv 必须是字符串数组")
    return value


def _parse_timeout(raw: str | None) -> int:
    if raw is None or raw == "":
        return settings.default_timeout
    try:
        value = int(raw)
    except ValueError:
        raise ApiError(400, "BAD_REQUEST", "timeout_seconds 必须是整数") from None
    if not settings.min_timeout <= value <= settings.max_timeout:
        raise ApiError(400, "BAD_REQUEST", f"timeout_seconds 必须在 {settings.min_timeout}–{settings.max_timeout} 之间")
    return value


@app.post("/v1/runs")
async def create_run(snapshot_file: UploadFile = File(..., alias="snapshot"), language: str = Form(...),
                     argv: str = Form(...), timeout_seconds: str | None = Form(None)):
    if language not in ALLOWED_LANGUAGES:
        raise ApiError(400, "BAD_REQUEST", f"不支持的 language：{language}（P0 仅支持 git）")
    parsed = _parse_argv(argv)
    timeout = _parse_timeout(timeout_seconds)
    try:
        final_argv = policy.validate(parsed)
    except policy.PolicyError as exc:
        raise ApiError(403, "COMMAND_NOT_ALLOWED", str(exc)) from None

    name = (snapshot_file.filename or "").lower()
    if not (name.endswith(".tar.gz") or name.endswith(".tgz")):
        raise ApiError(400, "SNAPSHOT_REJECTED", "快照文件必须是 .tar.gz")
    upload = snapshot_file.file
    upload.seek(0, 2)
    if upload.tell() > settings.snapshot_max_compressed:
        raise ApiError(413, "SNAPSHOT_TOO_LARGE",
                       f"快照压缩后超过 {settings.snapshot_max_compressed // (1024 * 1024)} MB 上限")
    upload.seek(0)

    try:
        filtered = await asyncio.to_thread(snapshot.filter_snapshot, upload)
    except snapshot.SnapshotTooLarge as exc:
        raise ApiError(413, "SNAPSHOT_TOO_LARGE", str(exc)) from None
    except snapshot.SnapshotRejected as exc:
        raise ApiError(400, "SNAPSHOT_REJECTED", str(exc)) from None

    try:
        result = await asyncio.to_thread(
            sandbox.run, filtered.tar_file, final_argv, timeout, lambda a: a, filtered.skipped)
    except sandbox.DockerUnavailable as exc:
        raise ApiError(503, "DOCKER_UNAVAILABLE", str(exc)) from None
    except sandbox.ImageMissing as exc:
        raise ApiError(503, "IMAGE_MISSING", str(exc)) from None
    finally:
        filtered.close()

    body = result.__dict__.copy()
    _results[result.run_id] = {k: body[k] for k in ("run_id", "exit_code", "timed_out", "duration_ms",
                                                    "stdout_truncated", "stderr_truncated")}
    while len(_results) > RESULT_CACHE_LIMIT:
        _results.popitem(last=False)
    return body


@app.get("/v1/runs/{run_id}")
async def get_run(run_id: str):
    summary = _results.get(run_id)
    if summary is None:
        raise ApiError(404, "NOT_FOUND", "本进程内没有该运行记录")
    return summary
