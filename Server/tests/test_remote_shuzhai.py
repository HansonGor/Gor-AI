"""遥斋：书斋绑定账号与远程开关、网页只拿遥斋 ID、施行审阅经后端转发（全部离线）。"""
import asyncio
import importlib
import json
import unittest
from unittest.mock import AsyncMock, patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from db import auth as auth_db
from routes.remote import router as remote_router
from routes.vscode import router as vscode_router
from services.chat_runs import hub
from services.remote_shuzhai import RemoteAccessError, page_message, remote_id_for, remote_namespace, remote_shuzhai

chat_module = importlib.import_module("routes.chat")
USER = {"id": "acc-1", "email": "a@example.com", "nickname": "樺"}
OTHER = {"id": "acc-2", "email": "b@example.com", "nickname": "乙"}
FOLDER = "D:\\work\\my-app"


class FakeSocket:
    def __init__(self):
        self.sent = []

    async def send_json(self, payload):
        self.sent.append(payload)


def _register(workspace_id="desktop-1", account="acc-1", allowed=True, socket=None, device="dev-pc", folder=FOLDER):
    return remote_shuzhai.register(workspace_id, socket or FakeSocket(), account, {
        "deviceId": device, "deviceName": "Gor-PC", "workspaceName": "my-app",
        "folderPath": folder, "remoteAllowed": allowed,
    })


@pytest.fixture(autouse=True)
def _clean_registry():
    remote_shuzhai.reset()
    yield
    remote_shuzhai.reset()


def test_unlogged_shuzhai_is_local_only():
    assert _register(account=None) is None
    assert remote_shuzhai.list_for("acc-1") == []


def test_remote_id_is_stable_and_hides_the_real_workspace_id():
    first = _register("desktop-1")
    again = _register("desktop-2")  # 断线重连后真实工作区 ID 变了
    assert first.remote_id == again.remote_id == remote_id_for("acc-1", "dev-pc", FOLDER)
    listed = remote_shuzhai.list_for("acc-1")
    assert listed == [{"remoteId": first.remote_id, "deviceName": "Gor-PC", "name": "my-app", "path": FOLDER,
                       "online": True, "remoteAllowed": True}]
    assert "desktop-2" not in json.dumps(listed), "网页拿不到真实工作区 ID"


def test_authorize_checks_login_account_switch_device_and_online_state():
    entry = _register(allowed=False)
    with pytest.raises(RemoteAccessError, match="未允许网页遥控"):
        remote_shuzhai.authorize(entry.remote_id, "acc-1", "phone")
    _register(allowed=True)
    assert remote_shuzhai.authorize(entry.remote_id, "acc-1", "phone").workspace_id == "desktop-1"
    with pytest.raises(RemoteAccessError, match="先登录"):
        remote_shuzhai.authorize(entry.remote_id, None, "phone")
    with pytest.raises(RemoteAccessError, match="找不到"):
        remote_shuzhai.authorize(entry.remote_id, "acc-2", "phone")
    with pytest.raises(RemoteAccessError, match="设备标识"):
        remote_shuzhai.authorize(entry.remote_id, "acc-1", "")
    remote_shuzhai.disconnect("desktop-1", entry.websocket)
    with pytest.raises(RemoteAccessError, match="离线"):
        remote_shuzhai.authorize(entry.remote_id, "acc-1", "phone")
    assert remote_shuzhai.list_for("acc-1")[0]["online"] is False, "离线的书斋仍在列表里显示为离线"


def test_kicked_device_stays_out_until_the_switch_is_turned_on_again():
    entry = _register()
    remote_shuzhai.touch(entry, "phone", "iPhone · Safari")
    remote_shuzhai.revoke("desktop-1", "phone")
    with pytest.raises(RemoteAccessError, match="已断开"):
        remote_shuzhai.authorize(entry.remote_id, "acc-1", "phone")
    assert remote_shuzhai.authorize(entry.remote_id, "acc-1", "laptop"), "只断开被点的那台设备"
    _register(allowed=True)
    with pytest.raises(RemoteAccessError, match="已断开"):
        remote_shuzhai.authorize(entry.remote_id, "acc-1", "phone")
    _register(allowed=False)
    _register(allowed=True)
    assert remote_shuzhai.authorize(entry.remote_id, "acc-1", "phone"), "关掉再打开开关是新的授权"


def test_turning_the_switch_off_clears_clients_and_tells_the_web():
    queue = hub.subscribe(remote_namespace("acc-1"))
    try:
        entry = _register()
        remote_shuzhai.touch(entry, "phone", "iPhone")
        _register(allowed=False)
        events = [queue.get_nowait() for _ in range(queue.qsize())]
        assert {"type": "remote_revoked", "remoteId": entry.remote_id, "reason": "disabled"} in events
        assert entry.clients == {}
        assert events.count({"type": "remote_workspaces_changed"}) == 2
    finally:
        hub.unsubscribe(remote_namespace("acc-1"), queue)


def test_toolchain_messages_reach_only_the_owner_namespace_when_allowed():
    mine = hub.subscribe(remote_namespace("acc-1"))
    theirs = hub.subscribe(remote_namespace("acc-2"))
    try:
        entry = _register()
        while not mine.empty():
            mine.get_nowait()
        message = {"type": "gor.toolchain", "kind": "approval", "request": {"runId": "r1", "approvalId": "a1"}}
        assert remote_shuzhai.publish_toolchain("desktop-1", message)
        assert mine.get_nowait() == {"type": "remote_toolchain", "remoteId": entry.remote_id, "message": message}
        assert theirs.empty()
        assert not remote_shuzhai.publish_toolchain("desktop-1", {"type": "other"})
        _register(allowed=False)
        assert not remote_shuzhai.publish_toolchain("desktop-1", message), "关掉开关后不再推给网页"
    finally:
        hub.unsubscribe(remote_namespace("acc-1"), mine)
        hub.unsubscribe(remote_namespace("acc-2"), theirs)


def test_page_messages_are_limited_to_approval_answers():
    assert page_message({"type": "gor.toolchainApprovalAnswer", "approvalId": "a1", "answer": "approve", "extra": 1}) == {
        "type": "gor.toolchainApprovalAnswer", "approvalId": "a1", "answer": "approve"}
    assert page_message({"type": "gor.toolchainCancel", "runId": "r1"}) == {"type": "gor.toolchainCancel", "runId": "r1"}
    assert page_message({"type": "gor.toolchainOpenUrl", "url": "http://localhost:5173"}) is None, "不让网页在电脑上打开地址"
    assert page_message("approve") is None


def test_end_to_end_over_websocket_and_http():
    app = FastAPI()
    app.include_router(vscode_router)
    app.include_router(remote_router, prefix="/api/remote")

    async def by_token(hashed):
        from services.auth import token_hash
        return {token_hash("desk-token"): USER, token_hash("web-token"): USER, token_hash("other-token"): OTHER}.get(hashed)

    with patch.object(auth_db, "get_user_by_token", new=AsyncMock(side_effect=by_token)), TestClient(app) as client:
        web = {"Authorization": "Bearer web-token"}
        with client.websocket_connect("/ws/vscode") as desktop:
            desktop.send_json({
                "type": "workspace_connected", "client": "desktop", "workspaceName": "my-app",
                "workspaceFolders": [{"id": "root-1", "name": "my-app", "uri": "file:///D:/work/my-app"}],
                "authToken": "desk-token", "deviceId": "dev-pc", "deviceName": "Gor-PC",
                "folderPath": FOLDER, "remoteAllowed": True,
            })
            assert desktop.receive_json()["type"] == "workspace_registered"
            assert desktop.receive_json() == {"type": "remote_status", "available": True, "clients": []}

            assert client.get("/api/remote/workspaces").status_code == 401, "未登录看不到遥斋"
            assert client.get("/api/remote/workspaces", headers={"Authorization": "Bearer other-token"}).json()["workspaces"] == []
            listed = client.get("/api/remote/workspaces", headers=web).json()["workspaces"]
            remote_id = listed[0]["remoteId"]
            assert listed[0]["online"] and listed[0]["deviceName"] == "Gor-PC"

            attached = client.post(f"/api/remote/workspaces/{remote_id}/attach", headers=web,
                                   json={"deviceId": "phone", "label": "iPhone · Safari"})
            assert attached.status_code == 200
            clients = desktop.receive_json()
            assert clients["type"] == "remote_clients" and clients["clients"][0]["label"] == "iPhone · Safari"

            answered = client.post(f"/api/remote/workspaces/{remote_id}/toolchain", headers=web, json={
                "deviceId": "phone", "message": {"type": "gor.toolchainApprovalAnswer", "approvalId": "a1", "answer": "approve"}})
            assert answered.status_code == 200
            assert desktop.receive_json() == {"type": "remote_page_message",
                                              "message": {"type": "gor.toolchainApprovalAnswer", "approvalId": "a1", "answer": "approve"}}
            rejected = client.post(f"/api/remote/workspaces/{remote_id}/toolchain", headers=web, json={
                "deviceId": "phone", "message": {"type": "gor.toolchainOpenUrl", "url": "http://localhost:1"}})
            assert rejected.status_code == 400

            desktop.send_json({"type": "remote_disconnect", "clientId": "phone"})
            assert desktop.receive_json() == {"type": "remote_clients", "clients": []}
            kicked = client.post(f"/api/remote/workspaces/{remote_id}/attach", headers=web, json={"deviceId": "phone"})
            assert kicked.status_code == 403 and "已断开" in kicked.json()["detail"]
        offline = client.get("/api/remote/workspaces", headers=web).json()["workspaces"]
        assert offline[0]["online"] is False


class RemoteChatRouteTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        for name, value in (("get_edit_mode", "auto"), ("get_thinking_mode", "deep"), ("get_model_preference", None)):
            mock = patch.object(chat_module, name, new_callable=AsyncMock, return_value=value)
            mock.start()
            self.addCleanup(mock.stop)
        remote_shuzhai.reset()
        self.addCleanup(remote_shuzhai.reset)

    async def _chat(self, account, remote_id, device="phone"):
        class Request:
            async def is_disconnected(self):
                return False

        captured = {}

        async def fake_agent(messages, send_event, *args, **kwargs):
            captured["vscode_context"] = args[-3]
            captured["kwargs"] = kwargs
            send_event({"type": "token", "content": "好"})

        with patch.object(chat_module, "current_account", new=AsyncMock(return_value=account)), \
             patch.object(chat_module, "save_message", new_callable=AsyncMock, return_value=1), \
             patch.object(chat_module, "load_messages", new_callable=AsyncMock, return_value=[]), \
             patch.object(chat_module, "get_session_preview_project", new_callable=AsyncMock) as get_project, \
             patch.object(chat_module.context_engine, "build_context", new_callable=AsyncMock, return_value={"summary": "", "recent_messages": []}), \
             patch.object(chat_module, "run_agent", fake_agent), \
             patch.object(chat_module, "deduct_model_quota", new_callable=AsyncMock, return_value=None), \
             patch.object(chat_module, "auto_generate_session_title", new_callable=AsyncMock):
            response = await chat_module.chat(Request(), chat_module.ChatRequest(
                sessionId="remote-session", message="跑一下测试", clientMode="web",
                remoteWorkspaceId=remote_id, remoteDeviceId=device,
            ))
            if hasattr(response, "body_iterator"):
                [chunk async for chunk in response.body_iterator]
        return response, captured, get_project

    async def test_remote_request_is_translated_to_the_real_shuzhai(self):
        entry = _register()
        _, captured, get_project = await self._chat(USER, entry.remote_id)
        self.assertEqual(captured["vscode_context"][1].project_id, "desktop-1")
        self.assertEqual(captured["kwargs"].get("workspace_client"), "desktop")
        get_project.assert_not_awaited()
        self.assertIn("phone", entry.clients, "发送也算作遥控中的活动")

    async def test_remote_request_is_refused_without_permission(self):
        entry = _register(allowed=False)
        response, captured, _ = await self._chat(USER, entry.remote_id)
        self.assertEqual(response.status_code, 403)
        self.assertIn("未允许网页遥控", json.loads(response.body)["detail"])
        self.assertEqual(captured, {})
        _register(allowed=True)
        response, captured, _ = await self._chat(OTHER, entry.remote_id)
        self.assertEqual(response.status_code, 403, "别的账号不能遥控")


def test_remote_id_for_is_case_insensitive_on_paths():
    assert remote_id_for("a", "d", "D:\\Work") == remote_id_for("a", "d", "d:\\work")


def test_pending_approvals_are_kept_for_devices_that_open_later():
    import time as _time
    entry = _register()
    future = int((_time.time() + 600) * 1000)
    approval = {"type": "gor.toolchain", "kind": "approval", "request": {"runId": "r1", "approvalId": "a1", "deadline": future}}
    other = {"type": "gor.toolchain", "kind": "approval", "request": {"runId": "r2", "approvalId": "a2", "deadline": future}}
    expired = {"type": "gor.toolchain", "kind": "approval", "request": {"runId": "r3", "approvalId": "a3", "deadline": 1}}
    for message in (approval, other, expired):
        remote_shuzhai.publish_toolchain("desktop-1", message)
    assert entry.pending_approvals() == [approval, other], "过期的不再补"
    remote_shuzhai.publish_toolchain("desktop-1", {"type": "gor.toolchain", "kind": "update", "update": {"runId": "r1", "status": "running"}})
    remote_shuzhai.publish_toolchain("desktop-1", {"type": "gor.toolchain", "kind": "withdrawn", "approvalId": "a2", "runId": "r2"})
    assert entry.pending_approvals() == [], "回答（状态变化）或收回后不再补"
    remote_shuzhai.publish_toolchain("desktop-1", approval)
    _register(allowed=False)
    assert entry.pending_approvals() == [], "关掉开关时清空"


def test_attach_returns_pending_approvals():
    app = FastAPI()
    app.include_router(remote_router, prefix="/api/remote")
    entry = _register()
    approval = {"type": "gor.toolchain", "kind": "approval", "request": {"runId": "r1", "approvalId": "a1", "deadline": 99999999999999}}
    remote_shuzhai.publish_toolchain("desktop-1", approval)
    with patch.object(auth_db, "get_user_by_token", new=AsyncMock(return_value=USER)), TestClient(app) as client:
        body = client.post(f"/api/remote/workspaces/{entry.remote_id}/attach", headers={"Authorization": "Bearer x"},
                           json={"deviceId": "phone", "label": "iPhone"}).json()
    assert body["pendingApprovals"] == [approval]
