import asyncio
import json
import struct
from unittest.mock import AsyncMock, patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from routes import chat_routes


def glb():
    document = json.dumps({'asset': {'version': '2.0'}}).encode()
    document += b' ' * (-len(document) % 4)
    return struct.pack('<4sIIII', b'glTF', 2, 20 + len(document), len(document), 0x4E4F534A) + document


def client():
    app = FastAPI()
    app.include_router(chat_routes.router)
    return TestClient(app)


def test_raw_export_and_preview_use_database_bytes_without_filesystem(tmp_path):
    persist = AsyncMock()
    payload = glb()
    with (
        patch.object(chat_routes, 'session_exists', new=AsyncMock(return_value=True)),
        patch.object(chat_routes, 'save_session_generated_artifact', new=persist),
        patch.object(chat_routes, 'ensure_storage_dirs', side_effect=AssertionError('no disk writes')),
        patch.object(chat_routes, 'GENERATED_ROOT', tmp_path),
    ):
        response = client().put('/session/session-a/generated-artifacts', params={'name': '机器人.glb.glb', 'message_id': 'reply-a'}, content=payload)
    assert response.status_code == 200
    reference = response.json()['file']
    assert reference['displayName'] == '机器人.glb'
    assert reference['artifactId']
    assert persist.await_args.args[3] is None
    assert persist.await_args.kwargs == {'message_id': 'reply-a', 'artifact_bytes': payload}
    assert list(tmp_path.iterdir()) == []
    record = {'name': reference['displayName'], 'artifact_bytes': payload, 'relative_path': None, 'content_type': 'model/gltf-binary'}
    read = AsyncMock(return_value=record)
    with patch.object(chat_routes, 'get_session_generated_artifact', new=read):
        response = client().get(f"/session/session-a/generated-artifacts/{reference['artifactId']}")
    assert response.content == payload
    assert response.headers['cache-control'] == 'no-store'
    assert response.headers['content-type'] == 'model/gltf-binary'
    assert 'filename*=utf-8' in response.headers['content-disposition']
    read.assert_awaited_once_with('session-a', reference['artifactId'])


@pytest.mark.parametrize('payload, limit, status', [(b'not a glb', None, 422), (glb(), 10, 413)])
def test_invalid_or_oversize_export_is_not_persisted(payload, limit, status):
    persist = AsyncMock()
    with (
        patch.object(chat_routes, 'session_exists', new=AsyncMock(return_value=True)),
        patch.object(chat_routes, 'save_session_generated_artifact', new=persist),
        patch.object(chat_routes, 'MAX_GENERATED_GLB_BYTES', limit or 32 * 1024 * 1024),
    ):
        response = client().put('/session/s/generated-artifacts?name=model.glb', content=payload)
    assert response.status_code == status
    persist.assert_not_awaited()


def test_missing_session_or_assistant_is_not_reported_as_success():
    with patch.object(chat_routes, 'session_exists', new=AsyncMock(return_value=False)):
        assert client().put('/session/s/generated-artifacts?name=model.glb', content=glb()).status_code == 404
    with (
        patch.object(chat_routes, 'session_exists', new=AsyncMock(return_value=True)),
        patch.object(chat_routes, 'save_session_generated_artifact', new=AsyncMock(side_effect=ValueError('找不到助手消息'))),
    ):
        assert client().put('/session/s/generated-artifacts?name=model.glb', content=glb()).status_code == 409


def test_legacy_artifacts_remain_readable_without_rewriting(tmp_path):
    payload = glb()
    (tmp_path / 'old.glb').write_bytes(payload)
    record = {'name': 'old.glb', 'artifact_bytes': None, 'relative_path': 'old.glb', 'content_type': 'model/gltf-binary'}
    with (
        patch.object(chat_routes, 'get_session_generated_artifact', new=AsyncMock(return_value=record)),
        patch.object(chat_routes, 'GENERATED_ROOT', tmp_path),
    ):
        response = client().get('/session/s/generated-artifacts/old')
    assert response.content == payload
    assert response.headers['cache-control'] == 'no-store'
    assert list(tmp_path.iterdir()) == [tmp_path / 'old.glb']


def test_session_delete_skips_virtual_artifact_disk_cleanup(monkeypatch):
    from db import supabase_chat as database
    from tests.test_workspace_history_artifacts import use_fake_pool
    connection = use_fake_pool(monkeypatch)

    async def fetch(sql, *_args):
        return [{'relative_path': None}] if 'session_generated_artifacts' in sql else []

    connection.fetch = fetch
    asyncio.run(database.delete_session('s'))
    assert any('DELETE FROM session_generated_artifacts' in sql for sql, _ in connection.calls)
