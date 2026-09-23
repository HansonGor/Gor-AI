import asyncio
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from langchain_core.messages import AIMessage

from agent.agent import execute_tool, run_agent
from tools.preview_project import PreviewProjectWorkspace, normalize_virtual_path


def template_snapshot():
    return {
        "id": "preview-test",
        "template": "react",
        "files": {
            "/src/main.tsx": "import App from './App';",
            "/src/App.tsx": "export default function App() { return <h1>Before</h1>; }",
            "/src/style.css": "body {}",
        },
    }


class FakeModel:
    def __init__(self):
        self.calls = 0

    async def ainvoke(self, _messages, config=None):
        self.calls += 1
        if self.calls == 1:
            return AIMessage(content="", tool_calls=[{
                "name": "write_preview_file",
                "args": {"path": "/src/App.tsx", "content": "export default function App() { return <h1>After</h1>; }"},
                "id": "preview-call-1",
            }])
        return AIMessage(content="虚拟页面已生成。")


class PreviewProjectToolTest(unittest.TestCase):
    def test_three_sources_use_existing_virtual_workspace(self):
        workspace = PreviewProjectWorkspace.from_request(template_snapshot())
        for path, content in {
            "/src/main.ts": "import * as THREE from 'three'; import './car';",
            "/src/car.ts": "import { Group } from 'three'; export const car = new Group();",
            "/index.html": '<title>汽车公路</title><script type="module" src="/src/main.ts"></script>',
        }.items():
            result = json.loads(workspace.write_file(path, content))
            self.assertTrue(result["success"])
            self.assertEqual(result["projectId"], "preview-test")
            self.assertEqual(json.loads(workspace.read_file(path))["content"], content)
        for path in ["/src/car.glb", "/src/car.obj", "/src/car.fbx"]:
            self.assertFalse(json.loads(workspace.write_file(path, "model"))["success"])

    def test_truncated_tool_call_is_not_executed_or_silently_accepted(self):
        class TruncatedModel:
            async def ainvoke(self, _messages, config=None):
                return AIMessage(content="", response_metadata={"finish_reason": "length"}, tool_calls=[{
                    "name": "write_preview_file", "args": {"path": "/src/main.ts", "content": "partial"}, "id": "cut",
                }])
        workspace = PreviewProjectWorkspace.from_request(template_snapshot())
        events = []
        with patch("agent.agent.model_with_tools", TruncatedModel()):
            asyncio.run(run_agent([{"role": "user", "content": "生成3D场景"}], events.append, preview_workspace=workspace))
        self.assertNotIn("/src/main.ts", workspace.files)
        self.assertTrue(any("截断" in e.get("content", "") for e in events))
        self.assertFalse(any(e.get("type") == "preview_file_changed" for e in events))

    def test_virtual_file_read_write_and_protected_paths(self):
        workspace = PreviewProjectWorkspace.from_request(template_snapshot())
        self.assertIsNotNone(workspace)
        self.assertIn("/src/App.tsx", json.loads(workspace.list_files())["files"])
        self.assertIn("Before", json.loads(workspace.read_file("/src/App.tsx"))["content"])
        result = json.loads(workspace.write_file("/src/App.tsx", "export default function App() { return <h1>After</h1>; }"))
        self.assertTrue(result["success"])
        self.assertIn("After", result["diff"])
        self.assertEqual(workspace.files["/src/App.tsx"], result["content"])
        for path in ["/src/../secret.ts", "/src/.env", "/src/node_modules/a.ts", "D:/Gor/Web/src/App.tsx", "/src/a.vue"]:
            with self.subTest(path=path):
                self.assertFalse(json.loads(workspace.write_file(path, "bad"))["success"])
        self.assertEqual(normalize_virtual_path("/src/components/Card.tsx"), "/src/components/Card.tsx")

    def test_request_snapshot_is_bounded(self):
        snapshot = template_snapshot()
        snapshot["files"]["/src/App.tsx"] = "x" * 100_001
        with self.assertRaises(ValueError):
            PreviewProjectWorkspace.from_request(snapshot)

    def test_default_chat_cannot_call_real_file_tools(self):
        result = asyncio.run(execute_tool("edit_project_file", {"path": "src/App.tsx", "old_text": "a", "new_text": "b"}))
        self.assertIn("未授权", result)

    def test_agent_emits_virtual_change_without_touching_disk(self):
        with tempfile.TemporaryDirectory() as directory:
            disk_file = Path(directory) / "App.tsx"
            disk_file.write_text("untouched", encoding="utf-8")
            workspace = PreviewProjectWorkspace.from_request(template_snapshot())
            events = []
            with patch("agent.agent.model_with_tools", FakeModel()):
                asyncio.run(run_agent(
                    [{"role": "user", "content": "生成一个 React 页面并预览"}],
                    events.append,
                    callbacks=[],
                    preview_workspace=workspace,
                ))
            changed = [event for event in events if event.get("type") == "preview_file_changed"]
            self.assertEqual(len(changed), 1)
            self.assertEqual(changed[0]["path"], "/src/App.tsx")
            self.assertIn("After", changed[0]["content"])
            self.assertEqual(disk_file.read_text(encoding="utf-8"), "untouched")
            self.assertFalse(any(event.get("type") == "project_file_changed" for event in events))


if __name__ == "__main__":
    unittest.main()
