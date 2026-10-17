"""模型选择：注册表、会话偏好 API、请求冻结与按会话模型调用。"""

import asyncio
import importlib
import json
from unittest.mock import AsyncMock, patch

import httpx
import pytest
from fastapi import FastAPI
from langchain_core.messages import AIMessage, HumanMessage

import agent.agent as agent_module
from config import config
from models import model as model_module
from models import registry
from routes.project_changes import router

chat_module = importlib.import_module("routes.chat")
DEFAULT = config.Ark.MODEL_ID
EXTRA = [{"id": "ep-extra-pro", "name": "DeepSeek V4 Pro", "description": "更强推理"},
         {"id": "or-model", "name": "OpenRouter 模型", "provider": "openrouter"},
         {"id": "no-tools", "name": "无工具模型", "supportsTools": False},
         {"id": DEFAULT, "name": "重复的默认模型"},
         {"name": "缺少 id"}]


@pytest.fixture
def extra_models(monkeypatch):
    monkeypatch.setattr(config.Ark, "EXTRA_MODELS", json.dumps(EXTRA, ensure_ascii=False))


def test_registry_lists_default_first_and_marks_availability(extra_models):
    models = registry.list_models()
    assert [m.id for m in models] == [DEFAULT, "ep-extra-pro", "or-model", "no-tools"]
    public = {m.id: m.public(DEFAULT) for m in models}
    assert public[DEFAULT]["default"] is True and public[DEFAULT]["available"] is True
    assert public[DEFAULT]["name"] == registry.get_model_display_name(DEFAULT)
    assert public["ep-extra-pro"]["providerName"] == "方舟" and public["ep-extra-pro"]["available"] is True
    assert public["or-model"]["available"] is False      # 提供方尚未接入
    assert public["no-tools"]["available"] is False      # Gor 依赖工具调用
    assert registry.resolve_model_id("ep-extra-pro") == "ep-extra-pro"
    for bad in ("or-model", "no-tools", "unknown", None, ""):
        assert registry.resolve_model_id(bad) == DEFAULT


def test_invalid_extra_config_is_ignored(monkeypatch):
    monkeypatch.setattr(config.Ark, "EXTRA_MODELS", "{not json")
    assert [m.id for m in registry.list_models()] == [DEFAULT]
    monkeypatch.setattr(config.Ark, "EXTRA_MODELS", "")
    assert [m.id for m in registry.list_models()] == [DEFAULT]


def test_current_endpoint_has_a_readable_name():
    assert registry.get_model_display_name("ep-20260923135013-dx9tw") == "DeepSeek V4.1 Flash"


def test_model_factory_uses_selected_model_and_shares_default_cache():
    names = ("web_search",)
    assert model_module.get_model_for_tools(names) is model_module.get_model_for_tools(names, model_id=DEFAULT)
    other = model_module.get_model_for_tools(names, model_id="ep-extra-pro")
    payload = other.bound._get_request_payload([HumanMessage("hi")]) if hasattr(other, "bound") else \
        other._get_request_payload([HumanMessage("hi")])
    assert payload["model"] == "ep-extra-pro"
    assert payload["extra_body"] == {"thinking": {"type": "enabled"}}
    light = model_module.get_model_for_tools((), deep=False, model_id="ep-extra-pro")
    assert light._get_request_payload([HumanMessage("hi")])["extra_body"] == {"thinking": {"type": "disabled"}}


def test_agent_calls_selected_model(monkeypatch):
    calls = []

    class Model:
        async def ainvoke(self, messages, config=None):
            return AIMessage(content="好的。")

    def factory(names, **kwargs):
        calls.append(kwargs)
        return Model()

    monkeypatch.setattr(agent_module, "get_model_for_tools", factory)
    monkeypatch.setattr(agent_module, "TYPING_DELAY_MS", 0)
    asyncio.run(agent_module.run_agent([{"role": "user", "content": "你好"}], [].append,
                                       model_id="ep-extra-pro", deep_thinking=False))
    assert calls and all(kwargs == {"deep": False, "model_id": "ep-extra-pro"} for kwargs in calls)


def test_model_api_lists_without_secrets_and_validates_preferences(extra_models):
    async def exercise():
        saved = {}

        async def read(session_id):
            return saved.get(session_id)

        async def write(session_id, model_id):
            saved[session_id] = model_id

        app = FastAPI()
        app.include_router(router, prefix="/api/chat")
        transport = httpx.ASGITransport(app=app)
        with patch("routes.project_changes.get_model_preference", side_effect=read), \
             patch("routes.project_changes.set_model_preference", side_effect=write):
            async with httpx.AsyncClient(transport=transport, base_url="http://gor") as client:
                listing = await client.get("/api/chat/models")
                assert listing.headers["cache-control"] == "no-store"
                body = listing.json()
                assert body["defaultModelId"] == DEFAULT
                assert [m["id"] for m in body["models"]] == [DEFAULT, "ep-extra-pro", "or-model", "no-tools"]
                text = listing.text.lower()
                assert "api_key" not in text and "volces" not in text and "http" not in text
                path = "/api/chat/session/s1/model"
                assert (await client.get(path)).json() == {"modelId": DEFAULT}
                assert (await client.put(path, json={"modelId": "ep-extra-pro"})).status_code == 200
                assert (await client.get(path)).json() == {"modelId": "ep-extra-pro"}
                for bad in ("or-model", "no-tools", "unknown"):
                    assert (await client.put(path, json={"modelId": bad})).status_code == 422
                assert saved == {"s1": "ep-extra-pro"}
                saved["s2"] = "removed-model"     # 已下线模型读回默认
                assert (await client.get("/api/chat/session/s2/model")).json() == {"modelId": DEFAULT}

    asyncio.run(exercise())


class Request:
    async def is_disconnected(self):
        return False


async def run_route(body_model, stored):
    captured = {}

    async def fake_agent(messages, send_event, *args, **kwargs):
        captured.update(kwargs)
        send_event({"type": "token", "content": "回复"})

    with patch.object(chat_module, "save_message", new_callable=AsyncMock, return_value=1), \
         patch.object(chat_module, "load_messages", new_callable=AsyncMock, return_value=[]), \
         patch.object(chat_module, "get_session_preview_project", new_callable=AsyncMock, return_value=None), \
         patch.object(chat_module, "get_edit_mode", new_callable=AsyncMock, return_value="auto"), \
         patch.object(chat_module, "get_thinking_mode", new_callable=AsyncMock, return_value="deep"), \
         patch.object(chat_module, "get_model_preference", new_callable=AsyncMock, return_value=stored), \
         patch.object(chat_module.context_engine, "build_context", new_callable=AsyncMock,
                      return_value={"summary": "", "recent_messages": []}), \
         patch.object(chat_module, "save_thinking_trace", new_callable=AsyncMock), \
         patch.object(chat_module, "run_agent", fake_agent), \
         patch.object(chat_module, "deduct_model_quota", new_callable=AsyncMock), \
         patch.object(chat_module, "auto_generate_session_title", new_callable=AsyncMock):
        response = await chat_module.chat(Request(), chat_module.ChatRequest(
            sessionId="model-test", message="问题", clientMode="web",
            **({"modelId": body_model} if body_model else {})))
        [chunk async for chunk in response.body_iterator]
    return captured


@pytest.mark.parametrize("body_model, stored, expected", [
    ("ep-extra-pro", None, "ep-extra-pro"),   # 请求冻结的模型优先
    (None, "ep-extra-pro", "ep-extra-pro"),   # 旧客户端未传时读会话偏好
    (DEFAULT, "ep-extra-pro", None),          # 默认模型不额外传参
    ("unknown", None, None),                  # 未知模型回到默认
    ("or-model", None, None),                 # 未接入的提供方回到默认
])
def test_route_freezes_selected_model(extra_models, body_model, stored, expected):
    captured = asyncio.run(run_route(body_model, stored))
    assert captured.get("model_id") == expected
