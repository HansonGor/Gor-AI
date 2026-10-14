"""Compact, exact message-to-journal association; no snapshot leakage."""
import json
import unittest
from contextlib import asynccontextmanager
from unittest.mock import AsyncMock, patch

from db.supabase_chat import load_messages
from project_api.changes import ChangeRecorder, snapshot
from project_api.types import ProjectRef
from tests.test_project_changes import Store


class HistoryTests(unittest.IsolatedAsyncioTestCase):
    async def test_message_binding_survives_seal_for_both_hosts(self):
        for provider in ("preview", "vscode"):
            store = Store()
            recorder = ChangeRecorder(store, "session", "round")
            item = await recorder.record(ProjectRef("project", provider),
                {"/a.ts": snapshot("old", 1)}, {"/a.ts": snapshot("new", 2)})
            item["messageId"] = "assistant-message"
            await recorder.seal()
            stored = await store.get(item["id"])
            self.assertEqual(stored["messageId"], "assistant-message")
            self.assertTrue(stored["sealed"])
            self.assertEqual(stored["files"][0]["before"]["content"], "old")

    async def test_history_decodes_exact_compact_refs_without_restoring_legacy_guesses(self):
        refs = [{"id": "journal", "sessionId": "session", "provider": "preview"}]
        class Connection:
            async def fetch(self, query, session):
                self_query.append(query)
                return [{"id": 1, "client_message_id": "assistant-message", "role": "assistant",
                         "content": "已修改", "project_change_sets": json.dumps(refs)},
                        {"id": 2, "role": "assistant", "content": "历史消息", "project_change_sets": None}]
        class Pool:
            @asynccontextmanager
            async def acquire(self):
                yield Connection()
        self_query = []
        with patch("db.supabase_chat.get_pool", AsyncMock(return_value=Pool())):
            messages = await load_messages("session")
        self.assertEqual(messages[0]["project_change_sets"], refs)
        self.assertIsNone(messages[1]["project_change_sets"])
        self.assertIn("cs.record->>'messageId' = chat_messages.client_message_id", self_query[0])
        self.assertNotIn("'before'", self_query[0])
        self.assertNotIn("'after'", self_query[0])
        self.assertIn("cs.record->'previewPublishedSnapshot'", self_query[0])
