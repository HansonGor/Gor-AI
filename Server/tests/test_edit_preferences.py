"""Session preferences are shared by clients and must not be HTTP-cached."""
from unittest.mock import AsyncMock, patch
import asyncio

import httpx
from fastapi import FastAPI
from routes.project_changes import router


def test_hosts_read_latest_saved_session_preference():
    asyncio.run(hosts_read_latest_saved_session_preference())


async def hosts_read_latest_saved_session_preference():
    saved = {}

    async def read(session_id):
        return saved.get(session_id, "auto")

    async def write(session_id, mode):
        saved[session_id] = mode

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
