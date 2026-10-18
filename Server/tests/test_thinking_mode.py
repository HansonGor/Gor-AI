"""思考方式：随思显式关闭模型深度思考；深思（默认）显式开启。偏好全局持久化，Web 与插件共用。"""

import asyncio
import importlib
from unittest.mock import AsyncMock, patch

import httpx
import pytest
from fastapi import FastAPI
from langchain_core.messages import AIMessage, HumanMessage

import agent.agent as agent_module
from models import model as model_module
from routes.project_changes import router

chat_module = importlib.import_module("routes.chat")


def payload(llm):
    return {k: v for k, v in llm._get_request_payload([HumanMessage("hi")]).items() if k != "messages"}


def test_light_model_disables_thinking_and_deep_is_default():
    light = payload(model_module.get_llm(deep=False))
    deep = payload(model_module.get_llm(deep=True))
    assert payload(model_module.get_llm()) == deep
    assert light["extra_body"] == {"thinking": {"type": "disabled"}}
    assert "reasoning_effort" not in light
    assert deep["reasoning_effort"] == "high"
    assert deep["extra_body"] == {"thinking": {"type": "enabled"}}
    # 其他参数保持一致
    assert light["temperature"] == deep["temperature"] == 0.1


def test_tool_bound_models_are_cached_separately_per_mode():
    names = ("web_search",)
    deep = model_module.get_model_for_tools(names)
    light = model_module.get_model_for_tools(names, deep=False)
    assert deep is model_module.get_model_for_tools(names, deep=True)
    assert light is model_module.get_model_for_tools(names, deep=False)
    assert light is not deep
    assert model_module.get_model_for_tools(()) is model_module.model_without_tools
    assert model_module.get_model_for_tools((), deep=False) is not model_module.model_without_tools
    assert payload(model_module.get_model_for_tools((), deep=False))["extra_body"] == {"thinking": {"type": "disabled"}}


@pytest.mark.parametrize("deep", [None, False, True])
def test_agent_selects_model_by_thinking_mode(monkeypatch, deep):
    calls = []

    class Model:
        async def ainvoke(self, messages, config=None):
            return AIMessage(content="好的。")

    def factory(names, **kwargs):
        calls.append(kwargs)
        return Model()

    monkeypatch.setattr(agent_module, "get_model_for_tools", factory)
    monkeypatch.setattr(agent_module, "TYPING_DELAY_MS", 0)
    events = []
    asyncio.run(agent_module.run_agent([{"role": "user", "content": "你好"}], events.append,
                                       **({} if deep is None else {"deep_thinking": deep})))
    # 默认与深思走原调用（默认 deep=True）；随思显式 deep=False
    assert calls and all(kwargs == ({"deep": False} if deep is False else {}) for kwargs in calls)


class Request:
    async def is_disconnected(self):
        return False


async def run_route(body_mode, stored, *, stored_error=None):
    captured = {}

    async def fake_agent(messages, send_event, *args, **kwargs):
        captured.update(kwargs)
        send_event({"type": "token", "content": "回复"})

    read = AsyncMock(side_effect=stored_error) if stored_error else AsyncMock(return_value=stored)
    with patch.object(chat_module, "save_message", new_callable=AsyncMock, return_value=1), \
         patch.object(chat_module, "load_messages", new_callable=AsyncMock, return_value=[]), \
         patch.object(chat_module, "get_session_preview_project", new_callable=AsyncMock, return_value=None), \
         patch.object(chat_module, "get_edit_mode", new_callable=AsyncMock, return_value="auto"), \
         patch.object(chat_module, "get_thinking_mode", read), \
         patch.object(chat_module, "get_model_preference", new_callable=AsyncMock, return_value=None), \
         patch.object(chat_module.context_engine, "build_context", new_callable=AsyncMock,
                      return_value={"summary": "", "recent_messages": []}), \
         patch.object(chat_module, "save_thinking_trace", new_callable=AsyncMock), \
         patch.object(chat_module, "run_agent", fake_agent), \
         patch.object(chat_module, "deduct_model_quota", new_callable=AsyncMock), \
         patch.object(chat_module, "auto_generate_session_title", new_callable=AsyncMock):
        response = await chat_module.chat(Request(), chat_module.ChatRequest(
            sessionId="thinking-test", message="问题", clientMode="web",
            **({"thinkingMode": body_mode} if body_mode else {})))
        [chunk async for chunk in response.body_iterator]
    return captured, read


@pytest.mark.parametrize("body_mode, stored, expected_deep, reads_store", [
    ("deep", "light", True, False),     # 请求冻结的模式优先
    ("light", "deep", False, False),
    (None, "deep", True, True),         # 旧客户端未传时读取会话偏好
    (None, "light", False, True),
])
def test_route_freezes_thinking_mode_and_passes_it_to_agent(body_mode, stored, expected_deep, reads_store):
    captured, read = asyncio.run(run_route(body_mode, stored))
    assert captured.get("deep_thinking", True) is expected_deep
    assert read.await_count == (1 if reads_store else 0)


@pytest.mark.parametrize("body_mode, stored, reads_store", [
    ("auto", "deep", False),    # 请求冻结的酌思优先
    (None, "auto", True),       # 未传时读取全局偏好
])
def test_route_passes_auto_thinking_for_zhuosi(body_mode, stored, reads_store):
    captured, read = asyncio.run(run_route(body_mode, stored))
    assert captured.get("auto_thinking") is True
    assert "deep_thinking" not in captured
    assert read.await_count == (1 if reads_store else 0)


def test_route_falls_back_to_auto_when_preference_cannot_be_read():
    captured, _ = asyncio.run(run_route(None, None, stored_error=RuntimeError("db down")))
    assert captured.get("auto_thinking") is True and "deep_thinking" not in captured


def test_preference_api_is_shared_by_hosts_and_never_cached():
    async def exercise():
        saved = {"value": "deep"}

        async def read(session_id):
            return saved["value"]

        async def write(session_id, mode):
            saved["value"] = mode

        app = FastAPI()
        app.include_router(router, prefix="/api/chat")
        transport = httpx.ASGITransport(app=app)
        with patch("routes.project_changes.get_thinking_mode", side_effect=read), \
             patch("routes.project_changes.set_thinking_mode", side_effect=write):
            async with httpx.AsyncClient(transport=transport, base_url="http://gor") as web, \
                       httpx.AsyncClient(transport=transport, base_url="http://gor") as plugin:
                path = "/api/chat/session/shared/thinking-mode"
                assert (await web.get(path)).json() == {"thinkingMode": "deep"}
                saved_response = await web.put(path, json={"thinkingMode": "light"})
                assert saved_response.status_code == 200 and saved_response.headers["cache-control"] == "no-store"
                read_back = await plugin.get(path)
                assert read_back.json() == {"thinkingMode": "light"} and read_back.headers["cache-control"] == "no-store"
                assert (await web.put(path, json={"thinkingMode": "max"})).status_code == 422
                assert (await web.get("/api/chat/session/other/thinking-mode")).json() == {"thinkingMode": "light"}
                assert (await web.put(path, json={"thinkingMode": "auto"})).status_code == 200
                assert (await plugin.get(path)).json() == {"thinkingMode": "auto"}

    asyncio.run(exercise())


def test_db_rejects_unknown_mode():
    from db.project_changes import set_thinking_mode
    with pytest.raises(ValueError):
        asyncio.run(set_thinking_mode("s", "max"))


class _MigrationConn:
    def __init__(self, definition):
        self.definition = definition
        self.executed = []

    async def fetchrow(self, query, *args):
        return {"conname": "chat_global_preferences_thinking_mode_check", "def": self.definition}

    async def execute(self, query, *args):
        self.executed.append(" ".join(query.split()))

    def transaction(self):
        class Tx:
            async def __aenter__(self):
                return self

            async def __aexit__(self, *exc):
                return False
        return Tx()


def test_migration_allows_auto_and_switches_default_once():
    from db.project_changes import ensure_auto_thinking_mode
    old = _MigrationConn("CHECK ((thinking_mode = ANY (ARRAY['light'::text, 'deep'::text])))")
    asyncio.run(ensure_auto_thinking_mode(old))
    joined = "\n".join(old.executed)
    assert 'DROP CONSTRAINT "chat_global_preferences_thinking_mode_check"' in joined
    assert "IN ('auto', 'light', 'deep')" in joined
    assert "SET DEFAULT 'auto'" in joined
    assert "SET thinking_mode = 'auto' WHERE id = 1" in joined

    migrated = _MigrationConn("CHECK ((thinking_mode = ANY (ARRAY['auto'::text, 'light'::text, 'deep'::text])))")
    asyncio.run(ensure_auto_thinking_mode(migrated))
    assert migrated.executed == []                    # 已迁移：不再覆盖用户之后的选择
