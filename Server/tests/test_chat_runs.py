"""多端同步：回复在服务端独立运行、停止、并发限制、按账号广播与推送流（离线，不访问数据库与模型）。"""
import asyncio
import json
from unittest.mock import AsyncMock, patch

import pytest

from db import auth as auth_db
from routes import chat as chat_module
from routes import sync as sync_module
from services import chat_runs
from services.chat_runs import RunConflictError, RunRegistry, SyncHub, stream_run


def drain(queue):
    items = []
    while not queue.empty():
        items.append(queue.get_nowait())
    return items


def producer(events, gate=None, check_cancel=False):
    """模拟回复：逐条产生事件；gate 可让它停在中途。"""
    async def produce(run):
        yield ": connected\n\n"
        for index, event in enumerate(events):
            if gate is not None and index == 1:
                await gate.wait()
            if check_cancel and run.cancel_event.is_set():
                run.record({"type": "done", "status": "cancelled"})
                yield "data: cancelled\n\n"
                return
            run.record(event)
            yield f"data: {json.dumps(event)}\n\n"
    return produce


def test_disconnecting_the_originator_does_not_stop_the_reply():
    async def scenario():
        registry = RunRegistry(SyncHub())
        gate = asyncio.Event()
        run = registry.start(session_id="s1", namespace="user:a", assistant_message_id="m1",
                             user_message={"content": "hi"},
                             produce=producer([{"type": "token", "content": "a"}, {"type": "token", "content": "b"},
                                               {"type": "done", "status": "completed"}], gate=gate))
        stream = stream_run(run)
        first = await stream.__anext__()
        assert first == ": connected\n\n"
        await stream.aclose()           # 手机锁屏：发起端断开
        gate.set()
        await run.task
        return run, registry
    run, registry = asyncio.run(scenario())
    assert run.status == "completed"
    assert [event["content"] for event in run.events if event["type"] == "token"] == ["a", "b"]
    assert registry.active_for_session("s1") is None


def test_one_reply_per_session_and_the_session_frees_up_when_done():
    async def scenario():
        registry = RunRegistry(SyncHub())
        gate = asyncio.Event()
        run = registry.start(session_id="s1", namespace=None, assistant_message_id=None, user_message={},
                             produce=producer([{"type": "token"}, {"type": "done"}], gate=gate))
        with pytest.raises(RunConflictError) as conflict:
            registry.start(session_id="s1", namespace=None, assistant_message_id=None, user_message={},
                           produce=producer([]))
        assert conflict.value.run is run
        other = registry.start(session_id="s2", namespace=None, assistant_message_id=None, user_message={},
                               produce=producer([{"type": "done"}]))
        gate.set()
        await asyncio.gather(run.task, other.task)
        again = registry.start(session_id="s1", namespace=None, assistant_message_id=None, user_message={},
                               produce=producer([{"type": "done"}]))
        await again.task
        return again
    assert asyncio.run(scenario()).status == "completed"


def test_explicit_cancel_stops_the_reply():
    async def scenario():
        registry = RunRegistry(SyncHub())
        gate = asyncio.Event()
        run = registry.start(session_id="s1", namespace=None, assistant_message_id=None, user_message={},
                             produce=producer([{"type": "token"}, {"type": "token"}, {"type": "done"}],
                                              gate=gate, check_cancel=True))
        await asyncio.sleep(0)
        run.request_cancel()
        gate.set()
        await run.task
        return run
    run = asyncio.run(scenario())
    assert run.status == "cancelled"


def test_events_reach_only_the_same_account_in_order():
    async def scenario():
        hub = SyncHub()
        registry = RunRegistry(hub)
        mine, other = hub.subscribe("user:a"), hub.subscribe("user:b")
        run = registry.start(session_id="s1", namespace="user:a", assistant_message_id="m1",
                             user_message={"content": "你好"},
                             produce=producer([{"type": "token", "content": "x"}, {"type": "done", "status": "completed"}]))
        await run.task
        return drain(mine), drain(other), run
    mine, other, run = asyncio.run(scenario())
    assert other == [], "其他账号收不到"
    assert [event["type"] for event in mine] == ["run_started", "run_event", "run_event", "run_finished", "sessions_changed"]
    assert mine[0]["userMessage"] == {"content": "你好"} and mine[0]["assistantMessageId"] == "m1"
    assert [event["seq"] for event in mine if event["type"] == "run_event"] == [1, 2]
    assert mine[3] == {"type": "run_finished", "runId": run.id, "sessionId": "s1", "status": "completed"}


def test_slow_devices_are_told_to_resync_instead_of_growing_without_bound():
    async def scenario():
        hub = SyncHub()
        queue = hub.subscribe("user:a")
        for index in range(chat_runs.QUEUE_LIMIT + 5):
            hub.publish("user:a", {"type": "x", "i": index})
        hub.publish(None, {"type": "ignored"})
        return drain(queue)
    items = asyncio.run(scenario())
    assert {"type": "resync"} in items
    assert len(items) < chat_runs.QUEUE_LIMIT


def test_a_late_originator_stream_replays_what_already_happened():
    async def scenario():
        registry = RunRegistry(SyncHub())
        run = registry.start(session_id="s1", namespace=None, assistant_message_id=None, user_message={},
                             produce=producer([{"type": "token", "content": "a"}, {"type": "done"}]))
        await run.task
        return [chunk async for chunk in stream_run(run)]
    chunks = asyncio.run(scenario())
    assert chunks[0] == ": connected\n\n" and len(chunks) == 3


class FakeRequest:
    def __init__(self, disconnect_after=1):
        self.calls = 0
        self.disconnect_after = disconnect_after
        self.headers, self.cookies = {}, {}

    async def is_disconnected(self):
        self.calls += 1
        return self.calls > self.disconnect_after


def test_sync_stream_sends_hello_then_live_events_and_cleans_up():
    async def scenario():
        with patch.object(sync_module, "_session_namespace", new=AsyncMock(return_value="user:a")):
            response = await sync_module.sync_events(FakeRequest(disconnect_after=1), userId="default")
        sync_module.hub.publish("user:a", {"type": "sessions_changed", "sessionId": "s1", "reason": "created"})
        chunks = [chunk async for chunk in response.body_iterator]
        return chunks, sync_module.hub.subscriber_count("user:a")
    chunks, remaining = asyncio.run(scenario())
    data = [json.loads(chunk[6:]) for chunk in chunks if chunk.startswith("data: ")]
    assert data[0] == {"type": "hello", "namespace": "user:a"}
    assert data[1]["type"] == "sessions_changed"
    assert remaining == 0, "断开后取消订阅"


class BearerRequest:
    headers = {"authorization": "Bearer t"}
    cookies = {}


def test_session_events_with_uuid_ids_do_not_break_the_sync_stream():
    import uuid
    from routes import chat_routes

    async def scenario():
        session_id = uuid.uuid4()
        created = {"id": session_id, "user_id": "default", "title": "新对话"}
        with patch.object(sync_module, "_session_namespace", new=AsyncMock(return_value="default")):
            response = await sync_module.sync_events(FakeRequest(disconnect_after=2), userId="default")
        with patch.object(chat_routes, "create_session", new=AsyncMock(return_value=created)):
            await chat_routes.create_session_endpoint(chat_routes.CreateSessionRequest(userId="default"))
        sync_module.hub.publish("default", {"type": "preview_changed", "sessionId": uuid.uuid4(), "revision": 1})
        chunks = [chunk async for chunk in response.body_iterator]
        return session_id, [json.loads(chunk[6:]) for chunk in chunks if chunk.startswith("data: ")]
    session_id, events = asyncio.run(scenario())
    assert events[1] == {"type": "sessions_changed", "reason": "created", "sessionId": str(session_id)}
    assert events[2]["type"] == "preview_changed", "非字符串字段也能发出，连接不中断"


def test_cancel_endpoint_checks_ownership():
    async def scenario():
        gate = asyncio.Event()
        run = chat_runs.registry.start(session_id="11111111-1111-1111-1111-111111111111", namespace="user:acc-1",
                                       assistant_message_id=None, user_message={},
                                       produce=producer([{"type": "token"}, {"type": "token"}, {"type": "done"}],
                                                        gate=gate, check_cancel=True))
        with pytest.raises(sync_module.HTTPException) as missing:
            await sync_module.cancel_run("not-a-run", BearerRequest())
        assert missing.value.status_code == 404
        with patch.object(auth_db, "get_session_owner", new=AsyncMock(return_value="user:acc-1")):
            with patch.object(auth_db, "get_user_by_token", new=AsyncMock(return_value={"id": "acc-2"})):
                with pytest.raises(sync_module.HTTPException) as foreign:
                    await sync_module.cancel_run(run.id, BearerRequest())
            assert foreign.value.status_code == 404
            assert not run.cancel_event.is_set(), "别人的回复不能停"
            with patch.object(auth_db, "get_user_by_token", new=AsyncMock(return_value={"id": "acc-1"})):
                result = await sync_module.cancel_run(run.id, BearerRequest())
        assert result["success"] is True
        assert run.cancel_event.is_set()
        gate.set()
        await run.task
        return run
    assert asyncio.run(scenario()).status == "cancelled"


class ChatRequestStub:
    async def is_disconnected(self):
        return True     # 即使发起端立刻断开，回复也照常跑完


def test_chat_route_keeps_running_after_disconnect_rejects_concurrent_sends_and_broadcasts():
    async def scenario():
        release = asyncio.Event()

        async def fake_agent(messages, send_event, *args, **kwargs):
            send_event({"type": "token", "content": "第一段"})
            await release.wait()
            send_event({"type": "token", "content": "第二段"})

        listener = chat_runs.hub.subscribe("sync-test-namespace")
        with patch.object(chat_module, "save_message", new_callable=AsyncMock, return_value=1) as save_message, \
             patch.object(chat_module, "load_messages", new_callable=AsyncMock, return_value=[]), \
             patch.object(chat_module, "get_session_preview_project", new_callable=AsyncMock, return_value=None), \
             patch.object(chat_module, "get_edit_mode", new_callable=AsyncMock, return_value="auto"), \
             patch.object(chat_module, "get_thinking_mode", new_callable=AsyncMock, return_value="light"), \
             patch.object(chat_module.context_engine, "build_context", new_callable=AsyncMock,
                          return_value={"summary": "", "recent_messages": []}), \
             patch.object(chat_module, "save_thinking_trace", new_callable=AsyncMock), \
             patch.object(chat_module, "run_agent", fake_agent), \
             patch.object(chat_module, "deduct_model_quota", new_callable=AsyncMock, return_value=None), \
             patch.object(chat_module, "auto_generate_session_title", new_callable=AsyncMock), \
             patch.object(auth_db, "get_session_owner", new=AsyncMock(return_value="sync-test-namespace")):
            body = chat_module.ChatRequest(sessionId="sync-session", message="问题", clientMode="web", assistantMessageId="a1")
            response = await chat_module.chat(ChatRequestStub(), body)
            first_chunks = []
            async for chunk in response.body_iterator:
                first_chunks.append(chunk)
                if "第一段" in chunk:
                    break
            await response.body_iterator.aclose()   # 发起端断开
            conflict = await chat_module.chat(ChatRequestStub(), body)
            run = chat_runs.registry.active_for_session("sync-session")
            release.set()
            await run.task
            saved_roles = [call.args[1] for call in save_message.await_args_list]
        broadcast = drain(listener)
        chat_runs.hub.unsubscribe("sync-test-namespace", listener)
        return first_chunks, conflict, run, saved_roles, broadcast

    first_chunks, conflict, run, saved_roles, broadcast = asyncio.run(scenario())
    assert any('"type": "run"' in chunk and run.id in chunk for chunk in first_chunks), "发起端先拿到 runId"
    assert conflict.status_code == 409
    assert json.loads(conflict.body)["runId"] == run.id
    assert run.status == "completed"
    assert "assistant" in saved_roles, "断开后仍保存了回复"
    tokens = [event["event"]["content"] for event in broadcast if event["type"] == "run_event" and event["event"]["type"] == "token"]
    assert tokens == ["第一段", "第二段"], "其他设备收到完整的逐字内容"
    assert broadcast[0]["type"] == "run_started" and broadcast[0]["userMessage"]["content"] == "问题"
    assert {"type": "run_finished", "runId": run.id, "sessionId": "sync-session", "status": "completed"} in broadcast
