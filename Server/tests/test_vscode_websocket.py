import threading

from fastapi import FastAPI
from fastapi.testclient import TestClient

from routes.vscode import active_workspaces, router
from services.vscode_bridge import vscode_bridge


def test_workspace_connection_registers_and_cleans_up_metadata():
    app = FastAPI()
    app.include_router(router)

    with TestClient(app) as client:
        with client.websocket_connect("/ws/vscode") as socket:
            socket.send_json({
                "type": "workspace_connected",
                "client": "vscode",
                "workspaceName": "my-project",
                "workspaceFolders": [{
                    "name": "my-project",
                    "uri": "file:///D:/Projects/my-project",
                }],
            })

            response = socket.receive_json()
            workspace_id = response["workspaceId"]
            assert response == {"type": "workspace_registered", "workspaceId": workspace_id}
            assert workspace_id.startswith("vscode-")
            assert active_workspaces[workspace_id]["workspace_name"] == "my-project"
            assert active_workspaces[workspace_id]["workspace_folders"] == [{
                "id": "",
                "name": "my-project",
                "uri": "file:///D:/Projects/my-project",
            }]

        assert workspace_id not in active_workspaces


def test_workspace_rpc_round_trips_through_websocket_router():
    app = FastAPI()
    app.include_router(router)
    result = {}
    workspace_id_ref = {"value": None}

    @app.get("/test-workspace-read")
    async def request_workspace_read():
        return await vscode_bridge.call(
            workspace_id_ref["value"],
            "project.readFile",
            {"path": "/src/App.tsx", "startLine": 2, "endLine": 4},
        )

    with TestClient(app) as client:
        with client.websocket_connect("/ws/vscode") as socket:
            socket.send_json({
                "type": "workspace_connected",
                "client": "vscode",
                "workspaceName": "demo",
                "workspaceFolders": [{"id": "root-1", "name": "demo", "uri": "file:///private/demo"}],
            })
            registered = socket.receive_json()
            workspace_id_ref["value"] = registered["workspaceId"]

            def make_http_request():
                try:
                    result["response"] = client.get("/test-workspace-read")
                except Exception as error:  # surfaced on the test thread below
                    result["error"] = error

            request_thread = threading.Thread(target=make_http_request)
            request_thread.start()
            request = socket.receive_json()
            assert request["type"] == "workspace_request"
            assert request["method"] == "project.readFile"
            assert request["params"] == {
                "path": "/src/App.tsx",
                "startLine": 2,
                "endLine": 4,
                "workspaceVersion": active_workspaces[workspace_id_ref["value"]]["generation"],
            }
            socket.send_json({
                "type": "workspace_response",
                "requestId": request["requestId"],
                "workspaceId": workspace_id_ref["value"],
                "success": True,
                "result": {"success": True, "path": "/src/App.tsx", "content": "current buffer"},
            })
            request_thread.join(timeout=3)
            assert not request_thread.is_alive()
            assert "error" not in result, result.get("error")
            assert result["response"].json() == {
                "success": True,
                "path": "/src/App.tsx",
                "content": "current buffer",
            }
