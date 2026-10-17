"""End-to-end contract: Preview source sync stays out of persistent/model chat history."""

import asyncio
import copy
import json
import unittest
from unittest.mock import patch

from langchain_core.messages import AIMessage, HumanMessage, SystemMessage

from agent.agent import _audit_llm_context, _extract_explicit_text_edit, run_agent
from routes import chat as chat_route
from services.context_engine import estimate_tokens
from services.preview.workspace import PreviewProjectWorkspace


SOURCE_SENTINEL = "const FULL_SOURCE_MUST_NEVER_ENTER_CHAT_HISTORY = 'private-source-marker';"


def large_project():
    lines = [f"// generated source line {line}" for line in range(1, 531)]
    lines[41] = "export default function App() {"
    lines[44] = "  return <main><h1>React Demo</h1></main>;"
    lines[45] = "}"
    lines[519] = SOURCE_SENTINEL
    return {
        "id": "preview-context-acceptance",
        "name": "Large React Project",
        "template": "react",
        "revision": 0,
        "files": {
            "/src/App.tsx": "\n".join(lines) + "\n",
            "/src/main.tsx": "import App from './App';\n",
        },
    }


class TwoTurnPatchModel:
    """Deterministic model that patches from the fast path's preloaded snippets."""

    def __init__(self):
        self.prompts = []

    async def ainvoke(self, messages, config=None):
        self.prompts.append(list(messages))
        current_user = next(
            message.content for message in reversed(messages)
            if isinstance(message, HumanMessage)
        )
        old_title, new_title = (
            ("React Demo", "Gor Demo") if "React Demo" in current_user
            else ("Gor Demo", "Gor")
        )

        self.assert_fast_context = any(
            getattr(message, "type", "") == "system" and "程序预检的 Preview 搜索结果" in str(message.content)
            for message in messages
        )
        return AIMessage(content="", tool_calls=[{
            "name": "batch_patch_preview_files",
            "args": {
                "expected_revision": len(self.prompts) - 1,
                "patches": [{
                    "path": "/src/App.tsx",
                    "old_text": f"<h1>{old_title}</h1>",
                    "new_text": f"<h1>{new_title}</h1>",
                }],
            },
            "id": f"preview-context-{len(self.prompts)}",
        }])


class ReactTudoPatchModel:
    def __init__(self):
        self.prompts = []

    async def ainvoke(self, messages, config=None):
        self.prompts.append(list(messages))
        return AIMessage(content="", tool_calls=[{
            "name": "batch_patch_preview_files",
            "args": {
                "expected_revision": 3,
                "patches": [{
                    "path": "/src/App.tsx",
                    "old_text": "<h1>React Tudo</h1>",
                    "new_text": "<h1>React Todo Demo</h1>",
                }],
            },
            "id": "react-tudo-fast-path",
        }])


class FakeRequest:
    async def is_disconnected(self):
        return False


async def collect_events(response):
    chunks = []
    async for chunk in response.body_iterator:
        chunks.append(chunk.decode("utf-8") if isinstance(chunk, bytes) else str(chunk))
    events = []
    for line in "".join(chunks).splitlines():
        if line.startswith("data: "):
            events.append(json.loads(line[6:]))
    return events


class PreviewContextFlowTest(unittest.TestCase):
    def setUp(self):
        from test_project_changes import Store
        for name, value in [("save_thinking_trace", None), ("get_edit_mode", "auto"), ("get_thinking_mode", "deep"), ("get_model_preference", None)]:
            patcher = patch.object(chat_route, name, return_value=value)
            patcher.start()
            self.addCleanup(patcher.stop)
        patcher = patch.object(chat_route, "change_sets", Store())
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_review_chat_creates_candidate_diff_without_committing_actual_web_files(self):
        async def exercise():
            from test_project_changes import Store
            journal = Store()
            project = large_project()
            row = {'project': project, 'revision': 7, 'origin': 'generated'}
            model = TwoTurnPatchModel()
            async def context(*args): return {'summary': '', 'recent_messages': []}
            async def save(*args, **kwargs): return 1
            with (
                patch.object(chat_route, 'change_sets', journal),
                patch('agent.agent.get_model_for_tools', return_value=model),
                patch('agent.agent.model_with_simple_preview_edit', model),
                patch('agent.agent.TYPING_DELAY_MS', 0),
                patch.object(chat_route.context_engine, 'build_context', side_effect=context),
                patch.object(chat_route, 'get_session_preview_project', return_value=copy.deepcopy(row)),
                patch.object(chat_route, 'update_session_preview_project_if_revision') as commit,
                patch.object(chat_route, 'load_messages', return_value=[]),
                patch.object(chat_route, 'save_message', side_effect=save),
                patch.object(chat_route, 'deduct_model_quota', return_value=None),
                patch.object(chat_route, 'auto_generate_session_title', return_value=None),
            ):
                response = await chat_route.chat(FakeRequest(), chat_route.ChatRequest(
                    sessionId='s', editMode='review', assistantMessageId='a',
                    message='把页面标题从 React Demo 改成 Gor Demo', previewProjectId=project['id'],
                    previewServerRevision=7, previewContentRevision=0))
                events = await collect_events(response)
                commit.assert_not_called()
            self.assertFalse(any(e['type'] == 'preview_project_committed' for e in events))
            changes = [e for e in events if e['type'] == 'project_file_changed']
            self.assertTrue(changes and all(e['pending'] for e in changes))
            self.assertIn('Gor Demo', changes[0]['diff'])
            record = next(iter(journal.rows.values()))
            self.assertTrue(record['sealed'])
            self.assertEqual(record['editMode'], 'review')
            self.assertTrue(all(f['status'] == 'pending' for f in record['files']))
            self.assertIn('<h1>React Demo</h1>', row['project']['files']['/src/App.tsx'])
        asyncio.run(exercise())

    def test_simple_edit_detector_is_conservative_and_supports_literal_variants(self):
        expected = [
            ("把计数器改成计次器", "计数器", "计次器"),
            ("请把“React Demo”改为“Gor”", "React Demo", "Gor"),
            ("把发送换成提交", "发送", "提交"),
            ("把计次器改回计数器", "计次器", "计数器"),
            ("把页面标题从‘旧标题’修改为‘新标题’", "旧标题", "新标题"),
        ]
        for request, old_text, new_text in expected:
            with self.subTest(request=request):
                detected = _extract_explicit_text_edit(request)
                self.assertIsNotNone(detected)
                self.assertEqual((detected["old_text"], detected["new_text"]), (old_text, new_text))

        bulk = _extract_explicit_text_edit("把所有待办清单改成代办事务")
        self.assertEqual((bulk["old_text"], bulk["new_text"], bulk["replace_all"]), ("待办清单", "代办事务", True))
        # A semantic target alone does not identify an exact old source string.
        self.assertIsNone(_extract_explicit_text_edit("把标题改成欢迎使用 Gor"))
        self.assertIsNone(_extract_explicit_text_edit("把颜色改成紫色"))

    def test_llm_context_audit_counts_snippets_but_not_unseen_project_sources(self):
        workspace = PreviewProjectWorkspace.from_request(large_project())
        prompt = [SystemMessage(content=(
            "【程序预检的 Preview 搜索结果】\nrevision=0\n"
            + json.dumps([{"path": "/src/App.tsx", "line": 45, "snippet": "<h1>React Demo</h1>"}], ensure_ascii=False)
        ))]
        audit = _audit_llm_context(prompt, workspace)
        self.assertEqual(audit["preview_source_chars"], len("<h1>React Demo</h1>"))
        self.assertEqual(audit["project_file_text_matches_in_prompt"], 0)
        self.assertFalse(audit["contains_preview_committed_content"])
        self.assertFalse(audit["contains_preview_file_changed_content"])

    def test_530_line_file_supports_bounded_range_reads(self):
        workspace = PreviewProjectWorkspace.from_request(large_project())
        result = json.loads(workspace.read_file("/src/App.tsx", 30, 60))
        self.assertTrue(result["success"])
        self.assertEqual((result["startLine"], result["endLine"], result["totalLines"]), (30, 60, 530))
        self.assertEqual(len(result["content"].splitlines()), 31)
        self.assertNotIn(SOURCE_SENTINEL, result["content"])

    def test_react_tudo_literal_edit_uses_one_precise_search_and_zero_reads(self):
        async def exercise():
            workspace = PreviewProjectWorkspace.from_request({
                "id": "react-tudo-fast-path",
                "name": "React Demo",
                "template": "react",
                "revision": 3,
                "files": {
                    "/src/App.tsx": "export default function App() {\n  return <h1>React Tudo</h1>;\n}\n",
                    "/src/main.tsx": "import App from './App';\n",
                },
            })
            model = ReactTudoPatchModel()
            usage_callback = __import__("agent.token_callback", fromlist=["TokenCountCallback"]).TokenCountCallback()
            events = []
            with (
                patch("agent.agent.model_with_simple_preview_edit", model),
                patch("agent.agent.get_model_for_tools", return_value=model) as bound_model,
                patch("agent.agent.TYPING_DELAY_MS", 0),
            ):
                await run_agent(
                    [{"role": "user", "content": "把 React Tudo 改成 React Todo Demo"}],
                    events.append,
                    callbacks=[usage_callback],
                    preview_workspace=workspace,
                )
                bound_names = set(bound_model.call_args.args[0])
                self.assertTrue({"web_search", "search_images", "batch_patch_project_files"} <= bound_names)
            return workspace, model, usage_callback.get_usage(), events

        workspace, model, usage, events = asyncio.run(exercise())
        self.assertEqual(workspace.files["/src/App.tsx"].count("<h1>React Todo Demo</h1>"), 1)
        tool_names = [event.get("name") for event in events if event.get("type") == "tool_start"]
        self.assertEqual(tool_names, ["search_preview_code", "batch_patch_preview_files"])
        self.assertEqual(usage["llm_call_count"], 1)
        self.assertEqual(usage["execution_llm_calls"], 1)
        self.assertEqual(usage["final_response_llm_calls"], 0)
        self.assertEqual(usage["search_calls"], 1)
        self.assertEqual(usage["search_queries"], ["React Tudo"])
        self.assertEqual(usage["read_calls"], 0)
        self.assertEqual(usage["range_read_chars"], 0)
        self.assertEqual(usage["full_preview_file_chars"], 0)
        self.assertEqual(usage["batch_patch_calls"], 1)
        self.assertEqual(usage["patch_operations"], 1)
        self.assertEqual([call["reason"] for call in usage["calls"]], ["simple_patch_generation"])
        self.assertEqual(workspace.revision, 4)
        streamed_text = "".join(event.get("content", "") for event in events if event.get("type") == "token")
        self.assertIn("展开 Diff 查看细节", streamed_text)
        estimated_prompt_tokens = sum(
            estimate_tokens(str(getattr(message, "content", ""))) + 4
            for message in model.prompts[0]
        )
        print(
            "[SimpleEditTest] llm_calls=1 search_calls=1 read_calls=0 batch_patch_calls=1 "
            f"estimated_prompt_tokens={estimated_prompt_tokens}"
        )

    def test_530_line_two_turn_patch_keeps_complete_source_out_of_model_history(self):
        async def exercise():
            project = large_project()
            project_row = {"project": copy.deepcopy(project), "revision": 7, "origin": "generated"}
            stored_messages = []
            model = TwoTurnPatchModel()
            next_message_id = 0

            async def save_message(session_id, role, content, token_usage=None, **kwargs):
                nonlocal next_message_id
                next_message_id += 1
                stored_messages.append({
                    "db_message_id": next_message_id,
                    "role": role,
                    "content": content,
                    "images": None,
                    "preview_changes": copy.deepcopy(kwargs.get("preview_changes")),
                })
                return next_message_id

            async def load_messages(session_id):
                return copy.deepcopy(stored_messages)

            async def get_project(session_id):
                return copy.deepcopy(project_row)

            from test_project_changes import Store
            journal = Store()

            async def commit_project(session_id, updated_project, expected_revision, change_record=None):
                if expected_revision != project_row["revision"]:
                    return None
                project_row["project"] = copy.deepcopy(updated_project)
                project_row["revision"] += 1
                if change_record:
                    await journal.put(change_record)
                return {"revision": project_row["revision"]}

            async def build_context(session_id, messages, current_message):
                return {"summary": "", "recent_messages": messages[-29:]}

            async def invoke_turn(text):
                body = chat_route.ChatRequest(
                    editMode="auto",
                    sessionId="preview-context-session",
                    assistantMessageId=f"assistant-{next_message_id}",
                    message=text,
                    previewProjectId=project_row["project"]["id"],
                    previewServerRevision=project_row["revision"],
                    previewContentRevision=project_row["project"]["revision"],
                )
                response = await chat_route.chat(FakeRequest(), body)
                return await collect_events(response)

            with (
                patch.object(chat_route, "change_sets", journal),
                patch("agent.agent.get_model_for_tools", return_value=model),
                patch("agent.agent.model_with_simple_preview_edit", model),
                patch("agent.agent.TYPING_DELAY_MS", 0),
                patch.object(chat_route.context_engine, "build_context", side_effect=build_context),
                patch.object(chat_route, "get_session_preview_project", side_effect=get_project),
                patch.object(chat_route, "update_session_preview_project_if_revision", side_effect=commit_project),
                patch.object(chat_route, "load_messages", side_effect=load_messages),
                patch.object(chat_route, "save_message", side_effect=save_message),
                patch.object(chat_route, "deduct_model_quota", return_value=None),
                patch.object(chat_route, "auto_generate_session_title", return_value=None),
            ):
                first_events = await invoke_turn("把页面标题从 React Demo 改成 Gor Demo")
                second_events = await invoke_turn("把 Gor Demo 改成 Gor")

            return project, project_row, stored_messages, model.prompts, first_events, second_events, journal.rows

        original_project, project_row, stored_messages, prompts, first_events, second_events, journal_rows = asyncio.run(exercise())
        references = [event for events in (first_events, second_events) for event in events if event.get("type") == "change_set"]
        self.assertEqual(len(references), 2)
        self.assertEqual(len({journal_rows[event["changeSetId"]]["messageId"] for event in references}), 2)
        self.assertTrue(all(journal_rows[event["changeSetId"]]["sealed"] for event in references))
        original_source = original_project["files"]["/src/App.tsx"]
        self.assertEqual(len(original_source.splitlines()), 530)
        self.assertIn(SOURCE_SENTINEL, project_row["project"]["files"]["/src/App.tsx"])
        self.assertEqual(project_row["project"]["files"]["/src/App.tsx"].count("<h1>Gor</h1>"), 1)

        commits = [event for event in first_events if event.get("type") == "preview_project_committed"]
        self.assertEqual(len(commits), 1)
        committed_event = commits[0]
        self.assertEqual(set(committed_event), {"type", "projectId", "serverRevision", "contentRevision", "changedFiles"})
        self.assertEqual(set(committed_event["changedFiles"][0]), {"path", "diff"})
        self.assertNotIn("content", committed_event["changedFiles"][0])
        self.assertIn("<h1>Gor Demo</h1>", committed_event["changedFiles"][0]["diff"])

        # Each explicit title edit uses one model call, programmatic search, and one batch patch.
        self.assertEqual(len(prompts), 2)
        self.assertTrue(all(any(
            getattr(message, "type", "") == "system" and "程序预检的 Preview 搜索结果" in str(message.content)
            for message in prompt
        ) for prompt in prompts))
        tool_events = [event for batch in (first_events, second_events) for event in batch if event.get("type") == "tool_start"]
        tool_names = [event.get("name") for event in tool_events]
        self.assertEqual(tool_names.count("search_preview_code"), 2)
        self.assertEqual(tool_names.count("batch_patch_preview_files"), 2)
        self.assertNotIn("list_preview_files", tool_names)
        self.assertNotIn("read_preview_file", tool_names)
        self.assertNotIn("patch_preview_file", tool_names)

        search_results = [
            json.loads(event["result"])
            for batch in (first_events, second_events) for event in batch
            if event.get("type") == "tool_end" and event.get("name") == "search_preview_code"
        ]
        self.assertEqual(len(search_results), 2)
        self.assertEqual(search_results[0][0]["line"], 45)
        self.assertEqual(search_results[0][0]["startLine"], 42)
        self.assertEqual(search_results[0][0]["endLine"], 48)

        # The batch tool's return contains only diffs, and its successful patch ends the run.
        patch_tool_results = [
            json.loads(event["result"])
            for batch in (first_events, second_events) for event in batch
            if event.get("type") == "tool_end" and event.get("name") == "batch_patch_preview_files"
        ]
        self.assertEqual(len(patch_tool_results), 2)
        expected_diffs = [
            ("-  return <main><h1>React Demo</h1></main>;", "+  return <main><h1>Gor Demo</h1></main>;"),
            ("-  return <main><h1>Gor Demo</h1></main>;", "+  return <main><h1>Gor</h1></main>;"),
        ]
        for result, (removed, added) in zip(patch_tool_results, expected_diffs):
            self.assertIn("diff", result)
            self.assertNotIn("content", result)
            self.assertNotIn(SOURCE_SENTINEL, result["diff"])
            self.assertIn(removed, result["diff"])
            self.assertIn(added, result["diff"])

        # The next turn's reconstructed prompt and persistent chat rows contain no full source.
        flattened_prompts = "\n".join(
            str(getattr(message, "content", ""))
            for prompt in prompts for message in prompt
        )
        self.assertNotIn(SOURCE_SENTINEL, flattened_prompts)
        self.assertNotIn(SOURCE_SENTINEL, json.dumps(stored_messages, ensure_ascii=False))
        assistant_rows = [row for row in stored_messages if row["role"] == "assistant"]
        self.assertEqual(len(assistant_rows), 2)
        for row in assistant_rows:
            self.assertEqual(set(row["preview_changes"][0]), {"projectId", "path", "diff"})

        usage_events = [
            event for batch in (first_events, second_events) for event in batch
            if event.get("type") == "token_usage"
        ]
        self.assertEqual(len(usage_events), 2)
        for index, usage in enumerate(usage_events):
            self.assertEqual(usage["llm_call_count"], 1)
            self.assertEqual(usage["search_calls"], 1)
            self.assertEqual(usage["search_queries"], [["React Demo", "Gor Demo"][index]])
            self.assertEqual(usage["read_calls"], 0)
            self.assertEqual(usage["range_read_chars"], 0)
            self.assertEqual(usage["full_preview_file_chars"], 0)
            self.assertEqual(usage["batch_patch_calls"], 1)
            call_audit = usage["calls"][0]
            self.assertEqual(call_audit["reason"], "simple_patch_generation")
            self.assertFalse(call_audit["contains_preview_committed_content"])
            self.assertFalse(call_audit["contains_preview_file_changed_content"])
            self.assertGreater(call_audit["search_snippet_chars"], 0)
        self.assertGreater(usage_events[0]["preview_commit_payload_bytes"], 0)
        legacy_event = {
            "type": "preview_project_committed",
            "projectId": committed_event["projectId"],
            "serverRevision": committed_event["serverRevision"],
            "contentRevision": committed_event["contentRevision"],
            "changedFiles": [{
                "projectId": committed_event["projectId"],
                "path": committed_event["changedFiles"][0]["path"],
                "content": project_row["project"]["files"][committed_event["changedFiles"][0]["path"]],
                "diff": committed_event["changedFiles"][0]["diff"],
            }],
        }
        legacy_bytes = len(json.dumps(legacy_event, ensure_ascii=False).encode("utf-8"))
        compact_bytes = len(json.dumps(committed_event, ensure_ascii=False).encode("utf-8"))
        self.assertLess(compact_bytes, legacy_bytes)

        # Estimate message-content tokens actually presented at every fake model call.
        # This excludes provider-side tool-schema framing and is for comparative validation.
        prompt_token_totals = []
        for prompt in prompts:
            prompt_token_totals.append(sum(
                estimate_tokens(str(getattr(message, "content", ""))) + 4
                for message in prompt
            ))
        print(
            "[PreviewContextTest] lines=530 llm_calls=1_per_turn search=2 batch_patches=2 "
            f"first_turn_estimated_prompt_tokens={prompt_token_totals[0]} "
            f"second_turn_estimated_prompt_tokens={prompt_token_totals[1]} "
            f"commit_bytes={legacy_bytes}->{compact_bytes} full_source_in_next_turn=false"
        )


if __name__ == "__main__":
    unittest.main()
