"""
大模型初始化模块
职责：初始化 LangChain ChatOpenAI 实例，绑定工具
"""
from functools import lru_cache

from langchain_openai import ChatOpenAI
from models.thinking import ThinkingChatOpenAI
from config import config
from tools.index import WORKSPACE_TOOLS
from tools.project_api_tools import batch_patch_project_files
from models.registry import get_spec


# 思考方式（方舟、千问及 OpenRouter 采用各自协议字段）：
# - 深思：显式开启深度思考并提高推理强度；也是默认方式。
# - 随思：显式关闭深度思考，不论接入哪个模型都不做深度推理。
# 在这里按提供方隔离思考开关参数。
DEEP_THINKING_KWARGS = {"reasoning_effort": "high", "extra_body": {"thinking": {"type": "enabled"}}}
LIGHT_THINKING_KWARGS = {"extra_body": {"thinking": {"type": "disabled"}}}


def get_llm(deep: bool = True, model_id: str | None = None):
    """低温度工具模型；流式仅供思考观察，ainvoke 仍返回完整工具决策。
    model_id 来自模型注册表；按提供方隔离地址、密钥和思考参数。"""
    selected_id = model_id or config.Ark.MODEL_ID
    spec = get_spec(selected_id)
    if spec.provider == "dashscope":
        if not config.Qwen.API_KEY.strip():
            raise ValueError("千问模型尚未配置密钥，暂不可用。")
        api_key, base_url = config.Qwen.API_KEY, config.Qwen.API_URL
        max_tokens = config.Qwen.MAX_OUTPUT_TOKENS
        thinking = {"extra_body": {"enable_thinking": bool(deep and spec.supports_thinking)}}
    elif spec.provider == "openrouter":
        if not config.OpenRouter.API_KEY.strip():
            raise ValueError("OpenRouter 模型尚未配置密钥，暂不可用。")
        api_key, base_url = config.OpenRouter.API_KEY, config.OpenRouter.API_URL
        max_tokens = config.OpenRouter.MAX_OUTPUT_TOKENS
        # LangChain treats the OpenAI Responses `reasoning` option as a signal
        # to switch APIs. OpenRouter's Responses endpoint is not supported for
        # most registered models (including Grok), while its Chat Completions
        # endpoint accepts OpenRouter's reasoning field as an extension body.
        # Pin the compatible route and keep this provider-specific field out of
        # the OpenAI SDK's strict Chat Completions keyword arguments.
        thinking = {
            "extra_body": {
                "reasoning": {"effort": "high" if deep and spec.supports_thinking else "none"}
            },
            "use_responses_api": False,
        }
    else:
        api_key, base_url = config.Ark.API_KEY, config.Ark.API_URL
        max_tokens = config.Ark.MAX_OUTPUT_TOKENS
        thinking = DEEP_THINKING_KWARGS if deep else LIGHT_THINKING_KWARGS
    return ThinkingChatOpenAI(
        model=selected_id,
        api_key=api_key,
        base_url=base_url,
        temperature=0.1,
        max_tokens=max_tokens,
        streaming=True,
        stream_usage=True,
        **thinking,
    )


def get_streaming_llm():
    """获取流式大模型实例（用于最终回答流式输出）"""
    return ChatOpenAI(
        model=config.Ark.MODEL_ID,
        api_key=config.Ark.API_KEY,
        base_url=config.Ark.API_URL,
        temperature=0.7,
        max_tokens=config.Ark.MAX_OUTPUT_TOKENS,
        streaming=True,
    )


# No-tool default plus cached, per-turn tool bindings. Default is 深思.
model_without_tools = get_llm()
# Literal Preview edits already have exact source snippets and a current revision
# from the programmatic preflight. Keep this model's tool surface intentionally
# narrow so it cannot start a redundant search/read or invoke unrelated tools.
model_with_simple_preview_edit = get_llm().bind_tools([batch_patch_project_files])


@lru_cache(maxsize=2)
def _light_model_without_tools():
    return get_llm(deep=False)


def get_model_for_tools(tool_names: tuple[str, ...], deep: bool = True, model_id: str | None = None):
    """Return a cached model bound only to the tools selected for this turn."""
    # 统一缓存键：省略参数与显式传默认值返回同一实例
    model_id = model_id or config.Ark.MODEL_ID
    return _model_for_tools(tuple(tool_names), bool(deep), model_id)


@lru_cache(maxsize=128)
def _model_for_tools(tool_names: tuple[str, ...], deep: bool, model_id: str):
    if model_id != config.Ark.MODEL_ID:
        plain = get_llm(deep=deep, model_id=model_id)
    else:
        plain = model_without_tools if deep else _light_model_without_tools()
    if not tool_names:
        return plain

    available = {item.name: item for item in WORKSPACE_TOOLS}
    selected = [available[name] for name in tool_names if name in available]
    if not selected:
        return plain
    return get_llm(deep=deep, model_id=model_id).bind_tools(selected)
