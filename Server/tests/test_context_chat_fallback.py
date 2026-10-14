"""A compressor outage must leave the existing SSE response path usable."""

import importlib
import json
import unittest
from unittest.mock import AsyncMock, patch
from services.context_engine import message_tokens, RECENT_CONTEXT_BUDGET

chat_module = importlib.import_module("routes.chat")


class ContextChatFallbackTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        # These are SSE/adapter tests, not live database integration checks.
        for name in ("get_edit_mode", "get_session_preview_project"):
            mock = patch.object(chat_module, name, new_callable=AsyncMock,
                                return_value="auto" if name == "get_edit_mode" else None)
            mock.start()
            self.addCleanup(mock.stop)

    async def test_database_history_failure_bounds_client_history_and_keeps_current(self):
        class Request:
            async def is_disconnected(self):
                return False
        for mode in ("web", "vscode"):
            with self.subTest(mode=mode):
                captured = {}
                async def fake_agent(messages, send_event, *args):
                    captured["messages"] = messages
                    captured["summary"] = args[-4]
                    send_event({"type": "token", "content": "正常回复"})
                history = [{"role": "user" if i % 2 else "assistant", "content": "历史信息 " * 700}
                           for i in range(1, 35)]
                history.append({"role": "user", "content": "当前问题原文"})
                with patch.object(chat_module, "save_message", new_callable=AsyncMock), \
                     patch.object(chat_module, "load_messages", new_callable=AsyncMock, side_effect=RuntimeError("unavailable")), \
                     patch.object(chat_module, "run_agent", fake_agent), \
                     patch.object(chat_module, "deduct_model_quota", new_callable=AsyncMock), \
                     patch.object(chat_module, "auto_generate_session_title", new_callable=AsyncMock):
                    response = await chat_module.chat(Request(), chat_module.ChatRequest(
                        sessionId="fallback", clientMode=mode, message="当前问题原文", messages=history))
                    events = [chunk async for chunk in response.body_iterator]
                self.assertEqual(captured["messages"][-1]["content"], "当前问题原文")
                self.assertLessEqual(sum(map(message_tokens, captured["messages"][:-1])), RECENT_CONTEXT_BUDGET)
                self.assertEqual(captured["messages"][0]["role"], "user")
                self.assertIn("未附带", captured["summary"])
                self.assertTrue(events)

    async def test_explicit_web_mode_ignores_stale_plugin_workspace_and_disk_edit_flag(self):
        class Request:
            async def is_disconnected(self):
                return False

        captured = {}

        async def fake_agent(messages, send_event, *args):
            captured['allow_disk_edit'] = args[3]
            captured['vscode_context'] = args[-3]
            captured['vscode_mode'] = args[-2]
            send_event({'type': 'token', 'content': '已检查 Web 项目'})

        with patch.object(chat_module, 'save_message', new_callable=AsyncMock, return_value=1), \
             patch.object(chat_module, 'load_messages', new_callable=AsyncMock, return_value=[]), \
             patch.object(chat_module, 'get_session_preview_project', new_callable=AsyncMock, return_value=None), \
             patch.object(chat_module.context_engine, 'build_context', new_callable=AsyncMock, return_value={'summary': '', 'recent_messages': []}), \
             patch.object(chat_module, 'create_current_vscode_project_api') as plugin_context, \
             patch.object(chat_module, 'run_agent', fake_agent), \
             patch.object(chat_module, 'deduct_model_quota', new_callable=AsyncMock), \
             patch.object(chat_module, 'auto_generate_session_title', new_callable=AsyncMock):
            response = await chat_module.chat(Request(), chat_module.ChatRequest(
                sessionId='web-mode-test', message='查看项目', clientMode='web',
                workspaceId='stale-workspace', workspaceEdit=True,
            ))
            chunks = [chunk async for chunk in response.body_iterator]
        plugin_context.assert_not_called()
        self.assertIsNone(captured['vscode_context'])
        self.assertFalse(captured['vscode_mode'])
        self.assertFalse(captured['allow_disk_edit'])
        self.assertTrue(chunks)

    async def test_compressor_failure_keeps_sse_and_recent_history(self):
        class Request:
            async def is_disconnected(self):
                return False

        captured = {}

        async def fake_agent(messages, send_event, *args):
            captured["messages"] = messages
            captured["summary"] = args[-4]
            send_event({"type": "token", "content": "正常回复"})

        rows = [
            {"db_message_id": i, "role": "user" if i % 2 else "assistant",
             "content": f"消息{i}" + "历史信息 " * 700, "images": None, "preview_snapshot": None}
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
        self.assertIn("未附带", captured["summary"])
        self.assertLess(len(captured["messages"]), 36)
        self.assertEqual(captured["messages"][0]["role"], "user")
        self.assertLessEqual(sum(map(message_tokens, captured["messages"][:-1])), RECENT_CONTEXT_BUDGET)
        self.assertEqual(captured["messages"][-1]["content"], "当前消息")
        self.assertIn("token", [event["type"] for event in events])
        self.assertEqual(events[-1]["type"], "done")
        self.assertNotIn("error", [event["type"] for event in events])

    async def test_vscode_chat_ignores_default_preview_bootstrap(self):
        class Request:
            async def is_disconnected(self):
                return False

        captured = {}

        async def fake_agent(messages, send_event, *args):
            captured["preview_workspace"] = args[2]
            captured["vscode_context"] = args[-3]
            captured["session_id"] = args[-1]
            send_event({"type": "token", "content": "已读取工作区"})

        bootstrap = {
            "id": "preview-default",
            "name": "React Preview",
            "template": "react",
            "revision": 0,
            "files": {
                "/index.html": "<div id='root'></div>",
                "/src/main.tsx": "import App from './App';",
                "/src/App.tsx": "export default function App() { return <h1>Gor Preview</h1>; }",
                "/src/style.css": "body { margin: 0; }",
            },
        }
        with patch.object(chat_module, "save_message", new_callable=AsyncMock, return_value=1), \
             patch.object(chat_module, "load_messages", new_callable=AsyncMock, return_value=[]), \
             patch.object(chat_module, "get_session_preview_project", new_callable=AsyncMock) as get_project, \
             patch.object(chat_module.context_engine, "build_context", new_callable=AsyncMock, return_value={"summary": "", "recent_messages": []}), \
             patch.object(chat_module, "run_agent", fake_agent), \
             patch.object(chat_module, "deduct_model_quota", new_callable=AsyncMock, return_value=None), \
             patch.object(chat_module, "auto_generate_session_title", new_callable=AsyncMock):
            response = await chat_module.chat(Request(), chat_module.ChatRequest(
                sessionId="vscode-session",
                message="PetTransportDetail.jsx 你能看到这里面的代码是干嘛的不",
                clientMode="vscode",
                workspaceId="vscode-test-workspace",
                previewProjectBootstrap=bootstrap,
            ))
            chunks = [chunk async for chunk in response.body_iterator]

        events = [json.loads(chunk[6:]) for chunk in chunks if chunk.startswith("data: ")]
        self.assertIsNone(captured["preview_workspace"])
        self.assertIsNotNone(captured["vscode_context"])
        self.assertEqual(captured["session_id"], "vscode-session")
        self.assertEqual(captured["vscode_context"][1].provider, "vscode")
        get_project.assert_not_awaited()
        self.assertNotIn("preview_project_persisted", [event["type"] for event in events])
        self.assertIn("token", [event["type"] for event in events])
