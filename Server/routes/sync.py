"""多端同步接口：

- GET  /api/sync/events?userId=...  服务器推送流（SSE），按账号命名空间推送会话与回复事件；
- POST /api/chat/runs/{run_id}/cancel  停止一次正在服务端运行的回复（任一设备都可停止）。

用 SSE 而非 WebSocket：能原样穿过 Vite 代理、桌面端 app:// 转发与手机 WebView，凭证自动携带。
"""
import asyncio
import json

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse

from routes.auth import ensure_session_access
from routes.chat_routes import _session_namespace
from services.chat_runs import hub, registry

router = APIRouter()
HEARTBEAT_SECONDS = 15.0


def _sse(event: dict) -> str:
    # default=str：个别字段是 UUID/时间等非 JSON 类型时也能发出，不让一条事件断掉设备的同步连接
    return f"data: {json.dumps(event, ensure_ascii=False, default=str)}\n\n"


@router.get("/sync/events")
async def sync_events(request: Request, userId: str = "default"):
    namespace = await _session_namespace(request, userId)
    queue = hub.subscribe(namespace)

    async def stream():
        try:
            yield ": connected\n\n"
            yield _sse({"type": "hello", "namespace": namespace})
            # 先订阅再补齐正在进行的回复；客户端按 seq 去掉重复
            for run in registry.active_in(namespace):
                yield _sse(run.started_event())
                for seq, event in enumerate(list(run.events), start=1):
                    yield _sse({"type": "run_event", "runId": run.id, "sessionId": run.session_id, "seq": seq, "event": event})
            while True:
                if await request.is_disconnected():
                    return
                try:
                    event = await asyncio.wait_for(queue.get(), timeout=HEARTBEAT_SECONDS)
                except asyncio.TimeoutError:
                    yield ": ping\n\n"
                    continue
                yield _sse(event)
        finally:
            hub.unsubscribe(namespace, queue)

    return StreamingResponse(stream(), media_type="text/event-stream", headers={
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
    })


@router.post("/chat/runs/{run_id}/cancel")
async def cancel_run(run_id: str, request: Request):
    run = registry.get(run_id)
    if run is None:
        raise HTTPException(status_code=404, detail="这次回复已结束或不存在")
    # 与会话读写相同的归属校验：账号名下的会话只有本人能停止
    await ensure_session_access(request, run.session_id)
    if not run.done:
        run.request_cancel()
    return {"success": True, "status": run.status}
