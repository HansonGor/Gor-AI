"""多端同步：按账号命名空间广播事件，以及在服务端独立运行的回复（ChatRun）。

- SyncHub：同一命名空间（会话的 user_id，如 user:<账号ID> 或未登录的 default）下所有在线设备的推送队列；
  当前后端是单进程，放在内存中即可，以后多实例时替换为 Redis / Postgres 通知，接口不变。
- ChatRun：一次回复在服务端的后台任务。发起端只是订阅者，断开不会取消；只有显式取消才停止。
  同一会话同一时间只允许一次回复在跑。记录事件以便中途打开的设备补齐。
"""
import asyncio
import time
import uuid
from dataclasses import dataclass, field
from typing import Any

QUEUE_LIMIT = 2000
FINISHED_RETENTION_SECONDS = 60


class SyncHub:
    def __init__(self) -> None:
        self._subscribers: dict[str, set[asyncio.Queue]] = {}

    def subscribe(self, namespace: str) -> asyncio.Queue:
        queue: asyncio.Queue = asyncio.Queue(maxsize=QUEUE_LIMIT)
        self._subscribers.setdefault(namespace, set()).add(queue)
        return queue

    def unsubscribe(self, namespace: str, queue: asyncio.Queue) -> None:
        subscribers = self._subscribers.get(namespace)
        if subscribers is None:
            return
        subscribers.discard(queue)
        if not subscribers:
            self._subscribers.pop(namespace, None)

    def subscriber_count(self, namespace: str) -> int:
        return len(self._subscribers.get(namespace, ()))

    def publish(self, namespace: str | None, event: dict[str, Any]) -> None:
        if not namespace:
            return
        for queue in list(self._subscribers.get(namespace, ())):
            try:
                queue.put_nowait(event)
            except asyncio.QueueFull:
                # 设备读得太慢：丢弃积压，让它整体重新拉取
                while not queue.empty():
                    queue.get_nowait()
                queue.put_nowait({"type": "resync"})


class RunConflictError(Exception):
    def __init__(self, run: "ChatRun") -> None:
        super().__init__("另一台设备正在回复")
        self.run = run


_END = object()


@dataclass
class ChatRun:
    session_id: str
    namespace: str | None
    assistant_message_id: str | None
    user_message: dict[str, Any]
    hub: SyncHub
    id: str = field(default_factory=lambda: str(uuid.uuid4()))
    status: str = "running"
    started_at: float = field(default_factory=time.time)
    finished_at: float | None = None
    cancel_event: asyncio.Event = field(default_factory=asyncio.Event)
    events: list[dict[str, Any]] = field(default_factory=list)
    _chunks: list[str] = field(default_factory=list)
    _listeners: set[asyncio.Queue] = field(default_factory=set)
    task: asyncio.Task | None = None

    @property
    def done(self) -> bool:
        return self.finished_at is not None

    def started_event(self) -> dict[str, Any]:
        return {"type": "run_started", "runId": self.id, "sessionId": self.session_id,
                "assistantMessageId": self.assistant_message_id, "userMessage": self.user_message,
                "startedAt": self.started_at}

    def record(self, event: dict[str, Any]) -> None:
        """记录一条回复事件并广播给同账号的其他设备（发起端走自己的流）。"""
        self.events.append(event)
        if event.get("type") == "done" and self.status == "running":
            self.status = event.get("status") or ("failed" if any(e.get("type") == "error" for e in self.events) else "completed")
        self.hub.publish(self.namespace, {"type": "run_event", "runId": self.id, "sessionId": self.session_id,
                                          "seq": len(self.events), "event": event})

    def push_chunk(self, chunk: str) -> None:
        self._chunks.append(chunk)
        for queue in list(self._listeners):
            queue.put_nowait(chunk)

    def attach(self) -> asyncio.Queue:
        """发起端订阅原始 SSE 片段：先补齐已产生的，再接收后续的。"""
        queue: asyncio.Queue = asyncio.Queue()
        for chunk in self._chunks:
            queue.put_nowait(chunk)
        if self.done:
            queue.put_nowait(_END)
        else:
            self._listeners.add(queue)
        return queue

    def detach(self, queue: asyncio.Queue) -> None:
        self._listeners.discard(queue)

    def request_cancel(self) -> None:
        self.cancel_event.set()


class RunRegistry:
    def __init__(self, hub: SyncHub) -> None:
        self.hub = hub
        self._runs: dict[str, ChatRun] = {}
        self._active_by_session: dict[str, str] = {}

    def active_for_session(self, session_id: str) -> ChatRun | None:
        run_id = self._active_by_session.get(session_id)
        run = self._runs.get(run_id) if run_id else None
        return run if run and not run.done else None

    def active_in(self, namespace: str) -> list[ChatRun]:
        return [run for run in self._runs.values() if run.namespace == namespace and not run.done]

    def get(self, run_id: str) -> ChatRun | None:
        return self._runs.get(run_id)

    def _prune(self) -> None:
        cutoff = time.time() - FINISHED_RETENTION_SECONDS
        for run_id in [rid for rid, run in self._runs.items() if run.finished_at and run.finished_at < cutoff]:
            self._runs.pop(run_id, None)

    def start(self, *, session_id: str, namespace: str | None, assistant_message_id: str | None,
              user_message: dict[str, Any], produce) -> ChatRun:
        """登记并在后台启动一次回复。produce(run) 返回产生 SSE 片段的异步生成器。"""
        existing = self.active_for_session(session_id)
        if existing:
            raise RunConflictError(existing)
        self._prune()
        run = ChatRun(session_id=session_id, namespace=namespace, assistant_message_id=assistant_message_id,
                      user_message=user_message, hub=self.hub)
        self._runs[run.id] = run
        self._active_by_session[session_id] = run.id
        self.hub.publish(namespace, run.started_event())

        async def pump() -> None:
            try:
                async for chunk in produce(run):
                    run.push_chunk(chunk)
            except Exception as error:  # 生成器内部已兜底；这里只防意外中断导致会话永远处于「正在回复」
                print(f"[ChatRun] {run.id} aborted: {type(error).__name__}: {error}")
                if run.status == "running":
                    run.status = "failed"
            finally:
                if run.status == "running":
                    run.status = "cancelled" if run.cancel_event.is_set() else "completed"
                run.finished_at = time.time()
                # 先解除会话占用再通知结束，避免同一会话紧接着的下一次发送被误判为冲突
                if self._active_by_session.get(session_id) == run.id:
                    self._active_by_session.pop(session_id, None)
                for queue in list(run._listeners):
                    queue.put_nowait(_END)
                run._listeners.clear()
                self.hub.publish(namespace, {"type": "run_finished", "runId": run.id, "sessionId": session_id,
                                             "status": run.status})
                self.hub.publish(namespace, {"type": "sessions_changed", "sessionId": session_id, "reason": "updated"})

        run.task = asyncio.create_task(pump())
        return run


async def stream_run(run: ChatRun, keepalive_seconds: float = 15.0):
    """发起端的 HTTP 流：断开只停止订阅，回复在服务端继续。"""
    queue = run.attach()
    try:
        while True:
            try:
                chunk = await asyncio.wait_for(queue.get(), timeout=keepalive_seconds)
            except asyncio.TimeoutError:
                yield ": keepalive\n\n"
                continue
            if chunk is _END:
                return
            yield chunk
    finally:
        run.detach(queue)


hub = SyncHub()
registry = RunRegistry(hub)
