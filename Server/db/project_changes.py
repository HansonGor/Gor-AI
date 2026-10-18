"""ChangeSets are JSONB, never generated files on the server filesystem."""
import json
from contextlib import asynccontextmanager
from contextvars import ContextVar
from db.supabase_chat import get_pool


DDL = """CREATE TABLE IF NOT EXISTS project_change_sets (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
    record JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
); CREATE INDEX IF NOT EXISTS project_changes_session ON project_change_sets(session_id);
CREATE TABLE IF NOT EXISTS chat_edit_preferences (
    session_id TEXT PRIMARY KEY, edit_mode TEXT NOT NULL CHECK (edit_mode IN ('auto', 'review'))
);
CREATE TABLE IF NOT EXISTS chat_thinking_preferences (
    session_id TEXT PRIMARY KEY, thinking_mode TEXT NOT NULL CHECK (thinking_mode IN ('light', 'deep'))
);
-- Retain the legacy table without using it; runtime model choices are not persisted.
CREATE TABLE IF NOT EXISTS chat_model_preferences (
    session_id TEXT PRIMARY KEY, model_id TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS chat_global_preferences (
    id SMALLINT PRIMARY KEY CHECK (id = 1),
    edit_mode TEXT NOT NULL DEFAULT 'auto' CHECK (edit_mode IN ('auto', 'review')),
    thinking_mode TEXT NOT NULL DEFAULT 'auto' CHECK (thinking_mode IN ('auto', 'light', 'deep'))
);"""

# 必须在 ensure_auto_thinking_mode 之后执行：旧库约束放开前插入 'auto' 会违反约束
SEED_GLOBAL_PREFERENCES = """INSERT INTO chat_global_preferences(id,edit_mode,thinking_mode) VALUES(
    1,
    COALESCE((SELECT MIN(edit_mode) FROM chat_edit_preferences HAVING COUNT(DISTINCT edit_mode)=1), 'auto'),
    'auto'
) ON CONFLICT(id) DO NOTHING;"""

# auto=酌思（默认，按问题自动选深浅），light=随思，deep=深思
THINKING_MODES = {"auto", "light", "deep"}


async def ensure_auto_thinking_mode(conn):
    """旧库的约束只允许 light/deep：放开 auto 并把默认改为酌思。

    只在约束尚不含 auto 时执行一次，同时把全局偏好切到酌思（"默认酌思"的上线切换）；
    之后用户再改成随思/深思会被保留，不会在每次启动时被覆盖。
    """
    row = await conn.fetchrow(
        """SELECT c.conname, pg_get_constraintdef(c.oid) AS def FROM pg_constraint c
           JOIN pg_class t ON t.oid = c.conrelid
           WHERE t.relname = 'chat_global_preferences' AND c.contype = 'c'
             AND pg_get_constraintdef(c.oid) LIKE '%thinking_mode%'""")
    if not row or "'auto'" in row["def"]:
        return
    async with conn.transaction():
        await conn.execute(f'ALTER TABLE chat_global_preferences DROP CONSTRAINT "{row["conname"]}"')
        await conn.execute("""ALTER TABLE chat_global_preferences
            ADD CONSTRAINT chat_global_preferences_thinking_mode_check
            CHECK (thinking_mode IN ('auto', 'light', 'deep'))""")
        await conn.execute("ALTER TABLE chat_global_preferences ALTER COLUMN thinking_mode SET DEFAULT 'auto'")
        await conn.execute("UPDATE chat_global_preferences SET thinking_mode = 'auto' WHERE id = 1")


class ChangeSetStore:
    def __init__(self):
        self.connection = ContextVar("changes_connection", default=None)

    @asynccontextmanager
    async def connect(self):
        existing = self.connection.get()
        if existing:
            yield existing
        else:
            pool = await get_pool()
            async with pool.acquire() as conn:
                yield conn

    async def put(self, record):
        async with self.connect() as conn:
            await conn.execute("""INSERT INTO project_change_sets(id, session_id, record)
                VALUES($1,$2,$3::jsonb) ON CONFLICT(id) DO UPDATE
                SET record=EXCLUDED.record, updated_at=NOW()""",
                record["id"], record["sessionId"], json.dumps(record, ensure_ascii=False))

    async def get(self, id):
        async with self.connect() as conn:
            row = await conn.fetchval("SELECT record FROM project_change_sets WHERE id=$1", id)
        return json.loads(row) if isinstance(row, str) else row

    @asynccontextmanager
    async def lock(self, id):
        async with self.connect() as conn:
            # Session-level advisory locks survive the pre-IO journal commit;
            # unlike a long transaction, another worker sees undoing after a crash.
            await conn.execute("SELECT pg_advisory_lock(hashtextextended($1,0))", id)
            token = self.connection.set(conn)
            try:
                yield
            finally:
                self.connection.reset(token)
                await conn.execute("SELECT pg_advisory_unlock(hashtextextended($1,0))", id)


change_sets = ChangeSetStore()


async def get_edit_mode(session_id):
    async with change_sets.connect() as conn:
        return await conn.fetchval("SELECT edit_mode FROM chat_global_preferences WHERE id=1") or "auto"


async def get_thinking_mode(session_id):
    """全局思考方式：auto=酌思（默认），light=随思，deep=深思。"""
    async with change_sets.connect() as conn:
        return await conn.fetchval("SELECT thinking_mode FROM chat_global_preferences WHERE id=1") or "auto"


async def set_thinking_mode(session_id, mode):
    if mode not in THINKING_MODES:
        raise ValueError("Invalid thinking mode")
    async with change_sets.connect() as conn:
        await conn.execute("""INSERT INTO chat_global_preferences(id,thinking_mode) VALUES(1,$1)
            ON CONFLICT(id) DO UPDATE SET thinking_mode=EXCLUDED.thinking_mode""", mode)


async def get_model_preference(session_id):
    """模型选择仅存在于当前前端运行时；重载时始终回到默认模型。"""
    return None


async def set_model_preference(session_id, model_id):
    if not isinstance(model_id, str) or not model_id.strip() or len(model_id) > 200:
        raise ValueError("Invalid model id")
    # 保留旧函数签名供兼容调用方校验，但不持久化模型选择。
    return None


async def set_edit_mode(session_id, mode):
    if mode not in {"auto", "review"}:
        raise ValueError("Invalid edit mode")
    async with change_sets.connect() as conn:
        await conn.execute("""INSERT INTO chat_global_preferences(id,edit_mode) VALUES(1,$1)
            ON CONFLICT(id) DO UPDATE SET edit_mode=EXCLUDED.edit_mode""", mode)
