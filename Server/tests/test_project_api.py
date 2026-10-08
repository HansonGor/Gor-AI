import ast
import asyncio
import json
import unittest
from pathlib import Path

from project_api.api import ProjectAPI
from project_api.preview_context import create_current_preview_project_api
from project_api.registry import ProjectProviderRegistry
from project_api.resolver import resolve_current_project_ref
from project_api.types import ProjectAPIError, ProjectRef
from services.preview.workspace import PreviewProjectWorkspace
from tools.preview_project import execute_preview_tool


def workspace_fixture():
    return PreviewProjectWorkspace("preview-project-api", "react", {
        "/src/App.tsx": "<h1>Old</h1>\n<p>Keep</p>\n<h2>Also old</h2>\n",
        "/src/style.css": ".card { color: white; color: gray; }\n",
    })


class ProjectAPITest(unittest.TestCase):
    def test_project_ref_resolver_and_provider_registry_are_provider_neutral(self):
        self.assertEqual(resolve_current_project_ref("preview-1"), ProjectRef("preview-1", "preview"))
        self.assertIsNone(resolve_current_project_ref(None))
        registry = ProjectProviderRegistry()
        with self.assertRaises(ProjectAPIError) as error:
            registry.resolve("vscode")
        self.assertEqual(error.exception.code, "UNSUPPORTED_OPERATION")

    def test_preview_list_search_range_read_and_version_mapping(self):
        workspace = workspace_fixture()
        current = create_current_preview_project_api(workspace)
        self.assertIsNotNone(current)
        api, ref = current

        # A Web request registers only its current virtual Provider, not a second
        # host which could turn a malformed ref into a workspace operation.
        with self.assertRaises(ProjectAPIError):
            asyncio.run(api.get_capabilities(ProjectRef("vscode-registry-check", "vscode")))

        preview_capabilities = asyncio.run(api.get_capabilities(ref))
        self.assertFalse(preview_capabilities["createFile"])
        self.assertFalse(preview_capabilities["createDirectory"])
        self.assertFalse(preview_capabilities["deleteFile"])
        self.assertFalse(preview_capabilities["deleteDirectory"])
        preview_create = asyncio.run(api.create_file(ref, "/src/new.tsx", "export {};"))
        self.assertEqual(preview_create["code"], "UNSUPPORTED_OPERATION")
        self.assertNotIn("/src/new.tsx", workspace.files)

        listed = asyncio.run(api.list_files(ref))
        self.assertEqual(listed, {
            "success": True,
            "projectId": "preview-project-api",
            "files": ["/src/App.tsx", "/src/style.css"],
            "version": 0,
        })
        expected_search = json.loads(workspace.search_code("Old"))
        searched = asyncio.run(api.search_code(ref, "Old"))
        self.assertEqual(searched, expected_search)
        self.assertEqual(len(searched), 1)
        self.assertEqual(searched[0]["matchCount"], 2)
        self.assertEqual(searched[0]["matchLines"], [1, 3])

        read = asyncio.run(api.read_file(ref, "/src/App.tsx", 2, 2))
        self.assertEqual(read["content"], "<p>Keep</p>\n")
        self.assertEqual((read["startLine"], read["endLine"], read["totalLines"], read["version"]), (2, 2, 3, 0))
        self.assertNotIn("revision", read)
        self.assertEqual(asyncio.run(api.get_version(ref)), 0)

        # The legacy Tool boundary still speaks in revision and retains its template field.
        legacy_list = json.loads(asyncio.run(execute_preview_tool(workspace, "list_preview_files", {})))
        self.assertEqual(legacy_list["revision"], 0)
        self.assertEqual(legacy_list["template"], "react")
        self.assertNotIn("version", legacy_list)
        self.assertTrue(asyncio.run(api.get_capabilities(ref))["batchPatch"])

    def test_batch_patch_preserves_atomic_multi_file_multi_patch_behavior(self):
        workspace = workspace_fixture()
        api, ref = create_current_preview_project_api(workspace)
        patches = [
            {"path": "/src/App.tsx", "old_text": "<h1>Old</h1>", "new_text": "<h1>New</h1>"},
            {"path": "/src/App.tsx", "old_text": "<h2>Also old</h2>", "new_text": "<h2>New too</h2>"},
            {"path": "/src/style.css", "old_text": "color: white", "new_text": "color: violet"},
        ]
        result = asyncio.run(api.apply_patches(ref, patches, expected_version=0))
        self.assertTrue(result["success"], result)
        self.assertEqual((result["version"], result["patchCount"]), (1, 3))
        self.assertEqual({item["path"] for item in result["changedFiles"]}, {"/src/App.tsx", "/src/style.css"})
        self.assertIn("+<h1>New</h1>", result["diff"])
        self.assertIn("+<h2>New too</h2>", result["diff"])
        self.assertEqual(asyncio.run(api.get_version(ref)), 1)

        before = dict(workspace.files)
        failed = asyncio.run(api.apply_patches(ref, [
            {"path": "/src/App.tsx", "old_text": "<p>Keep</p>", "new_text": "<p>Changed</p>"},
            {"path": "/src/style.css", "old_text": "color", "new_text": "purple"},
        ], expected_version=1))
        self.assertFalse(failed["success"])
        self.assertEqual(failed["code"], "PATCH_TARGET_NOT_UNIQUE")
        self.assertEqual(workspace.files, before)
        self.assertEqual(workspace.revision, 1)

    def test_version_conflict_is_generic_inside_api_and_legacy_at_tool_boundary(self):
        workspace = workspace_fixture()
        api, ref = create_current_preview_project_api(workspace)
        generic = asyncio.run(api.patch_file(
            ref, "/src/App.tsx", "<p>Keep</p>", "<p>Changed</p>", expected_version=4
        ))
        self.assertEqual(generic["code"], "VERSION_CONFLICT")
        self.assertEqual(generic["version"], 0)
        self.assertNotIn("revision", generic)

        legacy = json.loads(asyncio.run(execute_preview_tool(workspace, "patch_preview_file", {
            "path": "/src/App.tsx",
            "old_text": "<p>Keep</p>",
            "new_text": "<p>Changed</p>",
            "expected_revision": 4,
        })))
        self.assertEqual(legacy["code"], "PATCH_REVISION_CONFLICT")
        self.assertEqual(legacy["revision"], 0)
        self.assertEqual(workspace.revision, 0)

    def test_api_provider_service_import_graph_has_no_tools_agent_db_or_langchain(self):
        server_root = Path(__file__).resolve().parents[1]
        paths = [
            *server_root.joinpath("project_api").rglob("*.py"),
            server_root / "services" / "preview_project_service.py",
            server_root / "services" / "preview" / "workspace.py",
        ]
        forbidden = ("tools", "agent", "routes", "db", "langchain")
        for path in paths:
            tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
            for node in ast.walk(tree):
                if isinstance(node, ast.Import):
                    imported = [item.name for item in node.names]
                elif isinstance(node, ast.ImportFrom):
                    imported = [node.module or ""]
                else:
                    continue
                for name in imported:
                    self.assertFalse(name.split(".")[0] in forbidden, f"{path} imports {name}")


if __name__ == "__main__":
    unittest.main()
