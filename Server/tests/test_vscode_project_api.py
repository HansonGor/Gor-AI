import asyncio

import pytest

from project_api.api import ProjectAPI
from project_api.providers.vscode import VSCodeProjectProvider
from project_api.registry import ProjectProviderRegistry
from project_api.resolver import resolve_current_project_ref
from project_api.types import ProjectAPIError, ProjectRef
from services.vscode_bridge import VSCodeBridgeClient


class FakeSocket:
    def __init__(self):
        self.sent = []

    async def send_json(self, payload):
        self.sent.append(payload)


def create_api(bridge):
    registry = ProjectProviderRegistry()
    registry.register("vscode", VSCodeProjectProvider(bridge))
    return ProjectAPI(registry)


def test_vscode_project_ref_uses_workspace_id_and_provider():
    assert resolve_current_project_ref("vscode-workspace", "vscode") == ProjectRef(
        "vscode-workspace", "vscode"
    )


def test_list_search_and_range_read_round_trip_over_request_ids():
    async def scenario():
        bridge = VSCodeBridgeClient(timeout_seconds=0.5)
        socket = FakeSocket()
        bridge.register_workspace("vscode-test", socket)
        api = create_api(bridge)
        ref = ProjectRef("vscode-test", "vscode", root="root-1")

        listed = asyncio.create_task(api.list_files(ref))
        await asyncio.sleep(0)
        tree_request = socket.sent[0]
        assert tree_request["method"] == "project.listFiles"
        assert bridge.handle_response({
            "type": "workspace_response",
            "requestId": tree_request["requestId"],
            "workspaceId": tree_request["workspaceId"],
            "success": True,
            "result": {"success": True, "files": ["/src/App.tsx"], "directories": ["/src"]},
        })
        assert (await listed)["directories"] == ["/src"]

        calls = [
            asyncio.create_task(api.search_code(ref, "Counter", "/src", 5)),
            asyncio.create_task(api.read_file(ref, "/src/App.tsx", 3, 8)),
        ]
        await asyncio.sleep(0)
        requests = list(socket.sent[1:])
        assert [item["method"] for item in requests] == [
            "project.searchCode", "project.readFile"
        ]
        assert all(item["workspaceId"] == "vscode-test" for item in requests)
        assert all(item["requestId"].startswith("req-") for item in requests)
        assert requests[1]["params"]["root"] == "root-1"
        assert requests[0]["params"]["workspaceVersion"] == bridge.workspace_generation("vscode-test")
        assert requests[1]["params"]["startLine"] == 3
        assert requests[1]["params"]["endLine"] == 8

        payloads = [
            {"success": True, "result": {"success": True, "results": [{"path": "/src/App.tsx", "line": 4, "snippet": "Counter"}]}},
            {"success": True, "result": {"success": True, "path": "/src/App.tsx", "startLine": 3, "endLine": 8, "content": "Counter", "fileVersion": 9}},
        ]
        for request, response in zip(requests, payloads):
            assert bridge.handle_response({
                "type": "workspace_response",
                "requestId": request["requestId"],
                "workspaceId": request["workspaceId"],
                **response,
            })
        results = await asyncio.gather(*calls)
        assert results[0]["results"][0]["snippet"] == "Counter"
        assert results[1]["fileVersion"] == 9
        assert [item["method"] for item in socket.sent].count("project.listFiles") == 1

    asyncio.run(scenario())


def test_save_failure_preserves_receipt_through_rpc():
    async def scenario():
        bridge = VSCodeBridgeClient(timeout_seconds=0.5)
        socket = FakeSocket()
        bridge.register_workspace("vscode-save", socket)
        task = asyncio.create_task(bridge.call("vscode-save", "project.writeFile", {"path": "/src/App.tsx"}))
        await asyncio.sleep(0)
        request = socket.sent[-1]
        details = {"saved": False, "savedFiles": [],
                   "failedFiles": [{"path": "/src/App.tsx", "code": "FILE_SAVE_FAILED"}],
                   "changedFiles": [{"path": "/src/App.tsx", "diff": "-old\n+new"}]}
        bridge.handle_response({"type": "workspace_response", "requestId": request["requestId"],
                                "workspaceId": "vscode-save", "success": False,
                                "error": {"code": "FILE_SAVE_FAILED", "message": "保存失败", "details": details}})
        with pytest.raises(ProjectAPIError) as error:
            await task
        assert error.value.code == "FILE_SAVE_FAILED"
        assert error.value.details == details
    asyncio.run(scenario())


def test_bridge_timeout_and_disconnect_complete_pending_requests():
    async def scenario():
        timed = VSCodeBridgeClient(timeout_seconds=0.01)
        timed_socket = FakeSocket()
        timed.register_workspace("vscode-timeout", timed_socket)
        with pytest.raises(ProjectAPIError) as timeout_error:
            await timed.call("vscode-timeout", "project.listFiles", {})
        assert timeout_error.value.code == "WORKSPACE_REQUEST_TIMEOUT"

        disconnected = VSCodeBridgeClient(timeout_seconds=1)
        socket = FakeSocket()
        disconnected.register_workspace("vscode-disconnect", socket)
        task = asyncio.create_task(disconnected.call("vscode-disconnect", "project.readFile", {"path": "/src/App.tsx"}))
        await asyncio.sleep(0)
        disconnected.disconnect_workspace("vscode-disconnect", socket)
        with pytest.raises(ProjectAPIError) as error:
            await task
        assert error.value.code == "WORKSPACE_DISCONNECTED"

    asyncio.run(scenario())


def test_vscode_write_methods_round_trip_file_versions_without_source_echo():
    async def scenario():
        bridge = VSCodeBridgeClient(timeout_seconds=0.5)
        socket = FakeSocket()
        bridge.register_workspace("vscode-write", socket)
        api = create_api(bridge)
        ref = ProjectRef("vscode-write", "vscode", root="root-1")

        priming = asyncio.create_task(api.list_files(ref))
        await asyncio.sleep(0)
        tree_request = socket.sent[0]
        bridge.handle_response({
            "requestId": tree_request["requestId"], "workspaceId": tree_request["workspaceId"],
            "success": True, "result": {"success": True, "files": [], "directories": []},
        })
        await priming

        calls = [
            asyncio.create_task(api.patch_file(ref, "/src/App.tsx", "计数器", "计次器", 12)),
            asyncio.create_task(api.apply_patches(ref, [
                {"path": "/src/App.tsx", "old_text": "标题", "new_text": "新标题", "expected_file_version": 12},
                {"path": "/src/style.css", "old_text": "red", "new_text": "blue", "expected_file_version": 7},
            ])),
            asyncio.create_task(api.write_file(ref, "/src/test.ts", "export {};", 3)),
        ]
        await asyncio.sleep(0)
        requests = list(socket.sent[1:])
        assert [request["method"] for request in requests] == [
            "project.patchFile", "project.applyPatches", "project.writeFile",
        ]
        assert requests[0]["params"]["oldText"] == "计数器"
        assert requests[0]["params"]["newText"] == "计次器"
        assert requests[0]["params"]["expectedFileVersion"] == 12
        assert requests[0]["params"]["root"] == "root-1"
        assert requests[1]["params"]["patches"] == [
            {"path": "/src/App.tsx", "oldText": "标题", "newText": "新标题", "expectedFileVersion": 12, "root": "root-1"},
            {"path": "/src/style.css", "oldText": "red", "newText": "blue", "expectedFileVersion": 7, "root": "root-1"},
        ]
        assert requests[2]["params"]["expectedFileVersion"] == 3
        assert "content" in requests[2]["params"]

        for request in requests:
            bridge.handle_response({
                "requestId": request["requestId"],
                "workspaceId": request["workspaceId"],
                "success": True,
                "result": {"success": True, "changed": True, "diff": "--- a/src/App.tsx"},
            })
        results = await asyncio.gather(*calls)
        assert all(result["changed"] for result in results)

    asyncio.run(scenario())


def test_vscode_crud_methods_round_trip_over_expected_rpc_names():
    async def scenario():
        bridge = VSCodeBridgeClient(timeout_seconds=0.5)
        socket = FakeSocket()
        bridge.register_workspace("vscode-crud", socket)
        api = create_api(bridge)
        ref = ProjectRef("vscode-crud", "vscode", root="root-2")
        priming = asyncio.create_task(api.list_files(ref))
        await asyncio.sleep(0)
        tree_request = socket.sent[0]
        bridge.handle_response({
            "requestId": tree_request["requestId"], "workspaceId": tree_request["workspaceId"],
            "success": True, "result": {"success": True, "files": ["/src/Old.tsx"], "directories": ["/src"]},
        })
        await priming
        calls = [
            asyncio.create_task(api.create_file(ref, "/src/New.tsx", "export {};")),
            asyncio.create_task(api.create_directory(ref, "/src/demo")),
            asyncio.create_task(api.delete_file(ref, "/src/Old.tsx", 8)),
            asyncio.create_task(api.delete_directory(ref, "/src/empty", recursive=False)),
        ]
        await asyncio.sleep(0)
        requests = list(socket.sent[1:])
        assert [request["method"] for request in requests] == [
            "project.createFile", "project.createDirectory", "project.deleteFile", "project.deleteDirectory",
        ]
        assert requests[0]["params"] == {
            "path": "/src/New.tsx", "content": "export {};", "root": "root-2",
            "workspaceVersion": bridge.workspace_generation("vscode-crud"),
        }
        assert requests[1]["params"]["path"] == "/src/demo"
        assert requests[1]["params"]["root"] == "root-2"
        assert requests[2]["params"]["expectedFileVersion"] == 8
        assert requests[3]["params"]["recursive"] is False

        for request in requests:
            operation = request["method"]
            status = "created" if operation in {"project.createFile", "project.createDirectory"} else "deleted"
            bridge.handle_response({
                "requestId": request["requestId"],
                "workspaceId": request["workspaceId"],
                "success": True,
                "result": {"success": True, "path": request["params"]["path"], status: True},
            })
        results = await asyncio.gather(*calls)
        assert [result["path"] for result in results] == ["/src/New.tsx", "/src/demo", "/src/Old.tsx", "/src/empty"]
        cached = await api.list_files(ref)
        assert "/src/New.tsx" in cached["files"]
        assert "/src/demo" not in cached["files"]
        assert "/src/demo" in cached["directories"]
        assert [item["method"] for item in socket.sent].count("project.listFiles") == 1

    asyncio.run(scenario())


def test_path_conflict_refreshes_cached_tree_once_without_retrying_mutation():
    async def scenario():
        bridge = VSCodeBridgeClient(timeout_seconds=0.5)
        socket = FakeSocket()
        bridge.register_workspace("vscode-tree-conflict", socket)
        api = create_api(bridge)
        ref = ProjectRef("vscode-tree-conflict", "vscode", root="root-1")

        first_list = asyncio.create_task(api.list_files(ref))
        await asyncio.sleep(0)
        first_tree_request = socket.sent[0]
        bridge.handle_response({
            "requestId": first_tree_request["requestId"],
            "workspaceId": first_tree_request["workspaceId"],
            "success": True,
            "result": {"success": True, "files": ["/src/Old.tsx"], "directories": ["/src"]},
        })
        await first_list

        create = asyncio.create_task(api.create_file(ref, "/src/New.tsx", ""))
        await asyncio.sleep(0)
        create_request = socket.sent[1]
        bridge.handle_response({
            "requestId": create_request["requestId"],
            "workspaceId": create_request["workspaceId"],
            "success": False,
            "error": {"code": "FILE_ALREADY_EXISTS", "message": "文件已存在。"},
        })
        await asyncio.sleep(0)
        refresh_request = socket.sent[2]
        assert refresh_request["method"] == "project.listFiles"
        bridge.handle_response({
            "requestId": refresh_request["requestId"],
            "workspaceId": refresh_request["workspaceId"],
            "success": True,
            "result": {
                "success": True,
                "files": ["/src/New.tsx", "/src/Old.tsx"],
                "directories": ["/src"],
            },
        })
        with pytest.raises(ProjectAPIError) as error:
            await create
        assert error.value.code == "FILE_ALREADY_EXISTS"
        assert (await api.list_files(ref))["files"] == ["/src/New.tsx", "/src/Old.tsx"]
        assert [item["method"] for item in socket.sent].count("project.listFiles") == 2
        assert [item["method"] for item in socket.sent].count("project.createFile") == 1

    asyncio.run(scenario())


def test_vscode_provider_advertises_crud_but_not_privileged_capabilities():
    async def scenario():
        bridge = VSCodeBridgeClient()
        bridge.register_workspace("vscode-caps", FakeSocket())
        provider = VSCodeProjectProvider(bridge)
        capabilities = await provider.get_capabilities(ProjectRef("vscode-caps", "vscode"))
        assert capabilities == {
            "listFiles": True,
            "searchCode": True,
            "rangeRead": True,
            "patch": True,
            "batchPatch": True,
            "write": True,
            "createFile": True,
            "createDirectory": True,
            "deleteFile": True,
            "deleteDirectory": True,
            "recursiveDelete": False,
            "build": False,
            "diagnostics": False,
            "terminal": False,
            # git 仅开放 status/commit/push，提交与推送由扩展弹窗确认；终端与构建仍不开放
            "git": True,
            # 工具链只开放验证类命令，执行前由扩展按审阅模式确认；不等于开放任意终端
            "toolchain": True,
        }
        assert capabilities["terminal"] is False
        assert capabilities["build"] is False

    asyncio.run(scenario())
