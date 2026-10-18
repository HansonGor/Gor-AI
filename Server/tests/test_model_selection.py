"""模型选择：注册表、会话偏好 API、请求冻结与按会话模型调用。"""

import asyncio
import importlib
import json
import runpy
from pathlib import Path
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
QWEN = registry.QWEN_MODEL_ID
EXTRA = [{"id": "ep-extra-pro", "name": "DeepSeek V4 Pro", "description": "更强推理"},
         {"id": "or-model", "name": "OpenRouter 模型", "provider": "openrouter"},
         {"id": "no-tools", "name": "无工具模型", "supportsTools": False},
         {"id": DEFAULT, "name": "重复的默认模型"},
         {"name": "缺少 id"}]


@pytest.fixture
def extra_models(monkeypatch):
    monkeypatch.setattr(config.Ark, "EXTRA_MODELS", json.dumps(EXTRA, ensure_ascii=False))
    monkeypatch.setattr(config.Qwen, "API_KEY", "")
    monkeypatch.setattr(config.OpenRouter, "API_KEY", "")


def test_registry_lists_default_first_and_marks_availability(extra_models):
    models = registry.list_models()
    expected_openrouter = [model_id for model_id, _ in registry.OPENROUTER_MODELS]
    assert [m.id for m in models] == [DEFAULT, "ep-extra-pro", "or-model", "no-tools", QWEN, *expected_openrouter]
    public = {m.id: m.public(DEFAULT) for m in models}
    assert public[DEFAULT]["default"] is True and public[DEFAULT]["available"] is True
    assert public[DEFAULT]["name"] == registry.get_model_display_name(DEFAULT)
    assert public["ep-extra-pro"]["providerName"] == "方舟" and public["ep-extra-pro"]["available"] is True
    assert public["or-model"]["available"] is False
    assert public["or-model"]["unavailable_reason"] == "未配置 OpenRouter 密钥，暂不可用"
    assert public["no-tools"]["available"] is False      # Gor 依赖工具调用
    assert registry.resolve_model_id("ep-extra-pro") == "ep-extra-pro"
    for bad in ("or-model", *expected_openrouter, "x-ai/grok-4.6", "no-tools", "unknown", None, ""):
        assert registry.resolve_model_id(bad) == DEFAULT


def test_invalid_extra_config_is_ignored(monkeypatch):
    monkeypatch.setattr(config.Ark, "EXTRA_MODELS", "{not json")
    assert [m.id for m in registry.list_models()] == [DEFAULT, QWEN, *[m for m, _ in registry.OPENROUTER_MODELS]]
    monkeypatch.setattr(config.Ark, "EXTRA_MODELS", "")
    assert [m.id for m in registry.list_models()] == [DEFAULT, QWEN, *[m for m, _ in registry.OPENROUTER_MODELS]]


def test_current_endpoint_has_a_readable_name():
    assert registry.get_model_display_name("ep-20260923135013-dx9tw") == "DeepSeek V4.1 Flash"


def test_qwen_default_endpoint_matches_the_selected_platform(monkeypatch):
    monkeypatch.delenv("QWEN_API_URL", raising=False)
    with patch("dotenv.load_dotenv"):
        settings = runpy.run_path(str(Path(__file__).parents[1] / "config.py"))["config"]
    assert settings.Qwen.API_URL == "https://maas.qianwenaiapi.com/compatible-mode/v1"


def test_openrouter_defaults_to_official_compatible_endpoint(monkeypatch):
    monkeypatch.delenv("OPENROUTER_API_URL", raising=False)
    with patch("dotenv.load_dotenv"):
        settings = runpy.run_path(str(Path(__file__).parents[1] / "config.py"))["config"]
    assert settings.OpenRouter.API_URL == "https://openrouter.ai/api/v1"


def test_openrouter_models_are_registered_and_require_their_own_key(monkeypatch):
    monkeypatch.setattr(config.OpenRouter, "API_KEY", "")
    model_ids = [model_id for model_id, _ in registry.OPENROUTER_MODELS]
    assert model_ids == [
        "openai/gpt-6.1-sol", "openai/gpt-6-luna", "openai/gpt-6-astra",
        "anthropic/claude-opus-5.5", "anthropic/claude-sonnet-5.5", "anthropic/claude-haiku-5.5",
        "google/gemini-4-argon", "x-ai/grok-4.7",
    ]
    for model_id in model_ids:
        public = registry.get_spec(model_id).public(DEFAULT)
        assert public["providerName"] == "OpenRouter"
        assert public["available"] is False
        assert public["unavailable_reason"] == "未配置 OpenRouter 密钥，暂不可用"
        assert registry.resolve_model_id(model_id) == DEFAULT
    monkeypatch.setattr(config.OpenRouter, "API_KEY", "test-openrouter-key")
    assert all(registry.get_spec(model_id).public(DEFAULT)["available"] for model_id in model_ids)
    assert "test-openrouter-key" not in json.dumps([registry.get_spec(model_id).public(DEFAULT) for model_id in model_ids])


@pytest.mark.parametrize("deep", [False, True])
def test_openrouter_uses_its_own_endpoint_key_reasoning_and_tools(monkeypatch, deep):
    model_id = "openai/gpt-6.1-sol"
    monkeypatch.setattr(config.OpenRouter, "API_KEY", "test-openrouter-key")
    monkeypatch.setattr(config.OpenRouter, "API_URL", "https://openrouter.invalid/api/v1")
    model_module._model_for_tools.cache_clear()
    try:
        bound = model_module.get_model_for_tools(("web_search",), deep=deep, model_id=model_id)
        model = bound.bound
        payload = model._get_request_payload([HumanMessage("hi")], **bound.kwargs)
        assert model.openai_api_key.get_secret_value() == "test-openrouter-key"
        assert model.openai_api_base == config.OpenRouter.API_URL
        assert payload["model"] == model_id
        assert payload["extra_body"]["reasoning"] == {"effort": "high" if deep else "none"}
        assert model.use_responses_api is False
        assert model._use_responses_api(payload) is False
        tool = payload["tools"][0]
        assert tool.get("name") == "web_search" or tool.get("function", {}).get("name") == "web_search"
    finally:
        model_module._model_for_tools.cache_clear()


def test_qwen_is_listed_but_disabled_until_its_own_key_is_configured(monkeypatch):
    monkeypatch.setattr(config.Qwen, "API_KEY", "")
    spec = registry.get_spec(QWEN)
    assert spec.id == "qwen3.8-flash"
    public = spec.public(DEFAULT)
    assert public["name"] == "千问 3.8 Flash"
    assert public["providerName"] == "阿里云百炼"
    assert public["available"] is False
    assert public["unavailable_reason"] == "未配置千问密钥，暂不可用"
    assert registry.resolve_model_id(QWEN) == DEFAULT
    with pytest.raises(ValueError, match="尚未配置密钥"):
        model_module.get_llm(model_id=QWEN)
    monkeypatch.setattr(config.Qwen, "API_KEY", "test-qwen-key")
    assert registry.resolve_model_id(QWEN) == QWEN
    assert registry.get_spec(QWEN).public(DEFAULT)["available"] is True
    assert "test-qwen-key" not in json.dumps(registry.get_spec(QWEN).public(DEFAULT))


@pytest.mark.parametrize("deep", [False, True])
def test_qwen_uses_its_own_endpoint_key_and_thinking_fields(monkeypatch, deep):
    monkeypatch.setattr(config.Qwen, "API_KEY", "test-qwen-key")
    monkeypatch.setattr(config.Qwen, "API_URL", "https://qwen.invalid/compatible-mode/v1")
    model_module._model_for_tools.cache_clear()
    try:
        bound = model_module.get_model_for_tools(("web_search",), deep=deep, model_id=QWEN)
        model = bound.bound
        payload = model._get_request_payload([HumanMessage("hi")], **bound.kwargs)
        assert model.openai_api_key.get_secret_value() == "test-qwen-key"
        assert model.openai_api_base == config.Qwen.API_URL
        assert payload["model"] == QWEN
        assert payload["extra_body"] == {"enable_thinking": deep}
        assert "reasoning_effort" not in payload
        assert payload["tools"][0]["function"]["name"] == "web_search"
    finally:
        model_module._model_for_tools.cache_clear()


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


def test_agent_converts_block_list_assistant_content_before_text_processing(monkeypatch):
    class Model:
        async def ainvoke(self, messages, config=None):
            return AIMessage(content=[{"type": "text", "text": "你"},
                                      {"type": "text", "text": "好"}])

    events = []
    monkeypatch.setattr(agent_module, "get_model_for_tools", lambda *_args, **_kwargs: Model())
    monkeypatch.setattr(agent_module, "TYPING_DELAY_MS", 0)
    asyncio.run(agent_module.run_agent([{"role": "user", "content": "你好"}], events.append))

    assert "".join(event.get("content", "") for event in events if event.get("type") == "token") == "你好"
    assert not any(event.get("type") == "error" for event in events)


def test_model_api_defaults_after_reload_and_does_not_persist_selection(extra_models):
    async def exercise():
        app = FastAPI()
        app.include_router(router, prefix="/api/chat")
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://gor") as client:
            listing = await client.get("/api/chat/models")
            assert listing.headers["cache-control"] == "no-store"
            body = listing.json()
            assert body["defaultModelId"] == DEFAULT
            assert [m["id"] for m in body["models"]] == [DEFAULT, "ep-extra-pro", "or-model", "no-tools", QWEN,
                                                            *[m for m, _ in registry.OPENROUTER_MODELS]]
            text = listing.text.lower()
            assert "api_key" not in text and "volces" not in text and "http" not in text
            path = "/api/chat/session/s1/model"
            assert (await client.get(path)).json() == {"modelId": DEFAULT}
            assert (await client.put(path, json={"modelId": DEFAULT})).status_code == 200
            assert (await client.get(path)).json() == {"modelId": DEFAULT}
            assert (await client.get("/api/chat/session/s2/model")).json() == {"modelId": DEFAULT}
            assert (await client.put(path, json={"modelId": "unknown"})).status_code == 422

    asyncio.run(exercise())


class Request:
    async def is_disconnected(self):
        return False


async def run_route(body_model, stored=None, mode="web"):
    captured = {}

    async def fake_agent(messages, send_event, *args, **kwargs):
        captured.update(kwargs)
        send_event({"type": "token", "content": "回复"})

    with patch.object(chat_module, "save_message", new_callable=AsyncMock, return_value=1), \
         patch.object(chat_module, "load_messages", new_callable=AsyncMock, return_value=[]), \
         patch.object(chat_module, "get_session_preview_project", new_callable=AsyncMock, return_value=None), \
         patch.object(chat_module, "get_edit_mode", new_callable=AsyncMock, return_value="auto"), \
         patch.object(chat_module, "get_thinking_mode", new_callable=AsyncMock, return_value="deep"), \
         patch.object(chat_module.context_engine, "build_context", new_callable=AsyncMock,
                      return_value={"summary": "", "recent_messages": []}), \
         patch.object(chat_module, "save_thinking_trace", new_callable=AsyncMock), \
         patch.object(chat_module, "run_agent", fake_agent), \
         patch.object(chat_module, "deduct_model_quota", new_callable=AsyncMock), \
         patch.object(chat_module, "auto_generate_session_title", new_callable=AsyncMock):
        response = await chat_module.chat(Request(), chat_module.ChatRequest(
            sessionId="model-test", message="问题", clientMode=mode,
            **({"modelId": body_model} if body_model else {})))
        [chunk async for chunk in response.body_iterator]
    return captured


@pytest.mark.parametrize("body_model, expected", [
    (DEFAULT, None),          # 当前会话选择的默认 DeepSeek
    (None, None),              # 页面重载后缺省仍为注册表默认 DeepSeek
])
def test_route_freezes_selected_model(extra_models, body_model, expected):
    captured = asyncio.run(run_route(body_model))
    assert captured.get("model_id") == expected


@pytest.mark.parametrize("mode", ["web", "vscode"])
def test_both_hosts_can_pass_qwen_after_credentials_are_configured(extra_models, monkeypatch, mode):
    monkeypatch.setattr(config.Qwen, "API_KEY", "test-qwen-key")
    captured = asyncio.run(run_route(QWEN, None, mode))
    assert captured.get("model_id") == QWEN


@pytest.mark.parametrize("mode", ["web", "vscode"])
def test_both_hosts_can_pass_openrouter_model_after_credentials_are_configured(extra_models, monkeypatch, mode):
    monkeypatch.setattr(config.OpenRouter, "API_KEY", "test-openrouter-key")
    model_id = "google/gemini-4-argon"
    captured = asyncio.run(run_route(model_id, None, mode))
    assert captured.get("model_id") == model_id
