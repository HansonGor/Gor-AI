"""Public vocabulary changes must not change provider execution or Preview sync."""

import asyncio
import json
from unittest.mock import patch

import pytest
from langchain_core.messages import AIMessage

from agent.agent import execute_tool, run_agent
from agent.token_callback import TokenCountCallback
from agent.tool_routing import route_request
from project_api.operations import PREVIEW_TOOL_ALIASES
from project_api.preview_context import create_current_preview_project_api
from project_api.types import ProjectRef
from services.preview.workspace import PreviewProjectWorkspace
from tools.index import TOOLS
from tools.project_api_tools import write_project_file, batch_patch_project_files


def workspace():
    return PreviewProjectWorkspace("shared-preview", "react", {
        "/index.html": '<div id="root"></div>',
        "/src/App.jsx": '<h1>Old</h1>\n<p>Keep</p>',
        "/src/style.css": 'color: red;',
    })


def execute(name, args, target, **kwargs):
    return json.loads(asyncio.run(execute_tool(name, args, preview_workspace=target, **kwargs)))


@pytest.mark.parametrize("alias,canonical", list(PREVIEW_TOOL_ALIASES.items()))
def test_legacy_preview_alias_and_public_tool_produce_identical_virtual_results(alias, canonical):
    args = {
        "path": "/src/App.jsx", "query": "Old", "content": '<h1>New</h1>',
        "old_text": "Old", "new_text": "New", "expected_revision": 0,
        "patches": [{"path": "/src/App.jsx", "old_text": "Old", "new_text": "New"}],
    }
    old_workspace, new_workspace = workspace(), workspace()
    old = execute(alias, args, old_workspace)
    new = execute(canonical, {**args, "expected_version": 0}, new_workspace)
    assert old_workspace.files == new_workspace.files
    assert old_workspace.revision == new_workspace.revision
    if isinstance(old, list):
        assert old == new
    else:
        assert old["success"] == new["success"]
        assert old.get("revision") == new.get("version")
        assert old.get("diff") == new.get("diff")
        assert old.get("changedFiles") == new.get("changedFiles")


def test_public_schemas_are_shared_and_include_common_version_arguments():
    assert "expected_version" in write_project_file.args
    assert "expected_file_version" in write_project_file.args
    assert "expected_version" in batch_patch_project_files.args
    assert len({tool.name for tool in TOOLS}) == len(TOOLS)
    assert not any(tool.name in PREVIEW_TOOL_ALIASES for tool in TOOLS)


def test_capabilities_filter_exposure_and_execution_without_changing_web_write_upsert():
    target = workspace()
    api, ref = create_current_preview_project_api(target)
    caps = asyncio.run(api.get_capabilities(ref))
    route = route_request("创建一个React项目", has_preview=True, project_capabilities=caps)
    assert "write_project_file" in route.tool_names
    assert "create_project_file" not in route.tool_names
    assert all(name not in PREVIEW_TOOL_ALIASES for name in route.tool_names)
    assert execute("create_project_file", {"path": "/new.txt"}, target)["code"] == "UNSUPPORTED_OPERATION"
    assert execute("delete_project_file", {"path": "/src/App.jsx"}, target)["code"] == "UNSUPPORTED_OPERATION"
    created = execute("write_project_file", {"path": "/new.txt", "content": "new", "expected_version": 0}, target)
    assert created["success"] and target.files["/new.txt"] == "new"
    assert created["provider"] == "preview"


def test_version_conflict_and_readonly_allowlist_never_mutate():
    target = workspace()
    initial = dict(target.files)
    for args in [{"expected_version": 9}, {"expected_version": 0, "expected_file_version": 2}]:
        result = execute("write_project_file", {"path": "/src/App.jsx", "content": "Wrong", **args}, target)
        assert result["code"] == "VERSION_CONFLICT"
    for name in ("write_project_file", "write_preview_file"):
        result = asyncio.run(execute_tool(name, {"path": "/src/App.jsx", "content": "Wrong"},
                                        preview_workspace=target, allowed_tool_names={"read_project_file"}))
        assert "未开放工具" in result
    assert target.files == initial and target.revision == 0


def test_plugin_precedence_rejects_all_preview_aliases_and_scene_even_with_stale_web_state():
    context = (object(), ProjectRef("vscode-test", "vscode"))
    target = workspace()
    for name in (*PREVIEW_TOOL_ALIASES, "set_3d_scene"):
        result = execute(name, {}, target, vscode_project_context=context)
        assert result["code"] == "UNSUPPORTED_OPERATION"
    assert target.revision == 0
    for name in ("search_project_files", "edit_project_file"):
        result = execute(name, {}, target, vscode_project_context=context, allow_workspace_edit=True)
        assert result["code"] == "UNSUPPORTED_OPERATION"


def test_generic_tool_uses_only_plugin_ref_and_per_file_batch_versions():
    class PluginAPI:
        async def get_capabilities(self, ref):
            assert ref == ProjectRef("vscode-current", "vscode", "root-1")
            return {"batchPatch": True}

        async def apply_patches(self, ref, patches, version):
            assert version is None  # never use connection generation as file version
            assert [item["expected_file_version"] for item in patches] == [3, 8]
            return {"success": True, "changedFiles": [{"path": item["path"]} for item in patches]}

    result = execute("batch_patch_project_files", {
        "root": "root-1", "patches": [
            {"path": "/a.ts", "old_text": "a", "new_text": "b", "expected_version": 3},
            {"path": "/b.ts", "old_text": "a", "new_text": "b", "expected_file_version": 8},
        ]}, workspace(), vscode_project_context=(PluginAPI(), ProjectRef("vscode-current", "vscode")))
    assert result["success"] and result["provider"] == "vscode"
    assert result["projectId"] == "vscode-current"


def test_cancelled_operation_does_not_write_or_dispatch():
    signal = asyncio.Event()
    signal.set()
    target = workspace()
    assert execute("write_project_file", {"path": "/src/App.jsx", "content": "Wrong"}, target,
                   signal=signal)["code"] == "OPERATION_CANCELLED"
    assert target.revision == 0


def test_common_fast_patch_preserves_preview_diff_revision_telemetry_and_concise_reply():
    class Model:
        async def ainvoke(self, messages, config=None):
            assert "batch_patch_project_files" in str(messages)
            return AIMessage(content="", tool_calls=[{
                "id": "patch", "name": "batch_patch_project_files", "args": {
                    "expected_version": 0,
                    "patches": [{"path": "/src/App.jsx", "old_text": "Old", "new_text": "New"}],
                },
            }])
    target, events, callback = workspace(), [], TokenCountCallback()
    with patch("agent.agent.model_with_simple_preview_edit", Model()), patch("agent.agent.get_model_for_tools", return_value=Model()), patch("agent.agent.TYPING_DELAY_MS", 0):
        asyncio.run(run_agent([{"role": "user", "content": "把页面标题从Old改成New"}], events.append,
                              preview_workspace=target, callbacks=[callback]))
    change = next(event for event in events if event["type"] == "preview_file_changed")
    assert change["content"] == target.files["/src/App.jsx"]
    assert change["revision"] == target.revision == 1
    assert '-<h1>Old</h1>' in change["diff"]
    assert '+<h1>New</h1>' in change["diff"]
    assert callback.batch_patch_calls == callback.patch_operations == 1
    assert callback.preview_tool_calls == 2
    assert not any(event["type"] == "project_file_changed" for event in events)
    prose = ''.join(event.get("content", "") for event in events if event["type"] == "token")
    assert 'Diff' in prose and '<h1>' not in prose


def test_common_generation_write_keeps_full_source_on_preview_sync_and_not_chat():
    class Model:
        async def ainvoke(self, messages, config=None):
            return AIMessage(content="", tool_calls=[{
                "id": "write", "name": "write_project_file",
                "args": {"path": "/index.html", "content": '<h1>New project</h1>'},
            }])
    target, events = PreviewProjectWorkspace("new-project", "html", {}), []
    with patch("agent.agent.get_model_for_tools", return_value=Model()), patch("agent.agent.TYPING_DELAY_MS", 0):
        asyncio.run(run_agent([{"role": "user", "content": "创建一个网页项目"}], events.append, preview_workspace=target))
    change = next(event for event in events if event["type"] == "preview_file_changed")
    assert change["projectId"] == "new-project" and change["revision"] == 1
    assert change["content"] == '<h1>New project</h1>'
    assert '<h1>' not in ''.join(event.get("content", "") for event in events if event["type"] == "token")
