"""Global edit preference is shared by sessions and hosts and must not be HTTP-cached."""
from unittest.mock import AsyncMock, patch
import asyncio
from contextlib import asynccontextmanager

import httpx
from fastapi import FastAPI
from routes.project_changes import router


def test_hosts_read_latest_saved_session_preference():
    asyncio.run(hosts_read_latest_saved_session_preference())


async def hosts_read_latest_saved_session_preference():
    saved = {"value": "auto"}

    async def read(session_id):
        return saved["value"]

    async def write(session_id, mode):
        saved["value"] = mode

    app = FastAPI()
    app.include_router(router, prefix="/api/chat")
    transport = httpx.ASGITransport(app=app)
    with patch("routes.project_changes.get_edit_mode", side_effect=read), patch("routes.project_changes.set_edit_mode", side_effect=write):
        async with httpx.AsyncClient(transport=transport, base_url="http://gor") as web, httpx.AsyncClient(transport=transport, base_url="http://gor") as plugin:
            path = "/api/chat/session/shared/edit-mode"
            assert (await web.get(path)).json() == {"editMode": "auto"}
            result = await web.put(path, json={"editMode": "review"})
            assert result.status_code == 200
            assert result.headers["cache-control"] == "no-store"
            result = await plugin.get(path)
            assert result.json() == {"editMode": "review"}
            assert result.headers["cache-control"] == "no-store"
            assert (await web.get("/api/chat/session/another-session/edit-mode")).json() == {"editMode": "review"}
            await plugin.put(path, json={"editMode": "auto"})
            assert (await web.get(path)).json() == {"editMode": "auto"}
            assert (await web.get("/api/chat/session/other/edit-mode")).json() == {"editMode": "auto"}


def test_invalid_mode_and_failed_save_do_not_return_success():
    asyncio.run(invalid_mode_and_failed_save_do_not_return_success())


async def invalid_mode_and_failed_save_do_not_return_success():
    app = FastAPI()
    app.include_router(router, prefix="/api/chat")
    path = "/api/chat/session/shared/edit-mode"
    writer = AsyncMock(side_effect=RuntimeError("save failed"))
    with patch("routes.project_changes.set_edit_mode", writer):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app, raise_app_exceptions=False), base_url="http://gor") as client:
            assert (await client.put(path, json={"editMode": "invalid"})).status_code == 422
            writer.assert_not_called()
            assert (await client.put(path, json={"editMode": "review"})).status_code == 500


def test_database_preferences_use_one_global_row_across_session_ids():
    from db import project_changes

    class Connection:
        row = {"edit_mode": "auto", "thinking_mode": "deep"}

        async def fetchval(self, query, *args):
            assert "chat_global_preferences WHERE id=1" in query
            assert not args
            return self.row["edit_mode" if "edit_mode" in query else "thinking_mode"]

        async def execute(self, query, *args):
            assert "chat_global_preferences(id," in query
            self.row["edit_mode" if "edit_mode" in query else "thinking_mode"] = args[-1]

    connection = Connection()

    @asynccontextmanager
    async def connect():
        yield connection

    async def exercise():
        with patch.object(project_changes.change_sets, "connect", connect):
            await project_changes.set_edit_mode("session-a", "review")
            await project_changes.set_thinking_mode("session-a", "light")
            assert await project_changes.get_edit_mode("session-b") == "review"
            assert await project_changes.get_thinking_mode("session-c") == "light"

    asyncio.run(exercise())
