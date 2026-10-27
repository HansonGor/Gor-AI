"""桌面端「书斋」（clientMode=desktop）：独立会话命名空间、登记方类型、走工作区 Provider 分支（全部离线）。"""
import asyncio
import importlib
import json
import unittest
from unittest.mock import AsyncMock, patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import ValidationError

import app as app_module
from db import auth as auth_db
from project_api.providers.vscode import VSCodeProjectProvider
from project_api.types import ProjectRef
from routes import chat_routes
from routes.vscode import active_workspaces, router as vscode_router
from services import auth as auth_service
from services.vscode_bridge import VSCodeBridgeClient, vscode_bridge

chat_module = importlib.import_module("routes.chat")
USER = {"id": "acc-1", "email": "a@example.com", "nickname": "樺"}


class FakeSocket:
    async def send_json(self, payload):
        pass


def test_desktop_namespace_is_separate_from_web_and_vscode():
    assert auth_service.account_namespace("acc-1", "default:desktop") == "user:acc-1:desktop"
    assert auth_service.account_namespace("acc-1", "user:acc-9:desktop") == "user:acc-1:desktop", "只取后缀，账号以登录为准"
    assert auth_service.account_namespace("acc-1", "default") == "user:acc-1", "桌面端云笺沿用 Web 命名空间"
    assert auth_service.account_namespace("acc-1", "default:vscode") == "user:acc-1:vscode"
    assert auth_service.namespace_account("user:acc-1:desktop") == "acc-1"
    assert auth_service.namespace_account("default:desktop") is None
    assert auth_service.can_access_session("user:acc-1:desktop", "acc-1")
    assert not auth_service.can_access_session("user:acc-1:desktop", "acc-2")


def test_first_account_claims_unlogged_desktop_sessions_too():
    executed = []

    class Conn:
        def transaction(self):
            return self

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return False

        async def execute(self, sql, *args):
            executed.append((sql, args))
            return "UPDATE 2" if sql.startswith("UPDATE chat_sessions") else "OK"

        async def fetchval(self, sql):
            return True

        async def fetchrow(self, sql, *args):
            return {"id": args[0], "email": args[1], "nickname": args[2]}

    class Pool:
        def acquire(self):
            return Conn()

    with patch.object(auth_db, "get_pool", new=AsyncMock(return_value=Pool())):
        user, claimed = asyncio.run(auth_db.create_user("a@example.com", "樺", "hash"))
    moves = {args[1]: args[0] for sql, args in executed if sql.startswith("UPDATE chat_sessions")}
    account = f"user:{user['id']}"
    assert moves == {"default": account, "default:vscode": f"{account}:vscode", "default:desktop": f"{account}:desktop"}
    assert claimed == 6


class DesktopSessionApiTest(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app_module.app)

    def test_desktop_session_list_and_create_use_desktop_namespace(self):
        with patch.object(auth_db, "get_user_by_token", new=AsyncMock(return_value=USER)), \
             patch.object(chat_routes, "list_sessions", new=AsyncMock(return_value=[])) as list_sessions, \
             patch.object(chat_routes, "create_session", new=AsyncMock(return_value={"id": "s1"})) as create_session:
            self.client.get("/api/chat/sessions?userId=default%3Adesktop", headers={"Authorization": "Bearer t", "X-Gor-Client": "desktop"})
            self.client.post("/api/chat/session/create", json={"userId": "default:desktop"},
                             headers={"Authorization": "Bearer t", "X-Gor-Client": "desktop"})
        list_sessions.assert_awaited_once_with("user:acc-1:desktop")
        self.assertEqual(create_session.await_args.args[0], "user:acc-1:desktop")

    def test_anonymous_desktop_uses_unlogged_namespace_but_cannot_claim_accounts(self):
        with patch.object(chat_routes, "list_sessions", new=AsyncMock(return_value=[])) as list_sessions:
            ok = self.client.get("/api/chat/sessions?userId=default%3Adesktop")
            foreign = self.client.get("/api/chat/sessions?userId=user%3Aacc-1%3Adesktop")
        self.assertEqual(ok.status_code, 200)
        self.assertEqual(foreign.status_code, 401)
        list_sessions.assert_awaited_once_with("default:desktop")


def test_chat_request_accepts_desktop_and_rejects_unknown_modes():
    assert chat_module.ChatRequest(sessionId="s", clientMode="desktop").clientMode == "desktop"
    with pytest.raises(ValidationError):
        chat_module.ChatRequest(sessionId="s", clientMode="mobile")


class DesktopChatRouteTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        for name, value in (("get_edit_mode", "auto"), ("get_thinking_mode", "deep"), ("get_model_preference", None)):
            mock = patch.object(chat_module, name, new_callable=AsyncMock, return_value=value)
            mock.start()
            self.addCleanup(mock.stop)

    async def _run(self, mode: str):
        class Request:
            async def is_disconnected(self):
                return False

        captured = {}

        async def fake_agent(messages, send_event, *args, **kwargs):
            captured["preview_workspace"] = args[2]
            captured["vscode_context"] = args[-3]
            captured["vscode_mode"] = args[-2]
            captured["kwargs"] = kwargs
            send_event({"type": "token", "content": "已读取书斋文件"})

        bootstrap = {"id": "preview-default", "name": "React Preview", "template": "react", "revision": 0,
                     "files": {"/index.html": "<div id='root'></div>"}}
        with patch.object(chat_module, "save_message", new_callable=AsyncMock, return_value=1), \
             patch.object(chat_module, "load_messages", new_callable=AsyncMock, return_value=[]), \
             patch.object(chat_module, "get_session_preview_project", new_callable=AsyncMock) as get_project, \
             patch.object(chat_module.context_engine, "build_context", new_callable=AsyncMock, return_value={"summary": "", "recent_messages": []}), \
             patch.object(chat_module, "run_agent", fake_agent), \
             patch.object(chat_module, "deduct_model_quota", new_callable=AsyncMock, return_value=None), \
             patch.object(chat_module, "auto_generate_session_title", new_callable=AsyncMock):
            response = await chat_module.chat(Request(), chat_module.ChatRequest(
                sessionId=f"{mode}-session", message="看看 src/app.ts 是做什么的", clientMode=mode,
                workspaceId="vscode-desk-workspace", previewProjectBootstrap=bootstrap,
            ))
            chunks = [chunk async for chunk in response.body_iterator]
        events = [json.loads(chunk[6:]) for chunk in chunks if chunk.startswith("data: ")]
        return captured, get_project, events

    async def test_desktop_mode_takes_the_workspace_provider_branch_without_preview(self):
        captured, get_project, events = await self._run("desktop")
        self.assertTrue(captured["vscode_mode"])
        self.assertIsNone(captured["preview_workspace"], "书斋不加载、不初始化 Web Preview")
        self.assertIsNotNone(captured["vscode_context"])
        self.assertEqual(captured["vscode_context"][1].provider, "vscode")
        self.assertEqual(captured["kwargs"].get("workspace_client"), "desktop")
        get_project.assert_not_awaited()
        self.assertNotIn("preview_project_persisted", [event["type"] for event in events])

    async def test_vscode_mode_is_unchanged(self):
        captured, get_project, _ = await self._run("vscode")
        self.assertTrue(captured["vscode_mode"])
        self.assertNotIn("workspace_client", captured["kwargs"])
        get_project.assert_not_awaited()


def test_bridge_records_client_and_desktop_workspaces_have_the_same_capabilities():
    async def scenario():
        bridge = VSCodeBridgeClient()
        bridge.register_workspace("vscode-desk", FakeSocket(), "desktop")
        bridge.register_workspace("vscode-plugin", FakeSocket(), "vscode")
        bridge.register_workspace("vscode-other", FakeSocket(), "something-else")
        provider = VSCodeProjectProvider(bridge)
        desk = await provider.get_capabilities(ProjectRef("vscode-desk", "vscode"))
        plugin = await provider.get_capabilities(ProjectRef("vscode-plugin", "vscode"))
        assert bridge.workspace_client("vscode-desk") == "desktop"
        assert bridge.workspace_client("vscode-other") == "vscode", "未知登记方按 VS Code 处理"
        assert desk == plugin, "书斋经本机 git 命令提供 Git，能力与插件一致"
        assert desk["git"] and desk["toolchain"] and desk["deleteFile"] and desk["externalRead"]

    asyncio.run(scenario())


def test_websocket_registration_keeps_the_desktop_client_type():
    app = FastAPI()
    app.include_router(vscode_router)
    with TestClient(app) as client:
        with client.websocket_connect("/ws/vscode") as socket:
            socket.send_json({
                "type": "workspace_connected", "client": "desktop", "workspaceName": "project",
                "workspaceFolders": [{"id": "root-1", "name": "project", "uri": "file:///D:/Projects/project"}],
            })
            workspace_id = socket.receive_json()["workspaceId"]
            assert workspace_id.startswith("desktop-"), "书斋的工作区 ID 与插件区分"
            from project_api.vscode_context import create_current_vscode_project_api
            context = create_current_vscode_project_api(workspace_id)
            assert context is not None and context[1].provider == "vscode", "desktop- 前缀同样走工作区 Provider"
            assert active_workspaces[workspace_id]["client"] == "desktop"
            assert vscode_bridge.workspace_client(workspace_id) == "desktop"
        assert workspace_id not in active_workspaces


def test_desktop_request_without_registered_shuzhai_says_so_in_plain_words(monkeypatch):
    import agent.agent as agent_module

    def unexpected_model_call(_names):
        raise AssertionError("未登记书斋的请求不能交给模型")

    monkeypatch.setattr(agent_module, "get_model_for_tools", unexpected_model_call)
    monkeypatch.setattr(agent_module, "TYPING_DELAY_MS", 0)
    events = []
    asyncio.run(agent_module.run_agent(
        [{"role": "user", "content": "把标题改回原来的"}], events.append,
        vscode_client_mode=True, workspace_client="desktop",
    ))
    text = "".join(event.get("content", "") for event in events if event.get("type") == "token")
    assert "书斋尚未连接" in text
    assert "VS Code" not in text


def test_desktop_prompt_explains_shuzhai_without_git():
    from agent.project_reply import DESKTOP_WORKSPACE_PROMPT
    assert "书斋" in DESKTOP_WORKSPACE_PROMPT and "本机安装的 git" in DESKTOP_WORKSPACE_PROMPT


def test_desktop_change_summary_points_to_the_shuzhai_folder():
    from agent.project_reply import summarize_project_changes
    desk = summarize_project_changes("删除 src/new.ts 文件", ["/src/new.ts"], provider="desktop")
    plugin = summarize_project_changes("删除 src/new.ts 文件", ["/src/new.ts"], provider="vscode")
    assert "书斋文件夹" in desk and "VS Code" not in desk
    assert "VS Code 工作区" in plugin
