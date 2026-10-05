"""Batch Preview Project source reads return only an exact authoritative revision."""

import asyncio
import json
import unittest
from unittest.mock import AsyncMock, patch

from routes import chat_routes


def snapshot(revision=6):
    return {
        "project": {
            "id": "preview-sync-test",
            "name": "Sync Test",
            "template": "react",
            "revision": revision,
            "files": {
                "/index.html": "<div id='root'></div>",
                "/src/App.tsx": "export default () => <h1>latest</h1>;\n",
                "/src/style.css": "body { color: violet; }\n",
            },
        },
        "origin": "generated",
        "uploadName": None,
        "revision": 14,
        "updatedAt": "2026-10-04T00:00:00+08:00",
    }


class PreviewSyncApiTest(unittest.TestCase):
    def test_batch_read_returns_requested_files_for_exact_revision(self):
        async def exercise():
            body = chat_routes.ReadPreviewProjectFilesRequest(
                projectId="preview-sync-test",
                paths=["/src/App.tsx", "/src/style.css", "/src/App.tsx"],
                expectedRevision=6,
            )
            with (
                patch.object(chat_routes, "session_exists", new=AsyncMock(return_value=True)) as session_exists,
                patch.object(chat_routes, "get_session_preview_project", new=AsyncMock(return_value=snapshot())) as get_project,
            ):
                result = await chat_routes.read_session_preview_project_files_endpoint("session-1", body)
            return result, session_exists, get_project

        result, session_exists, get_project = asyncio.run(exercise())
        self.assertEqual(result["revision"], 6)
        self.assertEqual(result["serverRevision"], 14)
        self.assertEqual([item["path"] for item in result["files"]], ["/src/App.tsx", "/src/style.css"])
        self.assertIn("latest", result["files"][0]["content"])
        self.assertEqual(session_exists.call_count, 1)
        get_project.assert_awaited_once_with("session-1")

    def test_advanced_revision_returns_code_without_any_file_source(self):
        async def exercise():
            body = chat_routes.ReadPreviewProjectFilesRequest(
                projectId="preview-sync-test", paths=["/src/App.tsx"], expectedRevision=5,
            )
            with (
                patch.object(chat_routes, "session_exists", new=AsyncMock(return_value=True)),
                patch.object(chat_routes, "get_session_preview_project", new=AsyncMock(return_value=snapshot(7))),
            ):
                return await chat_routes.read_session_preview_project_files_endpoint("session-1", body)

        result = asyncio.run(exercise())
        self.assertEqual(result.status_code, 409)
        payload = json.loads(result.body)
        self.assertEqual(payload["code"], "PREVIEW_REVISION_ADVANCED")
        self.assertEqual((payload["requestedRevision"], payload["currentRevision"]), (5, 7))
        self.assertNotIn("files", payload)
        self.assertNotIn("content", result.body.decode("utf-8"))

    def test_future_revision_is_not_served_as_if_it_existed(self):
        async def exercise():
            body = chat_routes.ReadPreviewProjectFilesRequest(
                projectId="preview-sync-test", paths=["/src/App.tsx"], expectedRevision=8,
            )
            with (
                patch.object(chat_routes, "session_exists", new=AsyncMock(return_value=True)),
                patch.object(chat_routes, "get_session_preview_project", new=AsyncMock(return_value=snapshot(7))),
            ):
                return await chat_routes.read_session_preview_project_files_endpoint("session-1", body)

        result = asyncio.run(exercise())
        self.assertEqual(result.status_code, 409)
        payload = json.loads(result.body)
        self.assertEqual(payload["code"], "PREVIEW_REVISION_UNAVAILABLE")
        self.assertNotIn("files", payload)

if __name__ == "__main__":
    unittest.main()
