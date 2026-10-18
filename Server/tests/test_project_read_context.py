import asyncio
import hashlib
import json
from copy import deepcopy
from unittest.mock import patch
import pytest

from langchain_core.messages import ToolMessage, AIMessage
from agent.project_read_context import ProjectReadContext
from agent import agent as agent_module
from project_api.preview_context import create_current_preview_project_api
from project_api.types import ProjectRef, ProjectAPIError
from services.preview.workspace import PreviewProjectWorkspace


def workspace(project="project"):
    return PreviewProjectWorkspace(project, "react", {"/src/App.tsx": "".join(
        f"export const item{i} = '{'unique' * 60}';\n" for i in range(1, 21))})


def read(cache, data, args=None):
    raw = json.dumps(data, ensure_ascii=False)
    message = ToolMessage(content=raw, tool_call_id="call")
    cache.observe("read_project_file", args or {"path": data.get("path")}, raw, message)
    return message, json.loads(message.content)


def test_same_version_and_overlap_keep_exact_original_and_full_range():
    target = workspace()
    api, ref = create_current_preview_project_api(target)
    cache = ProjectReadContext((api, ref))
    args = {"path": "/src/App.tsx", "start_line": 1, "end_line": 10}
    data = asyncio.run(api.read_file(ref, args["path"], 1, 10))
    before = deepcopy(data)
    first, a = read(cache, data, args)
    second, b = read(cache, data, args)
    assert b["cacheStatus"] == "hit" and b["segments"] == []
    assert b["references"] == [{"readRef": a["readRef"], "startLine": 1, "endLine": 10}]
    assert data == before
    overlap = asyncio.run(api.read_file(ref, args["path"], 8, 15))
    _, c = read(cache, overlap, {**args, "start_line": 8, "end_line": 15})
    assert c["cacheStatus"] == "partial"
    assert c["segments"][0]["startLine"] == 11
    assert c["segments"][0]["content"] == "".join(target.files[args["path"]].splitlines(keepends=True)[10:15])
    full = asyncio.run(api.read_file(ref, args["path"]))
    _, d = read(cache, full)
    assert d["range"] == {"startLine": 1, "endLine": 20}
    assert d["segments"][0]["startLine"] == 16
    assert cache.stats["saved_tokens"] > 1000
    assert a["content"] == data["content"]


def test_preflight_web_revision_changes_delete_recreate_and_unknown_validation():
    target = workspace()
    api, ref = create_current_preview_project_api(target)
    cache = ProjectReadContext((api, ref))
    first, _ = read(cache, asyncio.run(api.read_file(ref, "/src/App.tsx")))
    asyncio.run(cache.validate())
    assert "content" in json.loads(first.content)
    target.write_file("/src/App.tsx", target.files["/src/App.tsx"].replace("item1", "changed"))
    asyncio.run(cache.validate())
    assert json.loads(first.content)["cacheStatus"] == "invalidated"
    assert "content" not in json.loads(first.content)
    latest, latest_data = read(cache, asyncio.run(api.read_file(ref, "/src/App.tsx")))
    assert "changed" in latest_data["content"]
    target.files.pop("/src/App.tsx")
    asyncio.run(cache.validate())
    assert json.loads(latest.content)["cacheStatus"] == "invalidated"
    target.write_file("/src/App.tsx", "new source")
    _, new = read(cache, asyncio.run(api.read_file(ref, "/src/App.tsx")))
    assert new["content"] == "new source" and "references" not in new


def test_mutation_failure_is_not_write_permission_and_stale_expected_version_still_conflicts():
    target = workspace()
    api, ref = create_current_preview_project_api(target)
    cache = ProjectReadContext((api, ref))
    data = asyncio.run(api.read_file(ref, "/src/App.tsx"))
    first, _ = read(cache, data)
    read(cache, data)
    target.write_file("/src/other.ts", "export const other = 1;")
    result = asyncio.run(api.patch_file(ref, "/src/App.tsx", "item1", "changed", data["version"]))
    assert not result["success"] and result["code"] == "VERSION_CONFLICT"
    cache.observe("patch_project_file", {}, json.dumps(result), ToolMessage(content="", tool_call_id="patch"))
    assert json.loads(first.content)["cacheStatus"] == "invalidated"
    assert "item1" in target.files["/src/App.tsx"]


def test_no_cross_task_project_or_root_reuse_and_legacy_or_truncated_results_stay_raw():
    target = workspace()
    api, ref = create_current_preview_project_api(target)
    data = asyncio.run(api.read_file(ref, "/src/App.tsx"))
    cache = ProjectReadContext((api, ref))
    read(cache, data)
    _, new_task = read(ProjectReadContext((api, ref)), data)
    assert new_task["cacheStatus"] == "miss"
    _, second_root = read(cache, {**data, "root": "root-2"})
    assert second_root["cacheStatus"] == "miss"
    old = {key: value for key, value in data.items() if key != "readState"}
    for fallback in (old, {**data, "truncated": True}):
        _, response = read(cache, fallback)
        assert response == fallback


def test_vscode_dirty_version_hash_identity_and_validation_failure_invalidate():
    target = workspace()
    text = target.files["/src/App.tsx"]
    state = {"provider": "vscode", "identity": "file-id", "fileVersion": 7,
             "dirty": True, "contentHash": hashlib.sha256(text.encode()).hexdigest()}
    data = {"success": True, "path": "/src/App.tsx", "content": text,
            "totalLines": 20, "fileVersion": 7, "readState": state}
    class API:
        async def read_file(self, *_):
            return data
    api = API()
    cache = ProjectReadContext((api, ProjectRef("workspace", "vscode")))
    first, _ = read(cache, data)
    _, duplicate = read(cache, data)
    assert duplicate["cacheStatus"] == "hit"
    data["readState"] = {**state, "fileVersion": 8}
    asyncio.run(cache.validate())
    assert json.loads(first.content)["cacheStatus"] == "invalidated"
    next_read, _ = read(cache, data)
    data["readState"] = {**data["readState"], "dirty": False}
    asyncio.run(cache.validate())
    assert json.loads(next_read.content)["cacheStatus"] == "invalidated"
    last, _ = read(cache, data)
    async def failed(*_):
        raise ProjectAPIError("WORKSPACE_DISCONNECTED", "disconnected")
    api.read_file = failed
    asyncio.run(cache.validate())
    assert json.loads(last.content)["cacheStatus"] == "invalidated"
    assert cache.stats["validation_failures"] == 1


@pytest.mark.parametrize("vscode", [False, True])
def test_real_agent_duplicates_are_compact_but_callbacks_keep_complete_receipts(vscode):
    target = workspace()
    received, model_reads = [], []
    class Callback:
        def record_tool_call(self, name, result, **kwargs):
            if name == "read_preview_file" or name == "read_project_file":
                received.append(json.loads(result))
    class Model:
        calls = 0
        async def ainvoke(self, messages, config=None):
            self.calls += 1
            if self.calls < 3:
                return AIMessage(content="", tool_calls=[{"name": "read_project_file", "id": f"r{self.calls}",
                     "args": {"path": "/src/App.tsx"}}])
            model_reads.extend(json.loads(message.content) for message in messages if message.type == "tool")
            return AIMessage(content="已检查现有实现。")
    model = Model()
    web_api, web_ref = create_current_preview_project_api(target)
    class WorkspaceAPI:
        async def read_file(self, ref, path, start=None, end=None):
            data = await web_api.read_file(web_ref, path, start, end)
            data["readState"] = {"provider": "vscode", "identity": "connected-editor-file",
                                 "fileVersion": target.revision, "dirty": True,
                                 "contentHash": data["readState"]["contentHash"]}
            return data
    with patch.object(agent_module, "get_model_for_tools", return_value=model), \
         patch.object(agent_module, "TYPING_DELAY_MS", 0):
        asyncio.run(agent_module.run_agent([{"role": "user", "content": "读取 App.tsx 现有实现"}],
                    lambda _: None, preview_workspace=target if not vscode else None, callbacks=[Callback()],
                    vscode_client_mode=vscode,
                    vscode_project_context=(WorkspaceAPI(), ProjectRef("connected", "vscode")) if vscode else None))
    assert model_reads[0]["content"] == target.files["/src/App.tsx"]
    assert model_reads[1]["cacheStatus"] == "hit"
    assert model_reads[1]["segments"] == []
    assert len(received) == 2
    assert all(result["content"] == target.files["/src/App.tsx"] for result in received)


def test_unsolicited_changes_remove_all_old_references_before_model_call():
    target = workspace()
    api, ref = create_current_preview_project_api(target)
    cache = ProjectReadContext((api, ref))
    data = asyncio.run(api.read_file(ref, "/src/App.tsx", 1, 15))
    messages = [read(cache, data, {"start_line": 1, "end_line": 15})[0] for _ in range(3)]
    target.files["/src/App.tsx"] = target.files["/src/App.tsx"].replace("item20", "outside_range_edit")
    # Even the same project version cannot hide an out-of-range content change.
    asyncio.run(cache.validate())
    assert all(json.loads(message.content)["cacheStatus"] == "invalidated" for message in messages)
    assert all("unique" not in message.content for message in messages)


def test_empty_final_line_and_short_or_invalid_ranges_are_not_promoted_to_full_reads():
    target = workspace()
    api, ref = create_current_preview_project_api(target)
    cache = ProjectReadContext((api, ref))
    data = asyncio.run(api.read_file(ref, "/src/App.tsx", 5, 6))
    _, response = read(cache, data, {"start_line": 5, "end_line": 6})
    assert response["range"] == {"startLine": 5, "endLine": 6}
    assert len(cache.files[next(iter(cache.files))].lines) == 2
    malformed = {**data, "endLine": 9}
    _, unchanged = read(cache, malformed)
    assert unchanged == malformed
