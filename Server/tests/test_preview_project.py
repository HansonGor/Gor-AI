import asyncio
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from langchain_core.messages import AIMessage

from agent.agent import execute_tool, run_agent
from services.preview.workspace import PreviewProjectWorkspace, normalize_virtual_path
from tools.preview_project import execute_preview_tool


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


class FakeMultiPatchModel:
    def __init__(self):
        self.calls = 0

    async def ainvoke(self, _messages, config=None):
        self.calls += 1
        if self.calls == 1:
            return AIMessage(content="", tool_calls=[
                {"name": "search_preview_code", "args": {"query": "Before"}, "id": "search-1"},
                {"name": "search_preview_code", "args": {"query": "body {}"}, "id": "search-2"},
            ])
        return AIMessage(content="", tool_calls=[{
            "name": "batch_patch_preview_files",
            "args": {"expected_revision": 0, "patches": [
                {"path": "/src/App.tsx", "old_text": "Before", "new_text": "After"},
                {"path": "/src/style.css", "old_text": "body {}", "new_text": "body { color: violet; }"},
            ]},
            "id": "batch-patch-1",
        }])


class FakeSimpleBatchModel:
    def __init__(self):
        self.calls = 0

    async def ainvoke(self, messages, config=None):
        self.calls += 1
        self.assert_fast_context = any(
            getattr(message, "type", "") == "system" and "程序预检的 Preview 搜索结果" in str(message.content)
            for message in messages
        )
        return AIMessage(content="", tool_calls=[{
            "name": "batch_patch_preview_files",
            "args": {"expected_revision": 0, "patches": [{
                "path": "/src/App.tsx", "old_text": "React Demo", "new_text": "Gor Demo",
            }]},
            "id": "simple-batch-patch",
        }])


class PreviewProjectToolTest(unittest.TestCase):
    def test_search_merges_nearby_overlapping_snippets(self):
        source = "\n".join([
            "needle first",
            "needle second",
            "context 3",
            "context 4",
            "needle fifth",
            *[f"context {line}" for line in range(6, 20)],
            "needle distant",
        ])
        workspace = PreviewProjectWorkspace("preview-search-dedupe", "react", {"/src/App.tsx": source})
        results = json.loads(workspace.search_code("needle", max_results=20))
        self.assertEqual(len(results), 2)
        self.assertEqual(results[0]["matchLines"], [1, 2, 5])
        self.assertEqual(results[0]["matchCount"], 3)
        self.assertEqual(results[0]["startLine"], 1)
        self.assertEqual(results[0]["endLine"], 8)
        self.assertEqual(results[1]["matchLines"], [20])

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
        with patch("agent.agent.get_model_for_tools", return_value=TruncatedModel()):
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
        for path in ["/src/../secret.ts", "/src/.env", "/src/node_modules/a.ts", "D:/Gor/Web/src/App.tsx", "/src/a.glb", "/src/a.png"]:
            with self.subTest(path=path):
                self.assertFalse(json.loads(workspace.write_file(path, "bad"))["success"])
        self.assertEqual(normalize_virtual_path("/src/components/Card.tsx"), "/src/components/Card.tsx")

    def test_patch_is_language_agnostic_and_diff_is_local(self):
        sources = {
            "/src/App.tsx": "function App() {\n  const submit = () => {\n    send(input);\n    setLoading(false);\n  };\n  return <main>Keep</main>;\n}\n",
            "/src/styles.less": ".chat {\n  color: white;\n  border-radius: 12px;\n  background: rgba(10, 18, 40, 0.8);\n}\n.footer { color: gray; }\n",
            "/index.html": "<html>\n<body>\n<button>Send</button>\n<footer>Keep</footer>\n</body>\n</html>\n",
            "/src/config.json": '{"enabled": false, "theme": "dark"}\n',
            "/src/Panel.vue": "<template><p>Old</p></template>\n<script>const keep = true</script>\n",
            "/src/Widget.svelte": "<p>Old</p>\n<style>p { color: blue; }</style>\n",
            "/src/theme.scss": ".card { color: red; }\n",
            "/src/Example.astro": "<h1>Old</h1>\n",
        }
        workspace = PreviewProjectWorkspace("preview-test", "react", dict(sources))
        edits = [
            ("/src/App.tsx", "    setLoading(false);", "    setInput('');\n    setLoading(false);"),
            ("/src/styles.less", "border-radius: 12px;\n  background: rgba(10, 18, 40, 0.8);", "border-radius: 18px;\n  background: rgba(10, 18, 40, 0.65);"),
            ("/index.html", "<button>Send</button>", "<button disabled>Send</button>"),
            ("/src/config.json", '"enabled": false', '"enabled": true'),
            ("/src/Panel.vue", "<p>Old</p>", "<p>New</p>"),
            ("/src/Widget.svelte", "<p>Old</p>", "<p>New</p>"),
            ("/src/theme.scss", "color: red", "color: purple"),
            ("/src/Example.astro", "Old", "New"),
        ]
        for path, old_text, new_text in edits:
            with self.subTest(path=path):
                read = json.loads(asyncio.run(execute_preview_tool(workspace, "read_preview_file", {"path": path})))
                self.assertIn(old_text, read["content"])
                result = json.loads(asyncio.run(execute_preview_tool(workspace, "patch_preview_file", {
                    "path": path, "old_text": old_text, "new_text": new_text,
                    "expected_revision": read["revision"],
                })))
                self.assertTrue(result["success"], result)
                self.assertEqual(result["revision"], read["revision"] + 1)
                added_lines = [line[1:].strip() for line in result["diff"].splitlines() if line.startswith("+") and not line.startswith("+++")]
                removed_lines = [line[1:].strip() for line in result["diff"].splitlines() if line.startswith("-") and not line.startswith("---")]
                self.assertTrue(added_lines, result["diff"])
                if old_text not in new_text:
                    self.assertTrue(any(old_text.splitlines()[0].strip() in line for line in removed_lines), result["diff"])
                self.assertEqual(workspace.files[path], sources[path].replace(old_text, new_text, 1))
        self.assertNotIn("-function App()", workspace.diff_from_initial("/src/App.tsx"))
        self.assertNotIn("-.footer", workspace.diff_from_initial("/src/styles.less"))
        self.assertNotIn("-<footer>", workspace.diff_from_initial("/index.html"))

    def test_patch_failures_are_atomic_and_revision_blocks_stale_edits(self):
        workspace = PreviewProjectWorkspace("preview-test", "react", {"/src/App.tsx": "same\nsame\nkeep\n"})
        original = dict(workspace.files)
        for args, code in [
            ({"old_text": "missing", "new_text": "new"}, "PATCH_TARGET_NOT_FOUND"),
            ({"old_text": "same", "new_text": "new"}, "PATCH_TARGET_NOT_UNIQUE"),
            ({"old_text": "keep", "new_text": "new", "expected_revision": 9}, "PATCH_REVISION_CONFLICT"),
        ]:
            result = json.loads(workspace.patch_file("/src/App.tsx", **args))
            self.assertFalse(result["success"])
            self.assertEqual(result["code"], code)
            self.assertEqual(workspace.files, original)
            self.assertEqual(workspace.revision, 0)
        self.assertEqual(json.loads(workspace.patch_file("/src/absent.ts", "x", "y"))["code"], "PATCH_TARGET_NOT_FOUND")
        self.assertFalse(json.loads(workspace.patch_file("/src/image.png", "x", "y"))["success"])
        inserted = json.loads(workspace.patch_file("/src/App.tsx", "keep", "keep\nadded", 0))
        self.assertTrue(inserted["success"])
        self.assertEqual(json.loads(workspace.patch_file("/src/App.tsx", "added", "", 1))["success"], True)
        self.assertEqual(workspace.revision, 2)
        self.assertEqual(workspace.files["/src/App.tsx"], "same\nsame\nkeep\n\n")
        cumulative_diff = workspace.diff_from_initial("/src/App.tsx")
        self.assertIn("+", cumulative_diff)
        self.assertEqual(workspace.initial_files["/src/App.tsx"], original["/src/App.tsx"])
        created = json.loads(workspace.write_file("/src/new.ts", "export const value = 1;"))
        self.assertTrue(created["success"])
        self.assertEqual(created["revision"], 3)
        self.assertTrue(json.loads(workspace.write_file("/src/new.ts", "export const value = 2;"))["success"])

    def test_batch_patch_is_atomic_across_files_and_increments_once(self):
        workspace = PreviewProjectWorkspace("preview-test", "react", {
            "/src/App.tsx": "<h1>Before</h1>\n<p>Keep</p>\n",
            "/src/style.css": ".card { color: white; }\n",
        })
        original = dict(workspace.files)
        failed = json.loads(workspace.batch_patch_files([
            {"path": "/src/App.tsx", "old_text": "Before", "new_text": "After"},
            {"path": "/src/style.css", "old_text": "not-there", "new_text": "violet"},
        ], expected_revision=0))
        self.assertEqual(failed["code"], "PATCH_TARGET_NOT_FOUND")
        self.assertEqual(workspace.files, original)
        self.assertEqual(workspace.revision, 0)

        result = json.loads(workspace.batch_patch_files([
            {"path": "/src/App.tsx", "old_text": "Before", "new_text": "After"},
            {"path": "/src/style.css", "old_text": "color: white", "new_text": "color: violet"},
        ], expected_revision=0))
        self.assertTrue(result["success"], result)
        self.assertEqual(result["revision"], 1)
        self.assertEqual(result["patchCount"], 2)
        self.assertEqual({item["path"] for item in result["changedFiles"]}, set(original))
        self.assertNotIn("content", result)
        self.assertEqual(workspace.files["/src/App.tsx"], "<h1>After</h1>\n<p>Keep</p>\n")
        self.assertEqual(workspace.files["/src/style.css"], ".card { color: violet; }\n")

    def test_simple_literal_edit_uses_fast_search_and_one_llm_call(self):
        snapshot = template_snapshot()
        snapshot["files"]["/src/App.tsx"] = "export default function App() { return <h1>React Demo</h1>; }"
        workspace = PreviewProjectWorkspace.from_request(snapshot)
        events = []
        model = FakeSimpleBatchModel()
        from agent.token_callback import TokenCountCallback
        token_callback = TokenCountCallback()
        with patch("agent.agent.get_model_for_tools", return_value=model) as binding:
            asyncio.run(run_agent(
                [{"role": "user", "content": "把 React Demo 改成 Gor Demo"}], events.append,
                callbacks=[token_callback], preview_workspace=workspace,
            ))
        self.assertTrue({"web_search", "search_images"} <= set(binding.call_args.args[0]))
        self.assertEqual(model.calls, 1)
        self.assertTrue(model.assert_fast_context)
        self.assertIn("Gor Demo", workspace.files["/src/App.tsx"])
        self.assertEqual(token_callback.get_usage()["llm_call_count"], 1)
        self.assertEqual(token_callback.get_usage()["batch_patch_calls"], 1)
        self.assertEqual(token_callback.get_usage()["patch_operations"], 1)
        self.assertEqual(token_callback.get_usage()["search_queries"], ["React Demo"])
        self.assertEqual(token_callback.get_usage()["read_calls"], 0)
        self.assertEqual(workspace.revision, 1)

    def test_message_diff_accumulates_multiple_patches_to_one_file(self):
        workspace = PreviewProjectWorkspace("preview-test", "react", {"/src/App.tsx": "const first = 1;\nconst second = 2;\n"})
        self.assertTrue(json.loads(workspace.patch_file("/src/App.tsx", "first = 1", "first = 3", 0))["success"])
        self.assertTrue(json.loads(workspace.patch_file("/src/App.tsx", "second = 2", "second = 4", 1))["success"])
        diff = workspace.diff_from_initial("/src/App.tsx")
        for line in ("-const first = 1;", "+const first = 3;", "-const second = 2;", "+const second = 4;"):
            self.assertIn(line, diff)

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
            with patch("agent.agent.get_model_for_tools", return_value=FakeModel()):
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
            final_text = "".join(event.get("content", "") for event in events if event.get("type") == "token")
            self.assertIn("创建了一个 React 项目", final_text)
            self.assertIn("Diff", final_text)
            self.assertNotIn("/src/App.tsx", final_text)
            self.assertNotIn("After", final_text)
            self.assertNotIn("export default", final_text)

    def test_one_agent_turn_patches_two_files_in_one_project(self):
        workspace = PreviewProjectWorkspace.from_request(template_snapshot())
        previous_files = dict(workspace.files)
        events = []
        with patch("agent.agent.get_model_for_tools", return_value=FakeMultiPatchModel()), patch("agent.agent.MAX_ITERATIONS", 6):
            asyncio.run(run_agent(
                [{"role": "user", "content": "同时修改组件和样式"}], events.append,
                callbacks=[], preview_workspace=workspace,
            ))
        changed = [event for event in events if event.get("type") == "preview_file_changed"]
        self.assertEqual([event["path"] for event in changed], ["/src/App.tsx", "/src/style.css"])
        self.assertEqual([event["revision"] for event in changed], [1, 1])
        self.assertEqual({event["projectId"] for event in changed}, {"preview-test"})
        self.assertEqual(workspace.revision, 1)
        self.assertEqual(previous_files["/src/App.tsx"], "export default function App() { return <h1>Before</h1>; }")
        self.assertIn("After", workspace.files["/src/App.tsx"])
        self.assertIn("violet", workspace.files["/src/style.css"])
        self.assertEqual(workspace.initial_files, previous_files)


if __name__ == "__main__":
    unittest.main()
