"""遥斋：同账号的 Web（PC 与手机）经后端中转，远程操控桌面端「书斋」。

- 书斋登记（/ws/vscode，client=desktop）时带上桌面端的登录凭证、本机设备 ID 与「允许网页遥控」开关；
  服务端据此把书斋绑定到账号。未登录的书斋只能本机使用，不出现在遥斋列表里。
- 网页拿到的不是真实工作区 ID，而是按「账号 + 桌面设备 + 文件夹」算出的遥斋 ID（remote-…）：
  真实工作区 ID 仍只有桌面页面知道，桌面本机的请求行为不变；遥斋 ID 每次使用都要校验账号、开关与是否被断开。
- 施行审阅（命令审阅与删除确认）由桌面端转来，按账号的 :desktop 命名空间推给网页；网页的回答经接口转回桌面端。
- 当前后端单进程，状态放在内存；离线的书斋保留到后端重启，便于列表显示「离线」。
"""
import hashlib
import time
from dataclasses import dataclass, field
from typing import Any

from services.auth import ACCOUNT_PREFIX, DESKTOP_SUFFIX
from services.chat_runs import hub

# 网页超过这么久没有任何动作（心跳、发送、回答审阅），就不再算作「正在遥控」
CLIENT_TTL_SECONDS = 180
MAX_CLIENTS = 20
# 网页可以转给桌面端的施行消息；打开本机地址只对桌面本机有意义，不转发
PAGE_MESSAGE_TYPES = ("gor.toolchainApprovalShown", "gor.toolchainApprovalAnswer", "gor.toolchainCancel")
MAX_PAGE_MESSAGE_CHARS = 6_000
# 每个书斋最多记住这么多条尚未回答的审阅（供稍后打开的网页补上卡片）
MAX_PENDING_APPROVALS = 20


class RemoteAccessError(Exception):
    """遥斋不可用的原因（面向用户的中文说明）。"""


def remote_namespace(account_id: str) -> str:
    """遥斋与桌面书斋共用一份会话与同步通道：user:<账号ID>:desktop。"""
    return f"{ACCOUNT_PREFIX}{account_id}{DESKTOP_SUFFIX}"


def remote_id_for(account_id: str, device_id: str, folder_path: str) -> str:
    digest = hashlib.sha256(f"{account_id}\n{device_id}\n{folder_path.lower()}".encode("utf-8")).hexdigest()
    return f"remote-{digest[:32]}"


def _text(value: Any, limit: int) -> str:
    return value.strip()[:limit] if isinstance(value, str) else ""


@dataclass
class RemoteClient:
    client_id: str
    label: str
    last_active: float


@dataclass
class RemoteWorkspace:
    remote_id: str
    account_id: str
    device_id: str
    device_name: str
    name: str
    path: str
    remote_allowed: bool
    workspace_id: str | None
    websocket: Any = None
    online: bool = True
    clients: dict[str, RemoteClient] = field(default_factory=dict)
    # 被桌面端「断开」的网页；关掉再打开开关时清空
    revoked: set[str] = field(default_factory=set)
    # 尚未回答的审阅（approvalId → gor.toolchain approval 消息）：手机稍后打开或重新载入时补上卡片
    pending: dict[str, dict[str, Any]] = field(default_factory=dict)

    def pending_approvals(self, now: float | None = None) -> list[dict[str, Any]]:
        now_ms = (time.time() if now is None else now) * 1000
        for approval_id, message in list(self.pending.items()):
            deadline = (message.get("request") or {}).get("deadline")
            if isinstance(deadline, (int, float)) and deadline < now_ms:
                self.pending.pop(approval_id, None)
        return list(self.pending.values())

    def active_clients(self, now: float | None = None) -> list[RemoteClient]:
        now = time.time() if now is None else now
        return [client for client in self.clients.values() if now - client.last_active <= CLIENT_TTL_SECONDS]

    def public(self) -> dict[str, Any]:
        return {
            "remoteId": self.remote_id,
            "deviceName": self.device_name,
            "name": self.name,
            "path": self.path,
            "online": self.online,
            "remoteAllowed": self.remote_allowed,
        }


class RemoteShuzhaiRegistry:
    def __init__(self) -> None:
        self._workspaces: dict[str, RemoteWorkspace] = {}
        self._by_workspace_id: dict[str, str] = {}
        # 把在线设备列表发给桌面端；由 routes/vscode 注入（需要异步发送 WebSocket）
        self.client_list_sender: Any = None

    # ---------- 桌面端登记 ----------

    def register(self, workspace_id: str, websocket: Any, account_id: str | None, message: dict[str, Any]) -> RemoteWorkspace | None:
        """书斋登记或更新（登录状态、开关变化时桌面端会重新发送登记）。未登录返回 None 并解除原绑定。"""
        previous_id = self._by_workspace_id.pop(workspace_id, None)
        device_id = _text(message.get("deviceId"), 80)
        folder_path = _text(message.get("folderPath"), 1024)
        if not account_id or not device_id or not folder_path:
            if previous_id and previous_id in self._workspaces:
                self._go_offline(self._workspaces[previous_id])
            return None
        remote_id = remote_id_for(account_id, device_id, folder_path)
        if previous_id and previous_id != remote_id and previous_id in self._workspaces:
            self._go_offline(self._workspaces[previous_id])
        allowed = message.get("remoteAllowed") is True
        entry = self._workspaces.get(remote_id)
        if entry is None:
            entry = RemoteWorkspace(
                remote_id=remote_id, account_id=account_id, device_id=device_id,
                device_name="", name="", path=folder_path, remote_allowed=False, workspace_id=workspace_id,
            )
            self._workspaces[remote_id] = entry
        if not allowed or not entry.remote_allowed:
            # 每次重新打开开关都是新的授权：之前被断开的网页可以重新连接，旧的在线记录也作废
            entry.revoked.clear()
            if not allowed:
                entry.clients.clear()
                entry.pending.clear()
        was_allowed = entry.remote_allowed
        entry.device_name = _text(message.get("deviceName"), 80) or "未命名电脑"
        entry.name = _text(message.get("workspaceName"), 255) or folder_path
        entry.path = folder_path
        entry.remote_allowed = allowed
        entry.workspace_id = workspace_id
        entry.websocket = websocket
        entry.online = True
        self._by_workspace_id[workspace_id] = remote_id
        self._publish_list(account_id)
        if was_allowed and not allowed:
            hub.publish(remote_namespace(account_id), {"type": "remote_revoked", "remoteId": remote_id, "reason": "disabled"})
        return entry

    def disconnect(self, workspace_id: str, websocket: Any) -> None:
        remote_id = self._by_workspace_id.get(workspace_id)
        entry = self._workspaces.get(remote_id or "")
        if entry is None or entry.websocket is not websocket:
            return
        self._by_workspace_id.pop(workspace_id, None)
        self._go_offline(entry)

    def _go_offline(self, entry: RemoteWorkspace) -> None:
        entry.online = False
        entry.websocket = None
        entry.workspace_id = None
        entry.clients.clear()
        entry.pending.clear()
        self._publish_list(entry.account_id)

    def entry_for_workspace(self, workspace_id: str) -> RemoteWorkspace | None:
        return self._workspaces.get(self._by_workspace_id.get(workspace_id, ""))

    def revoke(self, workspace_id: str, client_id: str) -> RemoteWorkspace | None:
        """桌面端点了某台设备的「断开」：该设备在本次开关期间不能再遥控。"""
        entry = self.entry_for_workspace(workspace_id)
        client_id = _text(client_id, 80)
        if entry is None or not client_id:
            return None
        entry.clients.pop(client_id, None)
        entry.revoked.add(client_id)
        hub.publish(remote_namespace(entry.account_id), {
            "type": "remote_revoked", "remoteId": entry.remote_id, "deviceId": client_id, "reason": "kicked",
        })
        return entry

    # ---------- 网页访问 ----------

    def list_for(self, account_id: str) -> list[dict[str, Any]]:
        items = [entry for entry in self._workspaces.values() if entry.account_id == account_id]
        # 在线在前，同状态按名称排序
        items.sort(key=lambda entry: (not entry.online, entry.device_name, entry.name))
        return [entry.public() for entry in items]

    def authorize(self, remote_id: str, account_id: str | None, device_id: str | None) -> RemoteWorkspace:
        """校验网页能否遥控该书斋；不能时抛出带原因的 RemoteAccessError。"""
        if not account_id:
            raise RemoteAccessError("遥斋需要先登录。")
        entry = self._workspaces.get(remote_id or "")
        if entry is None or entry.account_id != account_id:
            raise RemoteAccessError("找不到这个书斋，请在遥斋列表里重新选择。")
        if not entry.online or not entry.workspace_id:
            raise RemoteAccessError(f"{entry.device_name} 当前离线，请确认电脑上的 Gor 已打开该书斋。")
        if not entry.remote_allowed:
            raise RemoteAccessError(f"{entry.device_name} 未允许网页遥控，请在电脑的书斋弹层里打开「允许网页遥控此书斋」。")
        device_id = _text(device_id, 80)
        if not device_id:
            raise RemoteAccessError("缺少设备标识，请刷新页面后重试。")
        if device_id in entry.revoked:
            raise RemoteAccessError(f"{entry.device_name} 已断开这台设备的遥控。")
        return entry

    def touch(self, entry: RemoteWorkspace, device_id: str, label: str | None = None) -> None:
        """记录网页的活动；在线设备列表有变化时通知桌面端。"""
        now = time.time()
        before = {client.client_id for client in entry.active_clients(now)}
        client = entry.clients.get(device_id)
        if client is None:
            if len(entry.clients) >= MAX_CLIENTS:
                oldest = min(entry.clients.values(), key=lambda item: item.last_active)
                entry.clients.pop(oldest.client_id, None)
            client = RemoteClient(client_id=device_id, label=_text(label, 80) or "网页", last_active=now)
            entry.clients[device_id] = client
        else:
            client.last_active = now
            if label:
                client.label = _text(label, 80) or client.label
        if {item.client_id for item in entry.active_clients(now)} != before:
            self.clients_changed(entry)

    def detach(self, entry: RemoteWorkspace, device_id: str) -> None:
        if entry.clients.pop(_text(device_id, 80), None) is not None:
            self.clients_changed(entry)

    def clients_changed(self, entry: RemoteWorkspace) -> None:
        """告诉桌面端当前正在遥控的设备。"""
        sender = self.client_list_sender
        if sender and entry.websocket is not None:
            sender(entry.websocket, self.client_list(entry))

    def client_list(self, entry: RemoteWorkspace) -> list[dict[str, Any]]:
        return [
            {"id": client.client_id, "label": client.label, "lastActive": int(client.last_active * 1000)}
            for client in sorted(entry.active_clients(), key=lambda item: -item.last_active)
        ]

    # ---------- 施行审阅转发 ----------

    def publish_toolchain(self, workspace_id: str, message: Any) -> bool:
        """桌面端转来的施行消息推给同账号的遥斋网页；未开启遥控时不推。"""
        entry = self.entry_for_workspace(workspace_id)
        if entry is None or not entry.remote_allowed or not isinstance(message, dict) or message.get("type") != "gor.toolchain":
            return False
        self._track_pending(entry, message)
        hub.publish(remote_namespace(entry.account_id), {"type": "remote_toolchain", "remoteId": entry.remote_id, "message": message})
        return True

    @staticmethod
    def _track_pending(entry: RemoteWorkspace, message: dict[str, Any]) -> None:
        kind = message.get("kind")
        if kind == "approval" and isinstance(message.get("request"), dict):
            approval_id = message["request"].get("approvalId")
            if isinstance(approval_id, str) and approval_id:
                entry.pending[approval_id] = message
                while len(entry.pending) > MAX_PENDING_APPROVALS:
                    entry.pending.pop(next(iter(entry.pending)))
        elif kind == "withdrawn":
            entry.pending.pop(str(message.get("approvalId") or ""), None)
        elif kind == "update" and isinstance(message.get("update"), dict):
            update = message["update"]
            if update.get("status") != "awaiting_approval":
                run_id = update.get("runId")
                entry.pending.pop(str(update.get("approvalId") or ""), None)
                for approval_id, item in list(entry.pending.items()):
                    if (item.get("request") or {}).get("runId") == run_id:
                        entry.pending.pop(approval_id, None)

    def _publish_list(self, account_id: str) -> None:
        hub.publish(remote_namespace(account_id), {"type": "remote_workspaces_changed"})

    def reset(self) -> None:
        self._workspaces.clear()
        self._by_workspace_id.clear()


def page_message(value: Any) -> dict[str, Any] | None:
    """网页发来的施行回答：只放行审阅相关的三种消息，字段逐项取用。"""
    if not isinstance(value, dict) or value.get("type") not in PAGE_MESSAGE_TYPES:
        return None
    message: dict[str, Any] = {"type": value["type"]}
    for key in ("approvalId", "runId", "answer"):
        if isinstance(value.get(key), str):
            message[key] = value[key][:200]
    if isinstance(value.get("message"), str):
        message["message"] = value["message"][:MAX_PAGE_MESSAGE_CHARS]
    return message


remote_shuzhai = RemoteShuzhaiRegistry()
