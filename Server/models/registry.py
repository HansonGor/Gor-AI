"""可选聊天模型注册表：模型选择器的唯一数据来源。

默认模型始终是 ARK_MODEL_ID；额外模型来自 GOR_EXTRA_MODELS（JSON 数组）。
当前只支持方舟（provider=ark）；以后接入 OpenRouter 等提供方时在此登记，
并在 models/model.py 中按提供方构造客户端与思考开关参数。
"""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass

from config import config
from db.model_quota import get_model_display_name

SUPPORTED_PROVIDERS = {"ark"}


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
        data["providerName"] = {"ark": "方舟"}.get(self.provider, self.provider)
        data["default"] = self.id == default_id
        data["available"] = self.supports_tools and self.provider in SUPPORTED_PROVIDERS
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
    for spec in [default, *_extra_models(config.Ark.EXTRA_MODELS)]:
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
