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
      - min_size: 4  启动时预先建好 4 个连接：远端数据库新建连接约 0.5～1 秒，
                     聊天接口会并行读写，只留 1 个时首个请求要临时建连接、慢约 3 秒
      - max_size: 10 最多同时保持 10 个连接

    Returns:
        asyncpg.Pool: 数据库连接池对象
    """
    global _pool
    if _pool is None:
        _pool = await asyncpg.create_pool(
            dsn=config.Database.URL,
            min_size=4,
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
        from db.project_changes import DDL, SEED_GLOBAL_PREFERENCES, ensure_auto_thinking_mode
        from db.auth import DDL as AUTH_DDL
        await conn.execute(AUTH_DDL)
        await conn.execute(DDL)
        await ensure_auto_thinking_mode(conn)
        await conn.execute(SEED_GLOBAL_PREFERENCES)
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
        await conn.execute("""
            CREATE TABLE IF NOT EXISTS conversation_context (
                session_id TEXT PRIMARY KEY,
                summary TEXT NOT NULL DEFAULT '',
                compressed_until_message_id BIGINT,
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
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
        # One validated Virtual FS snapshot per chat session. Keep the session key as
        # TEXT without a foreign key so this table works with both legacy TEXT and
        # deployed UUID chat_sessions schemas; delete_session removes snapshots explicitly.
        await conn.execute("""
            CREATE TABLE IF NOT EXISTS session_preview_projects (
                session_id TEXT PRIMARY KEY,
                project JSONB NOT NULL,
                origin TEXT NOT NULL DEFAULT 'generated',
                upload_name TEXT,
                revision BIGINT NOT NULL DEFAULT 1,
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                CONSTRAINT session_preview_projects_origin_check
                    CHECK (origin IN ('generated', 'uploaded-source'))
            );
        """)
        await conn.execute("""
            CREATE TABLE IF NOT EXISTS session_attachments (
                id TEXT PRIMARY KEY,
                -- Keep this TEXT without an FK so existing deployments with UUID
                -- chat_sessions columns remain compatible, like preview projects.
                session_id TEXT NOT NULL,
                name TEXT NOT NULL,
                kind TEXT NOT NULL DEFAULT 'file',
                relative_path TEXT NOT NULL,
                content_type TEXT NOT NULL DEFAULT 'application/octet-stream',
                size BIGINT NOT NULL DEFAULT 0,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                CONSTRAINT session_attachments_kind_check CHECK (kind IN ('file', 'folder', 'archive'))
            );
        """)
        await conn.execute("""
            CREATE TABLE IF NOT EXISTS session_generated_artifacts (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                name TEXT NOT NULL,
                relative_path TEXT,
                artifact_bytes BYTEA,
                content_type TEXT NOT NULL,
                size BIGINT NOT NULL DEFAULT 0,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            );
        """)
        # Web project exports are virtual database artifacts. Keep old disk-backed
        # records readable, but new artifacts do not create server filesystem files.
        await conn.execute("ALTER TABLE session_generated_artifacts ADD COLUMN IF NOT EXISTS artifact_bytes BYTEA")
        await conn.execute("ALTER TABLE session_generated_artifacts ALTER COLUMN relative_path DROP NOT NULL")
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
        await conn.execute("""
            ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS preview_changes JSONB;
        """)
        await conn.execute("""
            ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS project_changes JSONB;
            ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS thinking_trace JSONB;
        """)
        await conn.execute("""
            ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS preview_snapshot JSONB;
        """)
        await conn.execute("""
            ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS client_message_id TEXT;
        """)
        await conn.execute("""
            ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS search_sources JSONB;
        """)
        await conn.execute("""
            ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS search_trace JSONB;
        """)
        await conn.execute("""
            CREATE UNIQUE INDEX IF NOT EXISTS chat_messages_session_client_id_idx
            ON chat_messages (session_id, client_message_id) WHERE client_message_id IS NOT NULL;
        """)
        print("[Database] 数据库表初始化完成")


async def session_exists(session_id: str) -> bool:
    pool = await get_pool()
    async with pool.acquire() as conn:
        return bool(await conn.fetchval("SELECT EXISTS(SELECT 1 FROM chat_sessions WHERE id = $1)", session_id))


async def get_session_preview_project(session_id: str) -> dict | None:
    pool = await get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """SELECT project, origin, upload_name, revision, updated_at
               FROM session_preview_projects WHERE session_id = $1""",
            session_id,
        )
    if not row:
        return None
    project = row["project"]
    if isinstance(project, str):
        project = json.loads(project)
    return {
        "project": project,
        "origin": row["origin"],
        "uploadName": row["upload_name"],
        "revision": row["revision"],
        "updatedAt": row["updated_at"].isoformat(),
    }


async def save_session_preview_project(
    session_id: str,
    project: dict,
    origin: str = "generated",
    upload_name: str | None = None,
    expected_revision: int | None = None,
) -> dict:
    serialized_project = json.dumps(project, ensure_ascii=False, separators=(",", ":"))
    pool = await get_pool()
    async with pool.acquire() as conn:
        if expected_revision is None:
            row = await conn.fetchrow(
                """INSERT INTO session_preview_projects (session_id, project, origin, upload_name)
                   VALUES ($1, $2::jsonb, $3, $4)
                   ON CONFLICT (session_id) DO UPDATE SET
                       project = EXCLUDED.project,
                       origin = EXCLUDED.origin,
                       upload_name = EXCLUDED.upload_name,
                       revision = session_preview_projects.revision + 1,
                       updated_at = NOW()
                   RETURNING revision, updated_at""",
                session_id,
                serialized_project,
                origin,
                upload_name,
            )
        else:
            row = await conn.fetchrow(
                """UPDATE session_preview_projects
                   SET project = $3::jsonb, origin = $4, upload_name = $5,
                       revision = revision + 1, updated_at = NOW()
                   WHERE session_id = $1 AND revision = $2
                   RETURNING revision, updated_at""",
                session_id,
                expected_revision,
                serialized_project,
                origin,
                upload_name,
            )
            if not row:
                raise RuntimeError("PREVIEW_PROJECT_REVISION_CONFLICT")
        await conn.execute("UPDATE chat_sessions SET updated_at = NOW() WHERE id = $1", session_id)
    return {"revision": row["revision"], "updatedAt": row["updated_at"].isoformat()}


async def create_session_preview_project(
    session_id: str,
    project: dict,
    origin: str = "generated",
    upload_name: str | None = None,
) -> dict | None:
    """Create the canonical session project only when one does not exist yet."""
    serialized_project = json.dumps(project, ensure_ascii=False, separators=(",", ":"))
    pool = await get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """INSERT INTO session_preview_projects (session_id, project, origin, upload_name)
               VALUES ($1, $2::jsonb, $3, $4)
               ON CONFLICT (session_id) DO NOTHING
               RETURNING revision, updated_at""",
            session_id,
            serialized_project,
            origin,
            upload_name,
        )
        if row:
            await conn.execute("UPDATE chat_sessions SET updated_at = NOW() WHERE id = $1", session_id)
    if not row:
        return None
    return {"revision": row["revision"], "updatedAt": row["updated_at"].isoformat()}


async def update_session_preview_project_if_revision(
    session_id: str,
    project: dict,
    expected_revision: int,
    change_record: dict | None = None,
) -> dict | None:
    """Commit by CAS; archive the previous project's source when creating a new ID."""
    serialized_project = json.dumps(project, ensure_ascii=False, separators=(",", ":"))
    pool = await get_pool()
    async with pool.acquire() as conn:
        async with conn.transaction():
            previous_row = await conn.fetchrow(
                "SELECT project FROM session_preview_projects WHERE session_id = $1 AND revision = $2 FOR UPDATE",
                session_id, expected_revision,
            )
            if not previous_row:
                return None
            previous = previous_row["project"]
            if isinstance(previous, str):
                previous = json.loads(previous)
            new_identity = previous.get("id") != project.get("id")
            row = await conn.fetchrow(
                """UPDATE session_preview_projects
                   SET project = $3::jsonb, revision = revision + 1, updated_at = NOW(),
                       origin = CASE WHEN $4 THEN 'generated' ELSE origin END,
                       upload_name = CASE WHEN $4 THEN NULL ELSE upload_name END
                   WHERE session_id = $1 AND revision = $2
                   RETURNING revision, updated_at""",
                session_id, expected_revision, serialized_project, new_identity,
            )
            if row and new_identity and previous.get("files"):
                message = await conn.fetchrow(
                    """SELECT id, client_message_id FROM chat_messages
                       WHERE session_id = $1 AND role = 'assistant' AND preview_changes @> $2::jsonb
                       ORDER BY id DESC LIMIT 1 FOR UPDATE""",
                    session_id, json.dumps([{"projectId": previous.get("id")}]),
                )
                if message:
                    snapshot = {**previous, "projectId": previous["id"],
                                "messageId": message["client_message_id"] or str(message["id"]),
                                "outputExtension": ".glb" if previous.get("template") == "html" and "/src/scene.json" in previous["files"] else ".html"}
                    await conn.execute("UPDATE chat_messages SET preview_snapshot = $1::jsonb WHERE id = $2", json.dumps(snapshot, ensure_ascii=False), message["id"])
            if row:
                if change_record:
                    await conn.execute("""INSERT INTO project_change_sets(id,session_id,record)
                        VALUES($1,$2,$3::jsonb) ON CONFLICT(id) DO UPDATE SET record=EXCLUDED.record,updated_at=NOW()""",
                        change_record["id"], change_record["sessionId"], json.dumps(change_record, ensure_ascii=False))
                await conn.execute("UPDATE chat_sessions SET updated_at = NOW() WHERE id = $1", session_id)
    if not row:
        return None
    return {"revision": row["revision"], "updatedAt": row["updated_at"].isoformat()}


async def delete_session_preview_project(session_id: str) -> None:
    pool = await get_pool()
    async with pool.acquire() as conn:
        await conn.execute("DELETE FROM session_preview_projects WHERE session_id = $1", session_id)


async def save_session_attachment(attachment_id: str, session_id: str, name: str, kind: str,
                                  relative_path: str, content_type: str, size: int) -> None:
    pool = await get_pool()
    async with pool.acquire() as conn:
        await conn.execute(
            """INSERT INTO session_attachments (id, session_id, name, kind, relative_path, content_type, size)
               VALUES ($1, $2, $3, $4, $5, $6, $7)""",
            attachment_id, session_id, name, kind, relative_path, content_type, size,
        )
        await conn.execute("UPDATE chat_sessions SET updated_at = NOW() WHERE id = $1", session_id)


async def get_session_attachment(session_id: str, attachment_id: str) -> dict | None:
    pool = await get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT id, name, kind, relative_path, content_type, size FROM session_attachments WHERE session_id = $1 AND id = $2",
            session_id, attachment_id,
        )
    return dict(row) if row else None


async def save_session_generated_artifact(
    artifact_id: str, session_id: str, name: str, relative_path: str | None,
    content_type: str, size: int, file_reference: dict, *, message_id: str | None = None,
    artifact_bytes: bytes | None = None,
) -> None:
    pool = await get_pool()
    async with pool.acquire() as conn:
        async with conn.transaction():
            if not await conn.fetchval("SELECT EXISTS(SELECT 1 FROM chat_sessions WHERE id = $1)", session_id):
                raise ValueError("会话不存在")
            if message_id:
                assistant = await conn.fetchrow(
                    "SELECT id, attachments FROM chat_messages WHERE session_id = $1 AND role = 'assistant' AND client_message_id = $2 FOR UPDATE",
                    session_id, message_id,
                )
            else:
                assistant = await conn.fetchrow(
                    "SELECT id, attachments FROM chat_messages WHERE session_id = $1 AND role = 'assistant' ORDER BY id DESC LIMIT 1 FOR UPDATE",
                    session_id,
                )
            if not assistant:
                raise ValueError("找不到可关联产物的助手消息，请先完成一次模型生成。")
            await conn.execute(
                """INSERT INTO session_generated_artifacts (id, session_id, name, relative_path, content_type, size, artifact_bytes)
                   VALUES ($1, $2, $3, $4, $5, $6, $7)""",
                artifact_id, session_id, name, relative_path, content_type, size, artifact_bytes,
            )
            try:
                existing = json.loads(assistant["attachments"]) if assistant["attachments"] else []
            except (TypeError, json.JSONDecodeError):
                existing = []
            if not isinstance(existing, list):
                existing = []
            existing = [item for item in existing if isinstance(item, dict)]
            existing = [item for item in existing if item.get("artifactId") != artifact_id]
            existing.append(file_reference)
            await conn.execute(
                "UPDATE chat_messages SET attachments = $1 WHERE id = $2",
                json.dumps(existing, ensure_ascii=False), assistant["id"],
            )
            await conn.execute("UPDATE chat_sessions SET updated_at = NOW() WHERE id = $1", session_id)


async def get_session_generated_artifact(session_id: str, artifact_id: str) -> dict | None:
    pool = await get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT id, name, relative_path, content_type, size, artifact_bytes FROM session_generated_artifacts WHERE session_id = $1 AND id = $2",
            session_id, artifact_id,
        )
    return dict(row) if row else None


async def delete_pending_session_attachment(session_id: str, attachment_id: str) -> str | None:
    """Delete only an attachment that has not been committed to a chat message."""
    pool = await get_pool()
    async with pool.acquire() as conn:
        async with conn.transaction():
            row = await conn.fetchrow(
                "SELECT relative_path FROM session_attachments WHERE session_id = $1 AND id = $2 FOR UPDATE",
                session_id, attachment_id,
            )
            if not row:
                return None
            referenced = await conn.fetchval(
                """SELECT EXISTS(
                       SELECT 1 FROM chat_messages
                       WHERE session_id = $1 AND attachments LIKE $2
                   )""",
                session_id, f"%{attachment_id}%",
            )
            if referenced:
                return ""
            await conn.execute("DELETE FROM session_attachments WHERE session_id = $1 AND id = $2", session_id, attachment_id)
            return row["relative_path"]


async def create_session(user_id: str = "default", session_id: str | None = None) -> dict:
    """
    创建新会话

    使用客户端提供的 UUID（如有）或生成新 UUID 作为会话 ID，插入 chat_sessions 表后，
    通过 SELECT 查询返回完整的会话信息。

    Args:
        user_id: 用户 ID，默认为 "default"

    Returns:
        dict: 包含 id, user_id, title, created_at, updated_at 的会话信息
    """
    import uuid
    # Allow clients to provision an optimistic session ID so the UI can switch
    # immediately, while preserving server-generated IDs for existing callers.
    session_id = str(uuid.UUID(session_id)) if session_id else str(uuid.uuid4())
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
            """SELECT id, client_message_id, session_id, role, content, images, attachments, preview_changes,
                      COALESCE(preview_snapshot, (SELECT cs.record->'previewPublishedSnapshot'
                        FROM project_change_sets cs
                        WHERE cs.session_id = chat_messages.session_id::text
                          AND cs.record->>'messageId' = chat_messages.client_message_id
                          AND cs.record->>'sealed' = 'true'
                          AND cs.record ? 'previewPublishedSnapshot'
                        LIMIT 1)) AS preview_snapshot, project_changes,
                      search_sources, search_trace, thinking_trace, created_at,
                      (SELECT jsonb_agg(jsonb_build_object(
                          'id', cs.id, 'sessionId', cs.session_id,
                          'provider', cs.record->'projectRef'->>'provider'))
                       FROM project_change_sets cs
                       WHERE cs.session_id = chat_messages.session_id::text
                         AND cs.record->>'messageId' = chat_messages.client_message_id
                         AND cs.record->>'sealed' = 'true'
                         AND jsonb_array_length(cs.record->'files') > 0) AS project_change_sets,
                      prompt_tokens, completion_tokens, total_tokens
               FROM chat_messages WHERE session_id = $1 ORDER BY created_at ASC, id ASC""",
            session_id,
        )
        # 将数据库中的 JSON 字符串解析为 Python 列表/对象
        return [
            {
                **dict(row),
                "db_message_id": row["id"],
                "id": row.get("client_message_id") or str(row["id"]),
                "images": json.loads(row["images"]) if row.get("images") else None,
                "attachments": (
                    json.loads(row["attachments"])
                    if row.get("attachments")
                    else (_legacy_html_attachments(row["content"]) or None)
                ),
                "preview_changes": (
                    json.loads(row["preview_changes"])
                    if isinstance(row.get("preview_changes"), str)
                    else row.get("preview_changes")
                ),
                "project_changes": (
                    json.loads(row["project_changes"])
                    if isinstance(row.get("project_changes"), str)
                    else row.get("project_changes")
                ),
                "project_change_sets": (
                    json.loads(row["project_change_sets"])
                    if isinstance(row.get("project_change_sets"), str)
                    else row.get("project_change_sets")
                ),
                "preview_snapshot": (
                    json.loads(row["preview_snapshot"])
                    if isinstance(row.get("preview_snapshot"), str)
                    else row.get("preview_snapshot")
                ),
                "search_sources": (
                    json.loads(row["search_sources"])
                    if isinstance(row.get("search_sources"), str)
                    else row.get("search_sources")
                ),
                "search_trace": (
                    json.loads(row["search_trace"])
                    if isinstance(row.get("search_trace"), str)
                    else row.get("search_trace")
                ),
                "thinking_trace": (
                    json.loads(row["thinking_trace"])
                    if isinstance(row.get("thinking_trace"), str)
                    else row.get("thinking_trace")
                ),
            }
            for row in rows
        ]


async def save_thinking_trace(session_id: str, message_id: str, trace: dict):
    """Upsert only display metadata; preserve prose, files, Diff and usage."""
    pool = await get_pool()
    async with pool.acquire() as conn:
        await conn.execute(
            """INSERT INTO chat_messages (session_id, role, content, client_message_id, thinking_trace)
               VALUES ($1, 'assistant', '', $2, $3::jsonb)
               ON CONFLICT (session_id, client_message_id) WHERE client_message_id IS NOT NULL
               DO UPDATE SET thinking_trace = EXCLUDED.thinking_trace""",
            session_id, message_id, json.dumps(trace, ensure_ascii=False),
        )


async def load_conversation_context(session_id: str) -> dict | None:
    pool = await get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT summary, compressed_until_message_id FROM conversation_context WHERE session_id = $1",
            session_id,
        )
        return dict(row) if row else None


async def save_conversation_context(session_id: str, summary: str, until_message_id: int) -> None:
    pool = await get_pool()
    async with pool.acquire() as conn:
        await conn.execute(
            """INSERT INTO conversation_context (session_id, summary, compressed_until_message_id)
               VALUES ($1, $2, $3)
               ON CONFLICT (session_id) DO UPDATE SET
                   summary = EXCLUDED.summary,
                   compressed_until_message_id = EXCLUDED.compressed_until_message_id,
                   updated_at = NOW()""",
            session_id, summary, until_message_id,
        )


async def save_message(
    session_id: str,
    role: str,
    content: str,
    token_usage: Optional[dict] = None,
    images: Optional[list] = None,
    attachments: Optional[list] = None,
    preview_changes: Optional[list] = None,
    preview_snapshot: Optional[dict] = None,
    message_id: Optional[str] = None,
    search_sources: Optional[list] = None,
    search_trace: Optional[dict] = None,
    project_changes: Optional[list] = None,
) -> int:
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
        search_sources: 联网搜索实际引用的来源列表（可选，仅 AI 回复）
        search_trace: 联网搜索的 Search Trace（attempted/successful providers）
    """
    pool = await get_pool()
    async with pool.acquire() as conn:
        if token_usage:
            # AI 回复：记录 Token 消耗
            saved_id = await conn.fetchval(
                """INSERT INTO chat_messages (session_id, role, content, images, attachments, preview_changes, preview_snapshot, search_sources, search_trace, prompt_tokens, completion_tokens, total_tokens, client_message_id, project_changes)
                   VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9::jsonb, $10, $11, $12, $13, $14::jsonb)
                   ON CONFLICT (session_id, client_message_id) WHERE client_message_id IS NOT NULL
                   DO UPDATE SET content = EXCLUDED.content, images = EXCLUDED.images, attachments = EXCLUDED.attachments,
                     preview_changes = EXCLUDED.preview_changes, preview_snapshot = EXCLUDED.preview_snapshot,
                     search_sources = EXCLUDED.search_sources, search_trace = EXCLUDED.search_trace,
                     prompt_tokens = EXCLUDED.prompt_tokens, completion_tokens = EXCLUDED.completion_tokens,
                     total_tokens = EXCLUDED.total_tokens, project_changes = EXCLUDED.project_changes
                   RETURNING id""",
                session_id, role, content,
                json.dumps(images) if images else None,
                json.dumps(attachments, ensure_ascii=False) if attachments else None,
                json.dumps(preview_changes, ensure_ascii=False) if preview_changes else None,
                json.dumps(preview_snapshot, ensure_ascii=False) if preview_snapshot else None,
                json.dumps(search_sources, ensure_ascii=False) if search_sources else None,
                json.dumps(search_trace, ensure_ascii=False) if search_trace else None,
                token_usage.get("prompt_tokens", 0),
                token_usage.get("completion_tokens", 0),
                token_usage.get("total_tokens", 0),
                message_id,
                json.dumps(project_changes, ensure_ascii=False) if project_changes else None,
            )
        else:
            # 用户消息或不带 Token 数据：仅插入基本字段
            saved_id = await conn.fetchval(
                """INSERT INTO chat_messages (session_id, role, content, images, attachments, preview_changes, preview_snapshot, search_sources, search_trace, client_message_id, project_changes)
                   VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9::jsonb, $10, $11::jsonb)
                   ON CONFLICT (session_id, client_message_id) WHERE client_message_id IS NOT NULL
                   DO UPDATE SET content = EXCLUDED.content, images = EXCLUDED.images, attachments = EXCLUDED.attachments,
                     preview_changes = EXCLUDED.preview_changes, preview_snapshot = EXCLUDED.preview_snapshot,
                     search_sources = EXCLUDED.search_sources, search_trace = EXCLUDED.search_trace, project_changes = EXCLUDED.project_changes
                   RETURNING id""",
                session_id, role, content,
                json.dumps(images) if images else None,
                json.dumps(attachments, ensure_ascii=False) if attachments else None,
                json.dumps(preview_changes, ensure_ascii=False) if preview_changes else None,
                json.dumps(preview_snapshot, ensure_ascii=False) if preview_snapshot else None,
                json.dumps(search_sources, ensure_ascii=False) if search_sources else None,
                json.dumps(search_trace, ensure_ascii=False) if search_trace else None,
                message_id,
                json.dumps(project_changes, ensure_ascii=False) if project_changes else None,
            )
        # 更新会话的最后活动时间
        await conn.execute(
            "UPDATE chat_sessions SET updated_at = NOW() WHERE id = $1",
            session_id,
        )
        return saved_id


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
    attachment_rows = []
    generated_rows = []
    async with pool.acquire() as conn:
        attachment_rows = await conn.fetch(
            "SELECT relative_path FROM session_attachments WHERE session_id = $1", session_id
        )
        await conn.execute("DELETE FROM session_attachments WHERE session_id = $1", session_id)
        generated_rows = await conn.fetch(
            "SELECT relative_path FROM session_generated_artifacts WHERE session_id = $1", session_id
        )
        await conn.execute("DELETE FROM session_generated_artifacts WHERE session_id = $1", session_id)
        await conn.execute("DELETE FROM project_change_sets WHERE session_id = $1", session_id)
        await conn.execute("DELETE FROM session_preview_projects WHERE session_id = $1", session_id)
        await conn.execute("DELETE FROM conversation_context WHERE session_id = $1", session_id)
        await conn.execute("DELETE FROM chat_sessions WHERE id = $1", session_id)
    from storage import UPLOAD_ROOT
    for row in attachment_rows:
        relative = Path(row["relative_path"])
        if relative.is_absolute() or ".." in relative.parts:
            continue
        target = (UPLOAD_ROOT / relative).resolve()
        if target.is_relative_to(UPLOAD_ROOT) and not target.is_symlink():
            try:
                target.unlink(missing_ok=True)
                target.parent.rmdir()
            except OSError:
                pass
    from storage import GENERATED_ROOT
    for row in generated_rows:
        if not row["relative_path"]:
            continue
        relative = Path(row["relative_path"])
        if relative.is_absolute() or ".." in relative.parts:
            continue
        target = (GENERATED_ROOT / relative).resolve()
        if target.is_relative_to(GENERATED_ROOT) and not target.is_symlink():
            try:
                target.unlink(missing_ok=True)
            except OSError:
                pass


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
    # 一条语句完成判断与更新：远端数据库每次往返约 240ms，原先 4 次查询要 1 秒以上
    # （生成标题在回答结束前执行，会直接拖长用户的等待）。规则与原先一致：
    # 标题仍是「新对话」且已有 assistant 消息时，取第一条 user 消息前 18 个字符，超出加「...」。
    pool = await get_pool()
    async with pool.acquire() as conn:
        title = await conn.fetchval(
            """UPDATE chat_sessions
               SET title = CASE WHEN char_length(first_user.content) > 18
                                THEN left(first_user.content, 18) || '...'
                                ELSE first_user.content END
               FROM (SELECT content FROM chat_messages
                     WHERE session_id = $1 AND role = 'user'
                     ORDER BY created_at ASC, id ASC LIMIT 1) AS first_user
               WHERE chat_sessions.id = $1
                 AND chat_sessions.title = '新对话'
                 AND EXISTS (SELECT 1 FROM chat_messages WHERE session_id = $1 AND role = 'assistant')
               RETURNING chat_sessions.title""",
            session_id,
        )
        if title is not None:
            print(f"[Session] 自动生成标题: {title}")
