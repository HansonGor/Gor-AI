"""VS Code workspace registration and small WebSocket RPC response router."""

from datetime import datetime, timezone
import json
import logging
import uuid
from typing import Any

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from services.vscode_bridge import WORKSPACE_CLIENTS, vscode_bridge


logger = logging.getLogger("gor.vscode")
router = APIRouter()

# Intentionally process-local for the first extension skeleton. This registry
# contains metadata only; it never reads or stores workspace source files.
active_workspaces: dict[str, dict[str, Any]] = {}


def _workspace_folders(value: Any) -> list[dict[str, str]]:
    if not isinstance(value, list):
        return []
    return [
        {
            "id": str(folder.get("id", ""))[:40],
            "name": str(folder.get("name", ""))[:255],
            "uri": str(folder.get("uri", ""))[:4096],
        }
        for folder in value[:50]
        if isinstance(folder, dict)
    ]


@router.websocket("/ws/vscode")
async def vscode_workspace_socket(websocket: WebSocket) -> None:
    await websocket.accept()
    workspace_id: str | None = None

    try:
        while True:
            raw_message = await websocket.receive_text()
            try:
                message = json.loads(raw_message)
            except json.JSONDecodeError:
                logger.warning("VSCode WebSocket received invalid JSON")
                continue

            if not isinstance(message, dict):
                continue

            if message.get("type") == "workspace_response":
                vscode_bridge.handle_response(message)
                continue
            if message.get("type") == "workspace_tree_changed":
                root = message.get("root")
                if not isinstance(root, str) or not root.startswith("root-"):
                    root = None
                vscode_bridge.invalidate_workspace_tree(workspace_id or "", root)
                continue
            if message.get("type") != "workspace_connected":
                continue

            workspace_name = str(message.get("workspaceName") or "")
            folders = _workspace_folders(message.get("workspaceFolders"))
            client = message.get("client") if message.get("client") in WORKSPACE_CLIENTS else "vscode"
            # 同一条连接内重复登记沿用原 ID；书斋用 desktop- 前缀，便于在日志和变更记录里与插件区分
            if workspace_id is None:
                workspace_id = f"{'desktop' if client == 'desktop' else 'vscode'}-{uuid.uuid4().hex}"

            generation = vscode_bridge.register_workspace(workspace_id, websocket, client)

            active_workspaces[workspace_id] = {
                "workspace_id": workspace_id,
                "connection": websocket,
                "workspace_name": workspace_name,
                "workspace_folders": folders,
                "client": client,
                "connected_at": datetime.now(timezone.utc).isoformat(),
                "generation": generation,
            }
            logger.info("Workspace connected: client=%s %s (%s)", client, workspace_name or "(unnamed)", workspace_id)
            await websocket.send_json({"type": "workspace_registered", "workspaceId": workspace_id})
    except WebSocketDisconnect:
        pass
    except Exception:
        logger.exception("VSCode WebSocket connection failed")
    finally:
        if workspace_id is not None:
            vscode_bridge.disconnect_workspace(workspace_id, websocket)
            current = active_workspaces.get(workspace_id)
            if current and current.get("connection") is websocket:
                active_workspaces.pop(workspace_id, None)
            logger.info("VSCode workspace disconnected: %s", workspace_id)
