"""可选聊天模型注册表：模型选择器的唯一数据来源。

默认模型始终是 ARK_MODEL_ID；内置千问 3.8 Flash 与 OpenRouter 模型，额外模型来自 GOR_EXTRA_MODELS。
各提供方使用独立客户端配置及思考开关参数。
"""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass

from config import config
from db.model_quota import get_model_display_name

SUPPORTED_PROVIDERS = {"ark", "dashscope", "openrouter"}
QWEN_MODEL_ID = "qwen3.8-flash"
OPENROUTER_MODELS = (
    ("openai/gpt-6.1-sol", "GPT-6.1 Sol"),
    ("openai/gpt-6-luna", "GPT-6 Luna"),
    ("openai/gpt-6-astra", "GPT-6 Astra"),
    ("anthropic/claude-opus-5.5", "Claude Opus 5.5"),
    ("anthropic/claude-sonnet-5.5", "Claude Sonnet 5.5"),
    ("anthropic/claude-haiku-5.5", "Claude Haiku 5.5"),
    ("google/gemini-4-argon", "Gemini 4 Argon"),
    ("x-ai/grok-4.7", "Grok 4.7"),
)


@dataclass(frozen=True)
class ModelSpec:
    id: str                    # 稳定键：会话偏好、请求参数、日志都用它
    name: str                  # 选择器显示名
    provider: str = "ark"
    description: str = ""
    supports_tools: bool = True
    supports_thinking: bool = True   # 能否按随思/深思开关深度思考

    def public(self, default_id: str) -> dict:
        data = asdict(self)
        data["providerName"] = {"ark": "方舟", "dashscope": "阿里云百炼", "openrouter": "OpenRouter"}.get(self.provider, self.provider)
        data["default"] = self.id == default_id
        data["available"] = self.supports_tools and self.provider in SUPPORTED_PROVIDERS
        if self.provider == "dashscope" and not config.Qwen.API_KEY.strip():
            data["available"] = False
            data["unavailable_reason"] = "未配置千问密钥，暂不可用"
        if self.provider == "openrouter" and not config.OpenRouter.API_KEY.strip():
            data["available"] = False
            data["unavailable_reason"] = "未配置 OpenRouter 密钥，暂不可用"
        return data


def _extra_models(raw: str) -> list[ModelSpec]:
    if not raw.strip():
        return []
    try:
        items = json.loads(raw)
    except json.JSONDecodeError:
        print("[ModelRegistry] GOR_EXTRA_MODELS 不是有效 JSON，已忽略")
        return []
    specs = []
    for item in items if isinstance(items, list) else []:
        if not isinstance(item, dict) or not isinstance(item.get("id"), str) or not item["id"].strip():
            continue
        specs.append(ModelSpec(
            id=item["id"].strip(),
            name=str(item.get("name") or get_model_display_name(item["id"].strip())),
            provider=str(item.get("provider") or "ark"),
            description=str(item.get("description") or ""),
            supports_tools=bool(item.get("supportsTools", True)),
            supports_thinking=bool(item.get("supportsThinking", True)),
        ))
    return specs


def list_models() -> list[ModelSpec]:
    default = ModelSpec(id=config.Ark.MODEL_ID, name=get_model_display_name(config.Ark.MODEL_ID),
                        description="当前默认模型")
    seen, result = set(), []
    qwen = ModelSpec(id=QWEN_MODEL_ID, name="千问 3.8 Flash", provider="dashscope",
                     description="支持工具调用与随思/深思")
    openrouter_models = [ModelSpec(id=model_id, name=name, provider="openrouter",
                                   description="OpenRouter 聚合模型，支持工具调用与随思/深思")
                         for model_id, name in OPENROUTER_MODELS]
    for spec in [default, *_extra_models(config.Ark.EXTRA_MODELS), qwen, *openrouter_models]:
        if spec.id not in seen:
            seen.add(spec.id)
            result.append(spec)
    return result


def default_model_id() -> str:
    return config.Ark.MODEL_ID


def resolve_model_id(model_id: str | None) -> str:
    """把请求或偏好中的模型 ID 解析为可用模型；未知、已下线或不可用时回到默认模型。"""
    if model_id:
        for spec in list_models():
            if spec.id == model_id and spec.public(default_model_id())["available"]:
                return spec.id
    return default_model_id()


def get_spec(model_id: str) -> ModelSpec:
    return next((spec for spec in list_models() if spec.id == model_id), list_models()[0])
