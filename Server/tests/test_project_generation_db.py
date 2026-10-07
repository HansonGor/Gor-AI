"""Opt-in real SQL check: isolate and remove only this test's own session."""
import unittest

from config import config
from db.supabase_chat import (
    create_session, create_session_preview_project, delete_session,
    get_session_preview_project, init_db, load_messages, save_message,
    update_session_preview_project_if_revision,
)


@unittest.skipUnless(config.Database.URL, "SUPABASE_DB_URL is not configured")
class ProjectGenerationDatabaseTest(unittest.IsolatedAsyncioTestCase):
    async def test_independent_project_commit_preserves_previous_sources_and_diffs(self):
        await init_db()
        session = await create_session("project-generation-test")
        session_id = str(session["id"])
        old = {"id": "test-old-react", "name": "React Test", "template": "react", "files": {"/index.html": "<h1>React Test</h1>"}, "revision": 1}
        new = {"id": "test-new-scene", "name": "Scene Test", "template": "html", "files": {"/src/scene.json": '{"name":"Scene Test"}'}, "revision": 1}
        try:
            created = await create_session_preview_project(session_id, old)
            await save_message(session_id, "assistant", "变更文件：/index.html", message_id="old-reply",
                               preview_changes=[{"projectId": old["id"], "path": "/index.html", "diff": "+React Test"}],
                               project_changes=[{"path": "/src/App.jsx", "diff": "-Old\n+React Test"}])
            committed = await update_session_preview_project_if_revision(session_id, new, created["revision"])
            self.assertIsNotNone(committed)
            current = await get_session_preview_project(session_id)
            self.assertEqual(current["project"]["id"], new["id"])
            self.assertNotIn("/index.html", current["project"]["files"])
            messages = await load_messages(session_id)
            self.assertEqual(messages[0]["preview_snapshot"]["id"], old["id"])
            self.assertEqual(messages[0]["preview_snapshot"]["files"], old["files"])
            self.assertEqual(messages[0]["project_changes"][0]["path"], "/src/App.jsx")
            self.assertIsNone(await update_session_preview_project_if_revision(session_id, old, created["revision"]))
            self.assertEqual((await get_session_preview_project(session_id))["project"]["id"], new["id"])
        finally:
            await delete_session(session_id)
