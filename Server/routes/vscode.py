"""Minimal in-memory WebSocket registration for Gor's VS Code extension."""

from datetime import datetime, timezone
import json
import logging
import uuid
from typing import Any

from fastapi import APIRouter, WebSocket, WebSocketDisconnect


logger = logging.getLogger("gor.vscode")
router = APIRouter()

# Intentionally process-local for the first extension skeleton. This registry
# contains metadata only; it never reads or stores workspace source files.
active_workspaces: dict[str, dict[str, Any]] = {}


def _workspace_folders(value: Any) -> list[dict[str, str]]:
    if not isinstance(value, list):
        return []
    return [
        {"name": str(folder.get("name", "")), "uri": str(folder.get("uri", ""))}
        for folder in value
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

            if not isinstance(message, dict) or message.get("type") != "workspace_connected":
                continue

            workspace_name = str(message.get("workspaceName") or "")
            folders = _workspace_folders(message.get("workspaceFolders"))
            if workspace_id is None:
                workspace_id = f"vscode-{uuid.uuid4().hex[:8]}"

            active_workspaces[workspace_id] = {
                "workspace_id": workspace_id,
                "connection": websocket,
                "workspace_name": workspace_name,
                "workspace_folders": folders,
                "connected_at": datetime.now(timezone.utc).isoformat(),
            }
            logger.info("VSCode workspace connected: %s (%s)", workspace_name or "(unnamed)", workspace_id)
            await websocket.send_json({"type": "workspace_registered", "workspaceId": workspace_id})
    except WebSocketDisconnect:
        pass
    except Exception:
        logger.exception("VSCode WebSocket connection failed")
    finally:
        if workspace_id is not None:
            active_workspaces.pop(workspace_id, None)
            logger.info("VSCode workspace disconnected: %s", workspace_id)
