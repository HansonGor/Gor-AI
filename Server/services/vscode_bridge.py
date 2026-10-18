"""Small request/response bridge to the currently connected VS Code Extension."""

import asyncio
import copy
import logging
import time
import uuid
from dataclasses import dataclass, field
from typing import Any

from project_api.types import ProjectAPIError


logger = logging.getLogger("gor.vscode.bridge")
DEFAULT_TIMEOUT_SECONDS = 10.0


@dataclass
class _WorkspaceConnection:
    websocket: Any
    generation: int
    send_lock: asyncio.Lock = field(default_factory=asyncio.Lock)


@dataclass
class _PendingRequest:
    workspace_id: str
    future: asyncio.Future[Any]


class VSCodeBridgeClient:
    """Owns active sockets and pending RPC futures; Providers never touch socket maps."""

    def __init__(self, timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS) -> None:
        self.timeout_seconds = timeout_seconds
        self._connections: dict[str, _WorkspaceConnection] = {}
        self._known_workspace_ids: set[str] = set()
        self._pending_requests: dict[str, _PendingRequest] = {}
        self._workspace_tree_cache: dict[tuple[str, int, str], dict[str, Any]] = {}
        self._workspace_tree_locks: dict[tuple[str, int, str], asyncio.Lock] = {}
        self._generation = 0

    def register_workspace(self, workspace_id: str, websocket: Any) -> int:
        self._generation += 1
        connection = _WorkspaceConnection(websocket=websocket, generation=self._generation)
        self._connections[workspace_id] = connection
        self._known_workspace_ids.add(workspace_id)
        self.invalidate_workspace_tree(workspace_id)
        return connection.generation

    def is_connected(self, workspace_id: str) -> bool:
        return workspace_id in self._connections

    def workspace_generation(self, workspace_id: str) -> int:
        connection = self._connections.get(workspace_id)
        if connection is None:
            self._raise_workspace_unavailable(workspace_id)
        return connection.generation

    async def get_workspace_tree(
        self,
        workspace_id: str,
        root: str | None,
        loader: Any,
        *,
        refresh: bool = False,
    ) -> dict[str, Any]:
        """Read one workspace tree per connection/root and reuse it until stale."""
        generation = self.workspace_generation(workspace_id)
        key = (workspace_id, generation, root or "")
        lock = self._workspace_tree_locks.setdefault(key, asyncio.Lock())
        async with lock:
            cached = self._workspace_tree_cache.get(key)
            if cached is not None and not refresh:
                return copy.deepcopy(cached)
            result = await loader()
            if not isinstance(result, dict) or result.get("success") is not True:
                raise ProjectAPIError("WORKSPACE_REQUEST_FAILED", "VS Code 工作区目录树响应无效。")
            self._workspace_tree_cache[key] = copy.deepcopy(result)
            return copy.deepcopy(result)

    def update_workspace_tree(self, workspace_id: str, root: str | None, update: Any) -> None:
        """Apply a known successful file/directory mutation to cached tree snapshots."""
        generation = self.workspace_generation(workspace_id)
        key = (workspace_id, generation, root or "")
        snapshot = self._workspace_tree_cache.get(key)
        if snapshot is not None:
            update(snapshot)

    def invalidate_workspace_tree(self, workspace_id: str, root: str | None = None) -> None:
        for key in tuple(self._workspace_tree_cache):
            if key[0] == workspace_id and (root is None or key[2] == root):
                self._workspace_tree_cache.pop(key, None)
        for key in tuple(self._workspace_tree_locks):
            if key[0] == workspace_id and (root is None or key[2] == root):
                lock = self._workspace_tree_locks.get(key)
                if lock is not None and not lock.locked():
                    self._workspace_tree_locks.pop(key, None)

    async def call(self, workspace_id: str, method: str, params: dict[str, Any],
                   timeout_seconds: float | None = None) -> Any:
        connection = self._connections.get(workspace_id)
        if connection is None:
            self._raise_workspace_unavailable(workspace_id)

        request_id = f"req-{uuid.uuid4().hex}"
        future = asyncio.get_running_loop().create_future()
        self._pending_requests[request_id] = _PendingRequest(workspace_id, future)
        request = {
            "type": "workspace_request",
            "requestId": request_id,
            "workspaceId": workspace_id,
            "method": method,
            "params": {**params, "workspaceVersion": connection.generation},
        }
        started = time.monotonic()
        if method == "project.applyPatches":
            patches = params.get("patches")
            patch_count = len(patches) if isinstance(patches, list) else 0
            logger.info("[VSCodeBridge] method=%s workspace=%s patches=%d", method, workspace_id, patch_count)
        elif method in {
            "project.createFile", "project.createDirectory", "project.deleteFile", "project.deleteDirectory",
        }:
            path = params.get("path")
            safe_path = path[:180] if isinstance(path, str) and path.startswith("/") and "\\" not in path and ":" not in path and ".." not in path.split("/") else ""
            operation = {
                "project.createFile": "create_file",
                "project.createDirectory": "create_directory",
                "project.deleteFile": "delete_file",
                "project.deleteDirectory": "delete_directory",
            }[method]
            logger.info("[VSCodeWorkspace] %s path=%s", operation, safe_path)
        else:
            logger.info("[VSCodeBridge] request=%s workspace=%s method=%s", request_id, workspace_id, method)
        try:
            async with connection.send_lock:
                if self._connections.get(workspace_id) is not connection:
                    raise ProjectAPIError("WORKSPACE_DISCONNECTED", "VS Code 工作区连接已断开。")
                await connection.websocket.send_json(request)
            result = await asyncio.wait_for(future, timeout=timeout_seconds or self.timeout_seconds)
            if method == "project.applyPatches" and isinstance(result, dict) and result.get("success") is True:
                changed_files = result.get("changedFiles", []) if isinstance(result, dict) else []
                logger.info(
                    "[VSCodeWorkspace] apply_patches success files=%d duration_ms=%d",
                    len(changed_files) if isinstance(changed_files, list) else 0,
                    int((time.monotonic() - started) * 1000),
                )
            logger.info(
                "[VSCodeBridge] response=%s success=true duration_ms=%d",
                request_id,
                int((time.monotonic() - started) * 1000),
            )
            return result
        except asyncio.TimeoutError as exc:
            logger.warning(
                "[VSCodeBridge] response=%s success=false code=WORKSPACE_REQUEST_TIMEOUT duration_ms=%d",
                request_id,
                int((time.monotonic() - started) * 1000),
            )
            raise ProjectAPIError("WORKSPACE_REQUEST_TIMEOUT", "VS Code 工作区请求超时，请重试。") from exc
        except ProjectAPIError as exc:
            if exc.code == "VERSION_CONFLICT":
                path = params.get("path")
                if not isinstance(path, str):
                    path = ""
                safe_path = path[:180] if path.startswith("/") and ".." not in path.split("/") else ""
                logger.warning("[VSCodeWorkspace] VERSION_CONFLICT path=%s", safe_path)
            logger.warning(
                "[VSCodeBridge] response=%s success=false code=%s duration_ms=%d",
                request_id,
                exc.code,
                int((time.monotonic() - started) * 1000),
            )
            raise
        except Exception as exc:
            raise ProjectAPIError("WORKSPACE_DISCONNECTED", "VS Code 工作区连接已断开。") from exc
        finally:
            self._pending_requests.pop(request_id, None)
            if not future.done():
                future.cancel()

    def handle_response(self, message: dict[str, Any]) -> bool:
        request_id = message.get("requestId")
        workspace_id = message.get("workspaceId")
        if not isinstance(request_id, str) or not isinstance(workspace_id, str):
            return False
        pending = self._pending_requests.get(request_id)
        if pending is None or pending.workspace_id != workspace_id or pending.future.done():
            return False

        if message.get("success") is True:
            pending.future.set_result(message.get("result"))
        else:
            error = message.get("error") if isinstance(message.get("error"), dict) else {}
            code = error.get("code") if isinstance(error.get("code"), str) else "WORKSPACE_REQUEST_FAILED"
            text = error.get("message") if isinstance(error.get("message"), str) else "VS Code 工作区请求失败。"
            details = error.get("details") if isinstance(error.get("details"), dict) else None
            pending.future.set_exception(ProjectAPIError(code, text, details))
        return True

    def disconnect_workspace(self, workspace_id: str, websocket: Any) -> None:
        connection = self._connections.get(workspace_id)
        if connection is None or connection.websocket is not websocket:
            return
        self._connections.pop(workspace_id, None)
        self.invalidate_workspace_tree(workspace_id)
        for pending in tuple(self._pending_requests.values()):
            if pending.workspace_id == workspace_id and not pending.future.done():
                pending.future.set_exception(
                    ProjectAPIError("WORKSPACE_DISCONNECTED", "VS Code 工作区连接已断开。")
                )

    def _raise_workspace_unavailable(self, workspace_id: str) -> None:
        if workspace_id in self._known_workspace_ids:
            raise ProjectAPIError("WORKSPACE_DISCONNECTED", "VS Code 工作区连接已断开。")
        raise ProjectAPIError("WORKSPACE_NOT_FOUND", "当前 VS Code 工作区未连接到 Gor。")


vscode_bridge = VSCodeBridgeClient()
