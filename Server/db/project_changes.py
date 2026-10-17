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
CREATE TABLE IF NOT EXISTS chat_model_preferences (
    session_id TEXT PRIMARY KEY, model_id TEXT NOT NULL
);"""

THINKING_MODES = {"light", "deep"}


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
        return await conn.fetchval("SELECT edit_mode FROM chat_edit_preferences WHERE session_id=$1", session_id) or "auto"


async def get_thinking_mode(session_id):
    """会话的思考方式：deep=深思（开启模型深度思考，默认），light=随思（关闭模型深度思考）。"""
    async with change_sets.connect() as conn:
        return await conn.fetchval(
            "SELECT thinking_mode FROM chat_thinking_preferences WHERE session_id=$1", session_id) or "deep"


async def set_thinking_mode(session_id, mode):
    if mode not in THINKING_MODES:
        raise ValueError("Invalid thinking mode")
    async with change_sets.connect() as conn:
        await conn.execute("""INSERT INTO chat_thinking_preferences(session_id,thinking_mode) VALUES($1,$2)
            ON CONFLICT(session_id) DO UPDATE SET thinking_mode=EXCLUDED.thinking_mode""", session_id, mode)


async def get_model_preference(session_id):
    """会话保存的模型 ID；没有记录返回 None。是否仍可用由模型注册表判断。"""
    async with change_sets.connect() as conn:
        return await conn.fetchval("SELECT model_id FROM chat_model_preferences WHERE session_id=$1", session_id)


async def set_model_preference(session_id, model_id):
    if not isinstance(model_id, str) or not model_id.strip() or len(model_id) > 200:
        raise ValueError("Invalid model id")
    async with change_sets.connect() as conn:
        await conn.execute("""INSERT INTO chat_model_preferences(session_id,model_id) VALUES($1,$2)
            ON CONFLICT(session_id) DO UPDATE SET model_id=EXCLUDED.model_id""", session_id, model_id)


async def set_edit_mode(session_id, mode):
    if mode not in {"auto", "review"}:
        raise ValueError("Invalid edit mode")
    async with change_sets.connect() as conn:
        await conn.execute("""INSERT INTO chat_edit_preferences(session_id,edit_mode) VALUES($1,$2)
            ON CONFLICT(session_id) DO UPDATE SET edit_mode=EXCLUDED.edit_mode""", session_id, mode)
