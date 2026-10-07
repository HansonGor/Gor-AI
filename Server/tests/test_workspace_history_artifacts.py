import asyncio
import json
import re
from datetime import datetime, timezone

from db import supabase_chat as database


class Context:
    def __init__(self, value):
        self.value = value

    async def __aenter__(self):
        return self.value

    async def __aexit__(self, *_args):
        pass


class Connection:
    def __init__(self):
        self.calls = []

    def transaction(self):
        return Context(self)

    async def fetchval(self, sql, *args):
        self.calls.append((sql, args))
        return 7

    async def fetchrow(self, sql, *args):
        self.calls.append((sql, args))
        return {"id": 9, "attachments": None}

    async def execute(self, sql, *args):
        self.calls.append((sql, args))


def use_fake_pool(monkeypatch):
    connection = Connection()

    class Pool:
        def acquire(self):
            return Context(connection)

    async def get_pool():
        return Pool()

    monkeypatch.setattr(database, "get_pool", get_pool)
    return connection


def test_workspace_diff_is_persisted_separately_from_chat_prose(monkeypatch):
    connection = use_fake_pool(monkeypatch)
    changes = [{"path": "/src/App.jsx", "diff": "-old\n+new", "workspaceId": "vscode-test"}]
    for usage in [None, {"prompt_tokens": 3, "completion_tokens": 2, "total_tokens": 5}]:
        assert asyncio.run(database.save_message("session", "assistant", "变更文件：/src/App.jsx", token_usage=usage, message_id="reply", project_changes=changes)) == 7
    inserts = [(sql, args) for sql, args in connection.calls if "INSERT INTO chat_messages" in sql]
    assert len(inserts) == 2
    for sql, args in inserts:
        assert max(int(index) for index in re.findall(r"\$(\d+)", sql)) == len(args)
        assert json.loads(args[-1]) == changes
        assert args[2] == "变更文件：/src/App.jsx"


def test_glb_is_attached_to_the_requested_assistant_not_the_latest_message(monkeypatch):
    connection = use_fake_pool(monkeypatch)
    asyncio.run(database.save_session_generated_artifact("artifact", "session", "model.glb", "artifact.glb", "model/gltf-binary", 120, {"fileType": "3d"}, message_id="scene-reply"))
    query, args = next((sql, args) for sql, args in connection.calls if "FROM chat_messages" in sql)
    assert "client_message_id = $2" in query
    assert args == ("session", "scene-reply")


def test_virtual_artifact_bytes_are_stored_with_message_in_same_transaction(monkeypatch):
    connection = use_fake_pool(monkeypatch)
    asyncio.run(database.save_session_generated_artifact('artifact', 'session', 'model.glb', None, 'model/gltf-binary', 3, {'artifactId': 'artifact'}, message_id='scene-reply', artifact_bytes=b'glb'))
    sql, args = next((sql, args) for sql, args in connection.calls if 'INSERT INTO session_generated_artifacts' in sql)
    assert 'artifact_bytes' in sql
    assert len(args) == 7
    assert args[3] is None
    assert args[-1] == b'glb'
    assert any('UPDATE chat_messages SET attachments' in sql for sql, _ in connection.calls)


def test_new_project_archives_previous_source_with_its_own_identity_atomically(monkeypatch):
    connection = use_fake_pool(monkeypatch)
    old = {"id": "old-react", "name": "Old React", "template": "react", "revision": 4, "files": {"/index.html": "<h1>Original</h1>"}}

    async def fetchrow(sql, *args):
        connection.calls.append((sql, args))
        if sql.startswith("SELECT project"):
            return {"project": json.dumps(old)}
        if "UPDATE session_preview_projects" in sql:
            return {"revision": 9, "updated_at": datetime.now(timezone.utc)}
        return {"id": 7, "client_message_id": "old-reply"}

    connection.fetchrow = fetchrow
    new = {"id": "new-model", "name": "New Scene", "template": "html", "files": {"/src/scene.json": "{}"}, "revision": 1}
    assert asyncio.run(database.update_session_preview_project_if_revision("session", new, 8))["revision"] == 9
    query, args = next((sql, args) for sql, args in connection.calls if "SET preview_snapshot" in sql)
    archived = json.loads(args[0])
    assert archived["id"] == "old-react"
    assert archived["files"] == old["files"]
    assert archived["messageId"] == "old-reply"
    assert archived["outputExtension"] == ".html"
    canonical_args = next(args for sql, args in connection.calls if "UPDATE session_preview_projects" in sql)
    assert canonical_args[-1] is True
