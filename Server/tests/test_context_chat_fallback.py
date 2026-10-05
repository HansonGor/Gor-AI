"""A compressor outage must leave the existing SSE response path usable."""

import importlib
import json
import unittest
from unittest.mock import AsyncMock, patch

chat_module = importlib.import_module("routes.chat")


class ContextChatFallbackTests(unittest.IsolatedAsyncioTestCase):
    async def test_compressor_failure_keeps_sse_and_recent_history(self):
        class Request:
            async def is_disconnected(self):
                return False

        captured = {}

        async def fake_agent(messages, send_event, *args):
            captured["messages"] = messages
            captured["summary"] = args[-1]
            send_event({"type": "token", "content": "正常回复"})

        rows = [
            {"db_message_id": i, "role": "user" if i % 2 else "assistant",
             "content": f"消息{i}", "images": None, "preview_snapshot": None}
            for i in range(1, 37)
        ]
        with patch.object(chat_module, "save_message", new_callable=AsyncMock, return_value=36), \
             patch.object(chat_module, "load_messages", new_callable=AsyncMock, return_value=rows), \
             patch.object(chat_module.context_engine, "build_context", new_callable=AsyncMock, side_effect=RuntimeError("summary model down")), \
             patch.object(chat_module, "run_agent", fake_agent), \
             patch.object(chat_module, "deduct_model_quota", new_callable=AsyncMock, return_value=None), \
             patch.object(chat_module, "auto_generate_session_title", new_callable=AsyncMock):
            response = await chat_module.chat(Request(), chat_module.ChatRequest(sessionId="test", message="当前消息"))
            chunks = [chunk async for chunk in response.body_iterator]
        events = [json.loads(chunk[6:]) for chunk in chunks if chunk.startswith("data: ")]
        self.assertEqual(captured["summary"], None)
        self.assertEqual(len(captured["messages"]), 30)
        self.assertEqual(captured["messages"][-1]["content"], "当前消息")
        self.assertIn("token", [event["type"] for event in events])
        self.assertEqual(events[-1]["type"], "done")
        self.assertNotIn("error", [event["type"] for event in events])
