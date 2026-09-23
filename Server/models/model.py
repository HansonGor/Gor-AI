"""
大模型初始化模块
职责：初始化 LangChain ChatOpenAI 实例，绑定工具
"""
from langchain_openai import ChatOpenAI
from langchain_core.tools import tool

from config import config
from tools.index import TOOLS, WORKSPACE_TOOLS


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


# 绑定工具的大模型实例
model_with_tools = get_llm().bind_tools(TOOLS)
model_with_workspace_tools = get_llm().bind_tools(WORKSPACE_TOOLS)
