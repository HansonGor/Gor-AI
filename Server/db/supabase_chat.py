"""
supabase_chat.py - Supabase (PostgreSQL) 会话存储数据库操作层

本模块使用 asyncpg 异步连接池操作 PostgreSQL 数据库，管理三张表：
  - chat_sessions: 会话表
  - chat_messages: 消息表（含图片和 Token 消耗统计）
  - model_quota:   模型额度表

所有数据库操作均通过连接池管理，支持高并发场景。
"""
import asyncio
import json
import re
from datetime import datetime
from pathlib import Path
from typing import Optional
from urllib.parse import quote

import asyncpg

from config import config

# 全局数据库连接池变量（单例模式）
# 初始为 None，首次调用 get_pool() 时创建
_pool: Optional[asyncpg.Pool] = None
_LEGACY_HTML_PATH = re.compile(r"(?<![\w./-])(src/[A-Za-z0-9._/-]+\.html?)(?![\w./-])", re.IGNORECASE)


def _legacy_html_attachments(content: str) -> list[dict]:
    """Recover explicit legacy src/*.html references without scanning the workspace."""
    workspace = Path(config.ProjectWorkspace.ROOT).resolve()
    attachments = []
    seen = set()
    for match in _LEGACY_HTML_PATH.finditer(content or ""):
        relative = match.group(1)
        if relative in seen or ".." in Path(relative).parts:
            continue
        target = (workspace / relative).resolve()
        if not target.is_relative_to(workspace) or target.is_symlink() or not target.is_file():
            continue
        seen.add(relative)
        attachments.append({
            "fileType": "html",
            "displayName": Path(relative).name,
            "downloadUrl": "/" + "/".join(quote(part) for part in relative.split("/")),
        })
    return attachments


async def get_pool() -> asyncpg.Pool:
    """
    获取数据库连接池（单例模式）

    首次调用时创建连接池，后续复用已有连接池。
    连接池配置：
      - dsn:      从 config.Database.URL 读取数据库连接字符串
      - min_size: 1  最少保持 1 个连接
      - max_size: 10 最多同时保持 10 个连接

    Returns:
        asyncpg.Pool: 数据库连接池对象
    """
    global _pool
    if _pool is None:
        _pool = await asyncpg.create_pool(
            dsn=config.Database.URL,
            min_size=1,
            max_size=10,
        )
        print("[Database] 连接池已创建")
    return _pool


async def init_db():
    """
    初始化数据库表结构（幂等操作）

    在应用启动时调用，确保三张核心表存在。如果表已存在则不会重复创建。
    ALTER TABLE ... ADD COLUMN IF NOT EXISTS 用于兼容旧表结构，
    确保新字段（images、token 统计等）在已有表上也能正常添加。
    """
    pool = await get_pool()
    async with pool.acquire() as conn:
        # ----- 会话表 -----
        # id:         主键，UUID 字符串
        # user_id:    所属用户，默认为 'default'
        # title:      会话标题，默认为「新对话」
        # created_at: 创建时间（带时区时间戳）
        # updated_at: 最后更新时间（带时区时间戳）
        await conn.execute("""
            CREATE TABLE IF NOT EXISTS chat_sessions (
                id TEXT PRIMARY KEY,
                user_id TEXT DEFAULT 'default',
                title TEXT DEFAULT '新对话',
                created_at TIMESTAMPTZ DEFAULT NOW(),
                updated_at TIMESTAMPTZ DEFAULT NOW()
            );
        """)
        # ----- 消息表 -----
        # id:              自增主键
        # session_id:      所属会话（外键，级联删除）
        # role:            消息角色（user/assistant）
        # content:         消息文本内容
        # images:          图片 URL 列表（JSON 字符串格式）
        # created_at:      创建时间
        # prompt_tokens:   输入消耗的 Token 数
        # completion_tokens: 输出消耗的 Token 数
        # total_tokens:    总消耗 Token 数
        await conn.execute("""
            CREATE TABLE IF NOT EXISTS chat_messages (
                id SERIAL PRIMARY KEY,
                session_id TEXT REFERENCES chat_sessions(id) ON DELETE CASCADE,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                images TEXT,
                created_at TIMESTAMPTZ DEFAULT NOW(),
                prompt_tokens INT DEFAULT 0,
                completion_tokens INT DEFAULT 0,
                total_tokens INT DEFAULT 0
            );
        """)
        # ----- 模型额度表 -----
        # id:          自增主键
        # model_name:  模型名称（唯一）
        # remain_quota: 剩余额度
        # updated_at:  更新时间
        await conn.execute("""
            CREATE TABLE IF NOT EXISTS model_quota (
                id SERIAL PRIMARY KEY,
                model_name TEXT UNIQUE NOT NULL,
                remain_quota INT DEFAULT 0,
                updated_at TIMESTAMPTZ DEFAULT NOW()
            );
        """)
        # ----- 兼容旧表：确保新增字段存在 -----
        # 如果表是从旧版迁移而来，这些字段可能缺失，这里做补充
        await conn.execute("""
            ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS images TEXT;
        """)
        await conn.execute("""
            ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS prompt_tokens INT DEFAULT 0;
        """)
        await conn.execute("""
            ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS completion_tokens INT DEFAULT 0;
        """)
        await conn.execute("""
            ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS total_tokens INT DEFAULT 0;
        """)
        await conn.execute("""
            ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS attachments TEXT;
        """)
        print("[Database] 数据库表初始化完成")


async def create_session(user_id: str = "default") -> dict:
    """
    创建新会话

    生成唯一 UUID 作为会话 ID，插入 chat_sessions 表后，
    通过 SELECT 查询返回完整的会话信息。

    Args:
        user_id: 用户 ID，默认为 "default"

    Returns:
        dict: 包含 id, user_id, title, created_at, updated_at 的会话信息
    """
    import uuid
    session_id = str(uuid.uuid4())
    pool = await get_pool()
    async with pool.acquire() as conn:
        # 插入新会话记录
        await conn.execute(
            "INSERT INTO chat_sessions (id, user_id, title) VALUES ($1, $2, '新对话')",
            session_id, user_id,
        )
        # 查询刚插入的数据并返回
        row = await conn.fetchrow(
            "SELECT id, user_id, title, created_at, updated_at FROM chat_sessions WHERE id = $1",
            session_id,
        )
        return dict(row)


async def load_messages(session_id: str) -> list:
    """
    按会话 ID 查询全部消息，按创建时间升序排列

    返回的消息中包含 Token 消耗统计和图片信息。
    images 字段在数据库中存储为 JSON 字符串，返回时自动解析为 Python 列表。

    Args:
        session_id: 会话 ID

    Returns:
        list[dict]: 消息对象列表，包含 id, session_id, role, content,
                    images, created_at, prompt_tokens, completion_tokens, total_tokens
    """
    pool = await get_pool()
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """SELECT id, session_id, role, content, images, attachments, created_at,
                      prompt_tokens, completion_tokens, total_tokens
               FROM chat_messages WHERE session_id = $1 ORDER BY created_at ASC""",
            session_id,
        )
        # 将数据库中的 JSON 字符串解析为 Python 列表/对象
        return [
            {
                **dict(row),
                "images": json.loads(row["images"]) if row.get("images") else None,
                "attachments": (
                    json.loads(row["attachments"])
                    if row.get("attachments")
                    else (_legacy_html_attachments(row["content"]) or None)
                ),
            }
            for row in rows
        ]


async def save_message(
    session_id: str,
    role: str,
    content: str,
    token_usage: Optional[dict] = None,
    images: Optional[list] = None,
    attachments: Optional[list] = None,
) -> None:
    """
    保存单条消息，同时刷新会话的 updated_at 时间

    支持保存图片 URLs 和 Token 消耗统计。
    图片以 JSON 字符串形式存入数据库，方便后续扩展。

    Args:
        session_id: 所属会话 ID
        role: 消息角色 —— 'user'（用户）或 'assistant'（AI）
        content: 消息文本内容
        token_usage: Token 消耗数据（可选，仅 AI 回复需要）
            { prompt_tokens: int, completion_tokens: int, total_tokens: int }
        images: 图片 URL 列表（可选，仅用户消息可能携带）
    """
    pool = await get_pool()
    async with pool.acquire() as conn:
        if token_usage:
            # AI 回复：记录 Token 消耗
            await conn.execute(
                """INSERT INTO chat_messages (session_id, role, content, images, attachments, prompt_tokens, completion_tokens, total_tokens)
                   VALUES ($1, $2, $3, $4, $5, $6, $7, $8)""",
                session_id, role, content,
                json.dumps(images) if images else None,
                json.dumps(attachments, ensure_ascii=False) if attachments else None,
                token_usage.get("prompt_tokens", 0),
                token_usage.get("completion_tokens", 0),
                token_usage.get("total_tokens", 0),
            )
        else:
            # 用户消息或不带 Token 数据：仅插入基本字段
            await conn.execute(
                "INSERT INTO chat_messages (session_id, role, content, images, attachments) VALUES ($1, $2, $3, $4, $5)",
                session_id, role, content,
                json.dumps(images) if images else None,
                json.dumps(attachments, ensure_ascii=False) if attachments else None,
            )
        # 更新会话的最后活动时间
        await conn.execute(
            "UPDATE chat_sessions SET updated_at = NOW() WHERE id = $1",
            session_id,
        )


async def list_sessions(user_id: str = "default") -> list:
    """
    查询用户的会话列表，按更新时间倒序排列

    使用 LEFT JOIN 关联消息表，统计每条会话的消息数量。
    即使没有消息的会话也会被包含在结果中（message_count = 0）。

    Args:
        user_id: 用户 ID，默认为 "default"

    Returns:
        list[dict]: 会话列表，包含 id, user_id, title, created_at, updated_at, message_count
    """
    pool = await get_pool()
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """SELECT s.id, s.user_id, s.title, s.created_at, s.updated_at,
                      COUNT(m.id) as message_count
               FROM chat_sessions s
               LEFT JOIN chat_messages m ON m.session_id = s.id
               WHERE s.user_id = $1
               GROUP BY s.id
               ORDER BY s.updated_at DESC""",
            user_id,
        )
        return [dict(row) for row in rows]


async def delete_session(session_id: str) -> None:
    """
    删除会话及其关联的所有消息

    由于外键约束设置了 ON DELETE CASCADE，删除会话时
    数据库会自动删除 chat_messages 表中关联的所有消息。

    Args:
        session_id: 要删除的会话 ID
    """
    pool = await get_pool()
    async with pool.acquire() as conn:
        await conn.execute("DELETE FROM chat_sessions WHERE id = $1", session_id)


async def auto_generate_session_title(session_id: str) -> None:
    """
    自动生成会话标题

    触发条件（必须同时满足）：
      1. 会话标题仍为默认的「新对话」
      2. 该会话中同时存在至少一条 user 消息和一条 assistant 消息

    生成规则：
      - 提取第一条用户消息，取前 18 个字符作为标题
      - 如果超过 18 个字符，则截断并添加省略号「...」

    Args:
        session_id: 目标会话 ID
    """
    pool = await get_pool()
    async with pool.acquire() as conn:
        # 1. 检查会话标题是否为「新对话」
        session = await conn.fetchrow(
            "SELECT title FROM chat_sessions WHERE id = $1", session_id,
        )
        if not session or session["title"] != "新对话":
            return  # 会话不存在或标题已修改，跳过

        # 2. 检查是否同时存在 user 和 assistant 消息
        # 使用 PostgreSQL 的 FILTER 语法在同一次查询中统计两种角色
        counts = await conn.fetchrow(
            """SELECT
                   COUNT(*) FILTER (WHERE role = 'user') as user_count,
                   COUNT(*) FILTER (WHERE role = 'assistant') as assistant_count
               FROM chat_messages WHERE session_id = $1""",
            session_id,
        )
        if not counts or counts["user_count"] == 0 or counts["assistant_count"] == 0:
            return  # 缺少任一角色的消息，暂不生成标题

        # 3. 获取第一条用户消息
        first_user_msg = await conn.fetchrow(
            "SELECT content FROM chat_messages WHERE session_id = $1 AND role = 'user' ORDER BY created_at ASC LIMIT 1",
            session_id,
        )
        if not first_user_msg:
            return

        # 4. 截取前 18 个字符作为标题
        content = first_user_msg["content"]
        title = content[:18] + "..." if len(content) > 18 else content

        # 5. 更新数据库
        await conn.execute(
            "UPDATE chat_sessions SET title = $1 WHERE id = $2",
            title, session_id,
        )
        print(f"[Session] 自动生成标题: {title}")
