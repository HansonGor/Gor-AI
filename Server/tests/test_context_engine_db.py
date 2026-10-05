"""Opt-in PostgreSQL integration check; uses and removes only its own test session."""

import unittest

from config import config
from db.supabase_chat import (
    create_session, get_pool, init_db, load_conversation_context, load_messages,
)
from services.context_engine import ContextEngine, estimate_tokens, message_tokens


@unittest.skipUnless(config.Database.URL, "SUPABASE_DB_URL is not configured")
class ContextDatabaseTests(unittest.IsolatedAsyncioTestCase):
    async def _cleanup_test_sessions(self):
        pool = await get_pool()
        async with pool.acquire() as conn:
            ids = await conn.fetch("SELECT id FROM chat_sessions WHERE user_id = 'context-compression-test'")
            for row in ids:
                session_id = str(row["id"])
                await conn.execute("DELETE FROM conversation_context WHERE session_id = $1", session_id)
                await conn.execute("DELETE FROM chat_messages WHERE session_id = $1", session_id)
                await conn.execute("DELETE FROM chat_sessions WHERE id = $1", row["id"])

    async def test_original_rows_and_summary_survive_reload(self):
        await init_db()
        await self._cleanup_test_sessions()
        session = await create_session("context-compression-test")
        session_id = str(session["id"])
        text = "用户希望保留项目决定和结果。 " * 20

        class Compressor:
            async def compress(self, old_summary, batch):
                return (old_summary + "\n" if old_summary else "") + "已确认：用户要求保留项目决定和结果。"

        try:
            pool = await get_pool()
            async with pool.acquire() as conn:
                await conn.executemany(
                    "INSERT INTO chat_messages (session_id, role, content) VALUES ($1, $2, $3)",
                    [(session_id, "user" if index % 2 else "assistant", text) for index in range(104)],
                )
            before = await load_messages(session_id)
            result = await ContextEngine(Compressor()).build_context(
                session_id, before, {"role": "user", "content": "本轮消息"},
            )
            persisted = await load_conversation_context(session_id)
            after = await load_messages(session_id)
            self.assertEqual(len(before), 104)
            self.assertEqual(len(after), len(before))
            self.assertEqual([m["db_message_id"] for m in before], [m["db_message_id"] for m in after])
            self.assertEqual(result["summary"], persisted["summary"])
            self.assertIsNotNone(persisted["compressed_until_message_id"])
            resumed = await ContextEngine(Compressor()).build_context(
                session_id, after, {"role": "user", "content": "本轮消息"},
            )
            self.assertEqual(resumed["summary"], result["summary"])
            pre_tokens = sum(map(message_tokens, before)) + message_tokens({"content": "本轮消息"})
            post_tokens = estimate_tokens(result["summary"]) + sum(map(message_tokens, result["recent_messages"])) + message_tokens({"content": "本轮消息"})
            print(f"[ContextTest] before_tokens={pre_tokens} after_tokens={post_tokens} original_rows={len(after)}")
        finally:
            await self._cleanup_test_sessions()
