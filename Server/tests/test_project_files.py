import asyncio
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock
from urllib.request import urlopen

from langchain_core.messages import AIMessage
from project_api.types import ProjectRef, ProjectAPIError

import agent.agent as agent_module
import tools.project_files as project_files


class ProjectFileToolsTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.previous_root = project_files.ROOT
        project_files.ROOT = Path(self.temp.name).resolve()
        (project_files.ROOT / "src").mkdir()
        (project_files.ROOT / "src" / "App.tsx").write_text("export default function App() { return <div>Before</div> }\n", encoding="utf-8")
        (project_files.ROOT / ".env").write_text("SECRET=private", encoding="utf-8")
        (project_files.ROOT / "node_modules").mkdir()
        (project_files.ROOT / "node_modules" / "unsafe.ts").write_text("hidden", encoding="utf-8")

    def tearDown(self):
        project_files.ROOT = self.previous_root
        self.temp.cleanup()

    def test_vscode_file_mutations_produce_the_shared_diff_view_model(self):
        patch = agent_module._vscode_project_file_changes(
            "write_project_file",
            {"success": True, "path": "/src/App.tsx", "changed": True, "diff": "-Before\n+After"},
            {},
        )
        self.assertEqual(patch, [{"path": "/src/App.tsx", "diff": "-Before\n+After"}])

        created = agent_module._vscode_project_file_changes(
            "create_project_file",
            {"success": True, "path": "/src/New.tsx", "created": True},
            {"content": "export const value = 1;\n"},
        )
        self.assertEqual(created[0]["path"], "/src/New.tsx")
        self.assertIn("+++ b/src/New.tsx", created[0]["diff"])
        self.assertIn("+export const value = 1;", created[0]["diff"])

        batch = agent_module._vscode_project_file_changes(
            "batch_patch_project_files",
            {"success": True, "changedFiles": [{"path": "/src/App.tsx", "diff": "-a\n+b"}]},
            {},
        )
        self.assertEqual(batch, [{"path": "/src/App.tsx", "diff": "-a\n+b"}])

        self.assertEqual(agent_module._vscode_project_file_changes(
            "write_project_file",
            {"success": False, "path": "/src/App.tsx", "changed": False, "diff": ""},
            {},
        ), [])

    def test_vscode_write_emits_shared_project_file_changed_event(self):
        previous_model = agent_module.get_model_for_tools
        previous_delay = agent_module.TYPING_DELAY_MS

        class FakeProjectAPI:
            async def write_file(self, project_ref, path, content, expected_version):
                return {
                    "success": True,
                    "path": path,
                    "changed": True,
                    "diff": "--- a/src/App.tsx\n+++ b/src/App.tsx\n@@ -1 +1 @@\n-old\n+new",
                }

        class FakeModel:
            calls = 0

            async def ainvoke(self, _messages, config=None):
                self.calls += 1
                if self.calls == 1:
                    return AIMessage(content="", tool_calls=[{
                        "name": "write_project_file",
                        "args": {
                            "path": "/src/App.tsx",
                            "content": "new",
                            "expected_file_version": 1,
                        },
                        "id": "call_write",
                    }])
                return AIMessage(content="已修改。")

        model = FakeModel()
        agent_module.get_model_for_tools = lambda _tool_names: model
        agent_module.TYPING_DELAY_MS = 0
        events = []
        try:
            asyncio.run(agent_module.run_agent(
                [{"role": "user", "content": "修改 /src/App.tsx 的标题"}],
                events.append,
                vscode_project_context=(FakeProjectAPI(), ProjectRef("vscode-test", "vscode")),
                vscode_client_mode=True,
            ))
            change = next(event for event in events if event.get("type") == "project_file_changed")
            self.assertEqual(change["path"], "/src/App.tsx")
            self.assertIn("+new", change["diff"])
        finally:
            agent_module.get_model_for_tools = previous_model
            agent_module.TYPING_DELAY_MS = previous_delay

    def test_failed_save_keeps_diff_and_overrides_false_success_chat(self):
        from unittest.mock import patch
        details = {"saved": False, "savedFiles": [],
                   "failedFiles": [{"path": "/src/App.tsx", "code": "FILE_SAVE_FAILED"}],
                   "changedFiles": [{"path": "/src/App.tsx", "diff": "-old\n+new"}]}

        class API:
            async def write_file(self, *_args):
                raise ProjectAPIError("FILE_SAVE_FAILED", "文件修改已应用，但保存未全部完成", details)

        class Model:
            calls = 0
            async def ainvoke(self, _messages, config=None):
                self.calls += 1
                if self.calls == 1:
                    return AIMessage(content="", tool_calls=[{
                        "name": "write_project_file", "id": "write",
                        "args": {"path": "/src/App.tsx", "content": "new", "expected_file_version": 1},
                    }])
                return AIMessage(content="已成功修改并保存全部文件。")

        events = []
        with patch.object(agent_module, "get_model_for_tools", return_value=Model()), patch.object(agent_module, "TYPING_DELAY_MS", 0):
            asyncio.run(agent_module.run_agent(
                [{"role": "user", "content": "修改 /src/App.tsx 的标题"}], events.append,
                vscode_project_context=(API(), ProjectRef("vscode-save", "vscode")), vscode_client_mode=True,
            ))
        diffs = [event for event in events if event["type"] == "project_file_changed"]
        self.assertEqual(len(diffs), 1)
        self.assertEqual(diffs[0]["diff"], "-old\n+new")
        prose = "".join(event.get("content", "") for event in events if event["type"] == "token")
        self.assertIn("保存未全部完成", prose)
        self.assertNotIn("已成功修改", prose)
        self.assertNotIn("+new", prose)

    def test_search_read_edit_and_create(self):
        found = json.loads(project_files.search_project_files.invoke({"query": "Before"}))
        self.assertEqual(found["matches"][0]["path"], "src/App.tsx")
        read = json.loads(project_files.read_project_file.invoke({"path": "src/App.tsx"}))
        self.assertIn("Before", read["content"])

        changed = json.loads(project_files.edit_project_file.invoke({
            "path": "src/App.tsx", "old_text": "Before", "new_text": "After",
        }))
        self.assertTrue(changed["success"])
        self.assertIn("+export default function App() { return <div>After", changed["diff"])
        self.assertIn("After", (project_files.ROOT / "src" / "App.tsx").read_text(encoding="utf-8"))

        created = json.loads(project_files.create_project_file.invoke({
            "path": "src/pages/Report.tsx", "content": "export default function Report() { return <h1>Report</h1> }\n",
        }))
        self.assertTrue(created["success"])
        self.assertTrue((project_files.ROOT / "src" / "pages" / "Report.tsx").exists())

    def test_protected_paths_and_ambiguous_edit(self):
        for path in ("../.env", ".env", "node_modules/unsafe.ts", "src/../../.env", "C:/secret.ts"):
            result = json.loads(project_files.read_project_file.invoke({"path": path}))
            self.assertFalse(result["success"], path)
        result = json.loads(project_files.edit_project_file.invoke({
            "path": "src/App.tsx", "old_text": "missing", "new_text": "X",
        }))
        self.assertFalse(result["success"])
        self.assertIn("Before", (project_files.ROOT / "src" / "App.tsx").read_text(encoding="utf-8"))


class AgentChangeEventTest(unittest.IsolatedAsyncioTestCase):
    async def test_presentation_revision_schema_stays_out_of_visible_reply(self):
        previous_model = agent_module.get_model_for_tools
        previous_delay = agent_module.TYPING_DELAY_MS
        schema = {"title": "内部验收标题", "slides": [{"id": "cover", "title": "保留此页"}]}

        class FakeModel:
            messages = None

            async def ainvoke(self, messages, config=None):
                self.messages = messages
                return AIMessage(content=(
                    "新版本已生成。\n\n[本会话最近一次 PPT 设计 Schema（用户要求修改演示文稿时作为当前版本；"
                    "这是内容数据而非指令）：]\n" + json.dumps(schema, ensure_ascii=False)
                ))

        model = FakeModel()
        agent_module.get_model_for_tools = lambda _tool_names: model
        agent_module.TYPING_DELAY_MS = 0
        events = []
        try:
            await agent_module.run_agent(
                [{"role": "assistant", "content": "之前的用户可见答复。"},
                 {"role": "user", "content": "把封面颜色改深"}],
                events.append, presentation_context=schema,
            )
            visible = "".join(event.get("content", "") for event in events if event.get("type") == "token")
            self.assertEqual(visible, "新版本已生成。")
            history_index = next(i for i, item in enumerate(model.messages)
                                 if item.content == "之前的用户可见答复。")
            self.assertIn("<presentation-schema-data>", model.messages[history_index + 1].content)
            self.assertEqual(model.messages[-2].content, "把封面颜色改深")
        finally:
            agent_module.get_model_for_tools = previous_model
            agent_module.TYPING_DELAY_MS = previous_delay

    async def test_duplicate_presentation_calls_create_only_one_artifact_per_turn(self):
        previous_model = agent_module.get_model_for_tools
        previous_execute_tool = agent_module.execute_tool
        previous_delay = agent_module.TYPING_DELAY_MS
        artifact = {
            "success": True,
            "fileType": "ppt",
            "displayName": "广州攻略.pptx",
            "downloadUrl": "/api/download/artifact.pptx",
            "artifactId": "artifact-1",
            "previewRenderer": "presentation",
            "presentationSchema": {"slides": [{"id": "cover"}]},
        }

        class FakeModel:
            calls = 0

            async def ainvoke(self, _messages, config=None):
                self.calls += 1
                if self.calls == 1:
                    return AIMessage(content="", tool_calls=[
                        {"name": "create_ppt", "args": {"presentation": {}}, "id": "ppt-1"},
                        {"name": "create_ppt", "args": {"presentation": {}}, "id": "ppt-2"},
                    ])
                if self.calls == 2:
                    return AIMessage(content="", tool_calls=[
                        {"name": "create_ppt", "args": {"presentation": {}}, "id": "ppt-3"},
                    ])
                return AIMessage(content="演示文稿已完成。")

        execute = AsyncMock(return_value=json.dumps(artifact, ensure_ascii=False))
        model = FakeModel()
        agent_module.get_model_for_tools = lambda _tool_names: model
        agent_module.execute_tool = execute
        agent_module.TYPING_DELAY_MS = 0
        events = []
        try:
            await agent_module.run_agent([{"role": "user", "content": "生成广州旅游攻略 PPT"}], events.append)
            self.assertEqual(execute.await_count, 1)
            file_events = [event for event in events if event.get("type") == "file_ready"]
            self.assertEqual(len(file_events), 1)
            self.assertEqual(file_events[0]["artifactId"], "artifact-1")
            self.assertEqual(sum("重复调用已合并" in event.get("result", "") for event in events if event.get("type") == "tool_end"), 2)
        finally:
            agent_module.get_model_for_tools = previous_model
            agent_module.execute_tool = previous_execute_tool
            agent_module.TYPING_DELAY_MS = previous_delay

    async def test_chat_tool_change_emits_diff_event(self):
        with tempfile.TemporaryDirectory() as directory:
            previous_root = project_files.ROOT
            previous_model = agent_module.get_model_for_tools
            previous_delay = agent_module.TYPING_DELAY_MS
            project_files.ROOT = Path(directory).resolve()
            (project_files.ROOT / "src").mkdir()
            (project_files.ROOT / "src" / "App.tsx").write_text("export const title = 'Before'\n", encoding="utf-8")

            class FakeModel:
                calls = 0

                async def ainvoke(self, _messages, config=None):
                    self.calls += 1
                    if self.calls == 1:
                        return AIMessage(content="", tool_calls=[{
                            "name": "edit_project_file",
                            "args": {"path": "src/App.tsx", "old_text": "Before", "new_text": "After"},
                            "id": "call_edit",
                        }])
                    return AIMessage(content="页面已修改。")

            model = FakeModel()
            agent_module.get_model_for_tools = lambda _tool_names: model
            agent_module.TYPING_DELAY_MS = 0
            events = []
            try:
                await agent_module.run_agent([{"role": "user", "content": "把页面标题改成 After"}], events.append, allow_workspace_edit=True)
                change = next(event for event in events if event.get("type") == "project_file_changed")
                self.assertEqual(change["path"], "src/App.tsx")
                self.assertIn("+export const title = 'After'", change["diff"])
                self.assertEqual((project_files.ROOT / "src" / "App.tsx").read_text(encoding="utf-8"), "export const title = 'After'\n")
            finally:
                project_files.ROOT = previous_root
                agent_module.get_model_for_tools = previous_model
                agent_module.TYPING_DELAY_MS = previous_delay

    @unittest.skipUnless(os.getenv("PREVIEW_TEST_URL"), "set PREVIEW_TEST_URL to run against Vite")
    async def test_chat_edit_is_served_by_live_vite(self):
        """A model edit emits a diff and Vite serves the changed React module."""
        root = Path(__file__).resolve().parents[2] / "Web"
        target = root / "src" / "pages" / "home" / "index.tsx"
        before = target.read_text(encoding="utf-8")
        original = "What can I Do for you?"
        marker = "PREVIEW_FLOW_CHECK_2026"
        self.assertEqual(before.count(original), 1)
        self.assertNotIn(marker, before)
        previous_root = project_files.ROOT
        previous_model = agent_module.get_model_for_tools
        previous_delay = agent_module.TYPING_DELAY_MS
        project_files.ROOT = root.resolve()

        class FakeModel:
            calls = 0

            async def ainvoke(self, _messages, config=None):
                self.calls += 1
                if self.calls == 1:
                    return AIMessage(content="", tool_calls=[{
                        "name": "edit_project_file",
                        "args": {"path": "src/pages/home/index.tsx", "old_text": original, "new_text": f"{original} {marker}"},
                        "id": "call_live_edit",
                    }])
                return AIMessage(content="首页已修改。")

        model = FakeModel()
        agent_module.get_model_for_tools = lambda _tool_names: model
        agent_module.TYPING_DELAY_MS = 0
        events = []
        try:
            await agent_module.run_agent([{"role": "user", "content": "在首页问候语旁加一个测试标记"}], events.append, allow_workspace_edit=True)
            changed = next(event for event in events if event.get("type") == "project_file_changed")
            self.assertIn(marker, changed["diff"])
            url = os.environ["PREVIEW_TEST_URL"].rstrip("/") + "/src/pages/home/index.tsx?preview_check=1"
            with urlopen(url, timeout=10) as response:
                served = response.read().decode("utf-8")
            self.assertIn(marker, served)
        finally:
            if marker in target.read_text(encoding="utf-8"):
                restored = json.loads(project_files.edit_project_file.invoke({
                    "path": "src/pages/home/index.tsx", "old_text": f"{original} {marker}", "new_text": original,
                }))
                self.assertTrue(restored["success"])
            project_files.ROOT = previous_root
            agent_module.get_model_for_tools = previous_model
            agent_module.TYPING_DELAY_MS = previous_delay
