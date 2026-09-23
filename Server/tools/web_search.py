"""
联网搜索工具
职责：调用 Tavily API 进行互联网搜索
"""
import json
from langchain_core.tools import tool

from config import config


@tool
def web_search(query: str) -> str:
    """
    互联网联网搜索，获取实时新闻、热点事件、最新资讯等信息。

    Args:
        query: 搜索关键词，例如"2024年科技热点"、"广州今日新闻"

    Returns:
        搜索结果文本，包含标题、摘要、来源链接
    """
    try:
        from tavily import TavilyClient

        client = TavilyClient(api_key=config.Tavily.API_KEY)
        response = client.search(
            query=query,
            search_depth="basic",
            max_results=5,
            include_answer=True,
        )

        results = []
        if response.get("answer"):
            results.append(f"【搜索摘要】{response['answer']}")

        for i, item in enumerate(response.get("results", []), 1):
            title = item.get("title", "")
            content = item.get("content", "")[:200]
            url = item.get("url", "")
            results.append(f"\n{i}. {title}\n   {content}\n   来源：{url}")

        return "\n".join(results) if results else "未找到相关搜索结果"
    except Exception as e:
        return f"搜索失败：{str(e)}"
