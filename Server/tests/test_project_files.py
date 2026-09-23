import json
import os
import tempfile
import unittest
from pathlib import Path
from urllib.request import urlopen

from langchain_core.messages import AIMessage

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
    async def test_chat_tool_change_emits_diff_event(self):
        with tempfile.TemporaryDirectory() as directory:
            previous_root = project_files.ROOT
            previous_model = agent_module.model_with_workspace_tools
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

            agent_module.model_with_workspace_tools = FakeModel()
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
                agent_module.model_with_workspace_tools = previous_model
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
        previous_model = agent_module.model_with_workspace_tools
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

        agent_module.model_with_workspace_tools = FakeModel()
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
            agent_module.model_with_workspace_tools = previous_model
            agent_module.TYPING_DELAY_MS = previous_delay
