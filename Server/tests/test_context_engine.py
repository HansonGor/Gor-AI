import unittest
from unittest.mock import AsyncMock, patch
from langchain_core.messages import AIMessage, SystemMessage
import agent.agent as agent_module

from services.context_engine import (
    CONTEXT_COMPRESSION_THRESHOLD,
    ContextEngine,
    estimate_tokens,
    message_tokens,
)


def message(number: int, content: str) -> dict:
    return {"db_message_id": number, "role": "user" if number % 2 else "assistant", "content": content}


class ContextEngineTests(unittest.IsolatedAsyncioTestCase):
    async def test_summary_is_a_system_message_before_recent_and_current(self):
        class FakeModel:
            messages = None

            async def ainvoke(self, messages, config=None):
                self.messages = messages
                return AIMessage(content="记得较早确认的偏好")

        model = FakeModel()
        with patch.object(agent_module, "get_model_for_tools", return_value=model), \
             patch.object(agent_module, "TYPING_DELAY_MS", 0):
            events = []
            await agent_module.run_agent(
                [{"role": "assistant", "content": "最近的原文"},
                 {"role": "user", "content": "现在继续"}],
                events.append,
                conversation_summary="较早确认：保留深色主题。",
            )
        self.assertIsInstance(model.messages[0], SystemMessage)
        summary_index = next(i for i, item in enumerate(model.messages)
                             if isinstance(item, SystemMessage) and "保留深色主题" in item.content)
        self.assertEqual(model.messages[summary_index + 1].content, "最近的原文")
        self.assertEqual(model.messages[summary_index + 2].content, "现在继续")

    async def test_short_session_keeps_existing_thirty_message_window(self):
        rows = [message(i, f"message {i}") for i in range(1, 35)]
        with patch("services.context_engine.load_conversation_context", new_callable=AsyncMock, return_value=None), \
             patch("services.context_engine.save_conversation_context", new_callable=AsyncMock) as save:
            result = await ContextEngine().build_context("short", rows, message(35, "current"))
        self.assertEqual([m["db_message_id"] for m in result["recent_messages"]], list(range(6, 35)))
        self.assertEqual(result["summary"], "")
        save.assert_not_awaited()

    async def test_incremental_persistence_and_current_turn_exclusion(self):
        # Repeated Chinese and Latin words yield a realistic large token count.
        text = "用户希望保留项目决定和结果。 " * 20
        rows = [message(i, text) for i in range(1, 105)]
        self.assertGreater(sum(map(message_tokens, rows)), CONTEXT_COMPRESSION_THRESHOLD)
        stored: dict = {}
        calls = []

        async def load(_session):
            return stored.copy()

        async def save(_session, summary, until):
            stored.update(summary=summary, compressed_until_message_id=until)

        class Compressor:
            async def compress(self, old_summary, batch):
                calls.append((old_summary, [m["db_message_id"] for m in batch]))
                return f"{old_summary}|decision-{batch[-1]['db_message_id']}"

        with patch("services.context_engine.load_conversation_context", load), \
             patch("services.context_engine.save_conversation_context", save):
            engine = ContextEngine(Compressor())
            current = message(105, "当前用户消息绝不能压缩")
            first = await engine.build_context("session", rows, current)
            self.assertTrue(first["summary"])
            self.assertNotIn(105, [id for _, batch in calls for id in batch])
            self.assertEqual(first["recent_messages"], rows[stored["compressed_until_message_id"]:])
            self.assertGreaterEqual(sum(map(message_tokens, first["recent_messages"])), 10000)
            self.assertLess(estimate_tokens(first["summary"]) + sum(map(message_tokens, first["recent_messages"])), CONTEXT_COMPRESSION_THRESHOLD)
            first_summary = stored["summary"]
            first_until = stored["compressed_until_message_id"]
            first_call_count = len(calls)
            second_rows = rows + [message(i, text) for i in range(105, 180)]
            second = await ContextEngine(Compressor()).build_context("session", second_rows, message(180, "下一轮当前消息"))
            self.assertTrue(second["summary"].startswith(first_summary))
            self.assertGreater(stored["compressed_until_message_id"], first_until)
            self.assertTrue(all(id > first_until for _, batch in calls[first_call_count:] for id in batch))
            self.assertEqual(len(rows), 104)  # Compression never mutates original rows.

    async def test_compression_failure_does_not_advance_marker(self):
        rows = [message(i, "历史信息 " * 700) for i in range(1, 35)]
        class FailingCompressor:
            async def compress(self, *_):
                raise RuntimeError("model unavailable")
        with patch("services.context_engine.load_conversation_context", new_callable=AsyncMock, return_value=None), \
             patch("services.context_engine.save_conversation_context", new_callable=AsyncMock) as save:
            with self.assertRaisesRegex(RuntimeError, "model unavailable"):
                await ContextEngine(FailingCompressor()).build_context("failure", rows, message(35, "current"))
            save.assert_not_awaited()

    def test_tokenizer_counts_tokens_not_characters(self):
        self.assertNotEqual(estimate_tokens("hello world"), len("hello world"))


if __name__ == "__main__":
    unittest.main()
