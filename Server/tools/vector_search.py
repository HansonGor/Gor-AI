"""
RAG 向量检索工具
职责：调用阿里云百炼 Embedding 生成向量，从 Supabase pgvector 检索相似文档
"""
import json
from typing import List, Optional

import asyncpg
from langchain_core.tools import tool
from openai import OpenAI

from config import config
from db.supabase_chat import get_pool


def get_embedding(text: str) -> List[float]:
    """
    调用阿里云百炼 Embedding 接口，返回 1024 维向量
    """
    client = OpenAI(
        api_key=config.Embedding.API_KEY,
        base_url=config.Embedding.BASE_URL,
    )

    response = client.embeddings.create(
        input=text,
        model=config.Embedding.MODEL,
        dimensions=1024,
    )

    embedding = response.data[0].embedding
    if not embedding or len(embedding) != 1024:
        raise ValueError(f"Embedding 向量维度错误，期望 1024，实际 {len(embedding) if embedding else 0}")

    return embedding


async def insert_document_chunk(chunk_text: str, metadata: dict = None) -> None:
    """
    插入文档块到知识库向量表
    """
    embedding = get_embedding(chunk_text)
    pool = await get_pool()

    async with pool.acquire() as conn:
        await conn.execute(
            """INSERT INTO knowledge_vector (content, metadata, embedding)
               VALUES ($1, $2, $3::vector)""",
            chunk_text,
            json.dumps(metadata or {}, ensure_ascii=False),
            str(embedding),
        )


async def similarity_search(query: str, top_k: int = 3, threshold: float = 0.75) -> List[dict]:
    """
    相似度检索
    """
    query_embedding = get_embedding(query)
    pool = await get_pool()

    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """SELECT content, metadata, embedding <-> $1::vector as distance
               FROM knowledge_vector
               ORDER BY embedding <-> $1::vector
               LIMIT $2""",
            str(query_embedding),
            top_k,
        )

        results = []
        for row in rows:
            distance = row["distance"]
            if distance <= threshold:
                results.append({
                    "content": row["content"],
                    "metadata": json.loads(row["metadata"]) if row["metadata"] else {},
                    "distance": distance,
                })

        return results


@tool
async def vector_search(query: str) -> str:
    """
    查询私有知识库文档。用户询问上传文档、私有资料内容时调用；通用闲聊、新闻、天气、音乐不需要调用此工具。

    Args:
        query: 用户原始问题

    Returns:
        检索到的文档片段文本
    """
    try:
        results = await similarity_search(query)

        if not results:
            return "当前知识库没有相关资料。"

        formatted_results = []
        for i, result in enumerate(results, 1):
            formatted_results.append(f"【文档片段 {i}】\n{result['content']}")

        return "\n\n".join(formatted_results)

    except Exception as e:
        return f"知识库检索失败：{str(e)}"
