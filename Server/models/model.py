"""
大模型初始化模块
职责：初始化 LangChain ChatOpenAI 实例，绑定工具
"""
from functools import lru_cache

from langchain_openai import ChatOpenAI
from config import config
from tools.index import WORKSPACE_TOOLS
from tools.preview_project import batch_patch_preview_files


def get_llm():
    """获取大模型实例（非流式，用于工具调用检测）——低温度确保稳定调工具"""
    return ChatOpenAI(
        model=config.Ark.MODEL_ID,
        api_key=config.Ark.API_KEY,
        base_url=config.Ark.API_URL,
        temperature=0.1,
        max_tokens=config.Ark.MAX_OUTPUT_TOKENS,
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


# No-tool default plus cached, per-turn tool bindings.
model_without_tools = get_llm()
# Literal Preview edits already have exact source snippets and a current revision
# from the programmatic preflight. Keep this model's tool surface intentionally
# narrow so it cannot start a redundant search/read or invoke unrelated tools.
model_with_simple_preview_edit = get_llm().bind_tools([batch_patch_preview_files])


@lru_cache(maxsize=32)
def get_model_for_tools(tool_names: tuple[str, ...]):
    """Return a cached model bound only to the tools selected for this turn."""
    if not tool_names:
        return model_without_tools

    available = {item.name: item for item in WORKSPACE_TOOLS}
    selected = [available[name] for name in tool_names if name in available]
    if not selected:
        return model_without_tools
    return get_llm().bind_tools(selected)
