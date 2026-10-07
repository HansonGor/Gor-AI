"""The actual compact SSE commit path retains scene type/name, not a React shell."""
import asyncio
import copy
from unittest.mock import AsyncMock, patch

from langchain_core.messages import AIMessage
from routes import chat as chat_route
from test_preview_context_flow import FakeRequest, collect_events


def test_scene_generation_commits_scene_metadata_through_real_route():
    async def exercise():
        initial = {"id": "scene-commit", "name": "New React Project", "template": "react", "files": {}, "revision": 0}
        committed = []

        async def commit(_session, project, expected_revision):
            assert expected_revision == 0
            committed.append(copy.deepcopy(project))
            return {"revision": 1}

        class Model:
            async def ainvoke(self, messages, config=None):
                return AIMessage(content="", tool_calls=[{
                    "name": "set_3d_scene", "id": "scene-call",
                    "args": {"action": "create", "name": "简单场景", "objects": [{"id": "body", "name": "Body", "geometry": "box", "size": [1, 1, 1]}]},
                }])

        with (
            patch("agent.agent.get_model_for_tools", return_value=Model()),
            patch("agent.agent.TYPING_DELAY_MS", 0),
            patch.object(chat_route.context_engine, "build_context", new=AsyncMock(return_value={"summary": "", "recent_messages": []})),
            patch.object(chat_route, "get_session_preview_project", new=AsyncMock(return_value={"project": initial, "revision": 0, "origin": "generated"})),
            patch.object(chat_route, "update_session_preview_project_if_revision", side_effect=commit),
            patch.object(chat_route, "load_messages", new=AsyncMock(return_value=[])),
            patch.object(chat_route, "save_message", new=AsyncMock(return_value=1)),
            patch.object(chat_route, "deduct_model_quota", new=AsyncMock(return_value=None)),
            patch.object(chat_route, "auto_generate_session_title", new=AsyncMock()),
        ):
            response = await chat_route.chat(FakeRequest(), chat_route.ChatRequest(
                sessionId="scene-session", message="生成一个简单的3d模型",
                previewProjectId=initial["id"], previewServerRevision=0, previewContentRevision=0,
            ))
            events = await collect_events(response)
        return committed, events

    committed, events = asyncio.run(exercise())
    assert len(committed) == 1
    assert committed[0]["name"] == "简单场景"
    assert committed[0]["template"] == "html"
    assert set(committed[0]["files"]) == {"/src/scene.json"}
    commit = next(event for event in events if event["type"] == "preview_project_committed")
    assert [file["path"] for file in commit["changedFiles"]] == ["/src/scene.json"]
    assert all("content" not in file for file in commit["changedFiles"])
    assert not any(event["type"] == "preview_file_changed" for event in events)
    assert events[-1]["type"] == "done"


def test_new_react_project_stages_blank_identity_instead_of_reusing_old_scene():
    async def exercise():
        old = {"id": "old-scene", "name": "Scene", "template": "html", "files": {"/src/scene.json": '{"name":"Scene"}'}, "revision": 4}
        commits = []
        sources = {
            "/index.html": '<title>React Demo</title><div id="root"></div><script type="module" src="/src/main.jsx"></script>',
            "/src/App.jsx": 'export default function App() { return <h1>React Demo</h1>; }',
            "/src/main.jsx": "import App from './App.jsx';",
        }

        class Model:
            async def ainvoke(self, messages, config=None):
                return AIMessage(content="", tool_calls=[{"name": "write_preview_file", "id": f"write-{index}", "args": {"path": path, "content": content}} for index, (path, content) in enumerate(sources.items())])

        async def commit(_session, project, revision):
            assert revision == 8
            commits.append(copy.deepcopy(project))
            return {"revision": 9}

        with (
            patch("agent.agent.get_model_for_tools", return_value=Model()),
            patch("agent.agent.TYPING_DELAY_MS", 0),
            patch.object(chat_route.context_engine, "build_context", new=AsyncMock(return_value={"summary": "", "recent_messages": []})),
            patch.object(chat_route, "get_session_preview_project", new=AsyncMock(return_value={"project": old, "revision": 8, "origin": "generated"})),
            patch.object(chat_route, "update_session_preview_project_if_revision", side_effect=commit),
            patch.object(chat_route, "load_messages", new=AsyncMock(return_value=[])),
            patch.object(chat_route, "save_message", new=AsyncMock(return_value=1)),
            patch.object(chat_route, "deduct_model_quota", new=AsyncMock(return_value=None)),
            patch.object(chat_route, "auto_generate_session_title", new=AsyncMock()),
        ):
            response = await chat_route.chat(FakeRequest(), chat_route.ChatRequest(
                sessionId="project-session", message="生成一份简单的react-demo",
                newPreviewProject=True, previewServerRevision=8,
                previewProjectBootstrap={"id": "new-react", "name": "New React Project", "template": "react", "files": {}, "revision": 0},
            ))
            events = await collect_events(response)
        return old, commits, events, sources

    old, commits, events, sources = asyncio.run(exercise())
    assert not any(event["type"] == "error" for event in events), events
    assert len(commits) == 1
    assert commits[0]["id"] == "new-react"
    assert commits[0]["files"] == sources
    assert commits[0]["template"] == "react"
    assert set(old["files"]) == {"/src/scene.json"}


def test_failed_new_generation_does_not_replace_the_previous_canonical_project():
    async def exercise():
        old = {"id": "old-react", "name": "React Demo", "template": "react", "files": {"/index.html": '<h1>Original</h1>'}, "revision": 3}
        commit = AsyncMock()

        class Model:
            async def ainvoke(self, messages, config=None):
                return AIMessage(content="模型没有生成任何文件。")

        with (
            patch("agent.agent.get_model_for_tools", return_value=Model()),
            patch("agent.agent.TYPING_DELAY_MS", 0),
            patch.object(chat_route.context_engine, "build_context", new=AsyncMock(return_value={"summary": "", "recent_messages": []})),
            patch.object(chat_route, "get_session_preview_project", new=AsyncMock(return_value={"project": old, "revision": 6, "origin": "generated"})),
            patch.object(chat_route, "update_session_preview_project_if_revision", new=commit),
            patch.object(chat_route, "load_messages", new=AsyncMock(return_value=[])),
            patch.object(chat_route, "save_message", new=AsyncMock(return_value=1)),
            patch.object(chat_route, "deduct_model_quota", new=AsyncMock(return_value=None)),
            patch.object(chat_route, "auto_generate_session_title", new=AsyncMock()),
        ):
            response = await chat_route.chat(FakeRequest(), chat_route.ChatRequest(
                sessionId="project-session", message="生成一个3D模型", newPreviewProject=True, previewServerRevision=6,
                previewProjectBootstrap={"id": "new-scene", "name": "New Model", "template": "html", "files": {}, "revision": 0},
            ))
            await collect_events(response)
        commit.assert_not_awaited()
        assert old["files"]["/index.html"] == '<h1>Original</h1>'

    asyncio.run(exercise())
