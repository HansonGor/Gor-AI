from fastapi import FastAPI
from fastapi.testclient import TestClient

from routes.vscode import active_workspaces, router


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
                "name": "my-project",
                "uri": "file:///D:/Projects/my-project",
            }]

        assert workspace_id not in active_workspaces
