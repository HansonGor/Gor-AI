import asyncio
from types import SimpleNamespace

import pytest
from langchain_core.messages import AIMessage, AIMessageChunk
from langchain_core.outputs import ChatGeneration, ChatGenerationChunk, LLMResult

from models.thinking import ThinkingAdapter, ThinkingChatOpenAI, ThinkingTrace, reasoning_text, model_presentation
from agent.token_callback import TokenCountCallback


def test_provider_conversion_preserves_reasoning_and_tool_chunks():
    model = ThinkingChatOpenAI(model="test", api_key="test", streaming=True)
    result = model._convert_chunk_to_generation_chunk({"choices": [{"delta": {
        "reasoning_content": "真实推理", "content": "", "tool_calls": [{"index": 0,
        "id": "call-1", "type": "function", "function": {"name": "read_project_file", "arguments": "{}"}}]}}]}, AIMessageChunk, None)
    assert result.message.additional_kwargs["reasoning_content"] == "真实推理"
    assert result.message.tool_call_chunks[0]["name"] == "read_project_file"
    response = model._create_chat_result({"choices": [{"message": {"role": "assistant",
        "content": "正文", "reasoning_content": "真实推理"}, "finish_reason": "stop"}], "usage": {}})
    assert response.generations[0].message.content == "正文"
    assert response.generations[0].message.additional_kwargs["reasoning_content"] == "真实推理"


def test_only_provider_reasoning_or_summary_is_extracted():
    assert reasoning_text({"content": "普通回答"}) == ""
    assert reasoning_text({"reasoning_details": [
        {"type": "reasoning.text", "text": "OpenRouter 思考"},
        {"type": "reasoning.encrypted", "data": "private"},
    ]}) == "OpenRouter 思考"
    assert reasoning_text({"content": [{"type": "text", "text": "正文"},
        {"type": "thinking", "thinking": "Claude 摘要"},
        {"type": "reasoning", "summary": [{"type": "summary_text", "text": "OpenAI 摘要"}]}]}) == "Claude 摘要OpenAI 摘要"


def test_five_real_agent_calls_keep_tool_loop_and_separate_thinking(monkeypatch):
    import agent.agent as agent
    calls = []
    class Model:
        async def ainvoke(self, messages, config=None):
            index = len(calls) + 1
            calls.append(index)
            observer = config["callbacks"][-1]
            observer.on_llm_new_token("", chunk=ChatGenerationChunk(message=AIMessageChunk(
                content="", additional_kwargs={"reasoning_content": f"思考{index}"})))
            tools = [{"id": f"tool-{index}", "name": "get_weather", "args": {"city": f"城市{index}"}}] if index < 5 else []
            return AIMessage(content="回答" if index == 5 else "", tool_calls=tools,
                             additional_kwargs={"reasoning_content": f"思考{index}"})
    async def tool(*args, **kwargs):
        return '{"success":true,"weather":"晴"}'
    monkeypatch.setattr(agent, "get_model_for_tools", lambda names: Model())
    monkeypatch.setattr(agent, "execute_tool", tool)
    monkeypatch.setattr(agent, "TYPING_DELAY_MS", 0)
    events = []
    asyncio.run(agent.run_agent([{"role": "user", "content": "查询天气并总结"}], events.append))
    assert len(calls) == 5
    assert len([e for e in events if e["type"] == "tool_start"]) == 4
    assert [e["roundId"] for e in events if e["type"] == "thinking_start"] == [str(i) for i in range(1, 6)]
    trace = ThinkingTrace()
    for event in events:
        trace.accept(event)
    assert len(trace.rounds) == 5
    assert trace.rounds[-1]["content"] == "思考5"  # no duplicate aggregated response
    assert trace.status == "interrupted"  # model end does not finish the Agent run


@pytest.mark.parametrize("exception", [RuntimeError, asyncio.CancelledError])
def test_failure_and_cancellation_end_only_model_call(exception):
    events = []
    class Model:
        async def ainvoke(self, messages, config=None):
            config["callbacks"][-1].observe(AIMessage(content="", additional_kwargs={"reasoning_content": "已收到"}))
            raise exception()
    with pytest.raises(exception):
        asyncio.run(ThinkingAdapter(events.append, 1).invoke(Model(), [], []))
    assert [e["type"] for e in events] == ["thinking_start", "thinking_delta", "thinking_end"]
    assert events[1]["content"] == "已收到"


def test_streaming_usage_keeps_existing_token_accounting():
    callback = TokenCountCallback()
    callback.begin_call("initial_response")
    callback.on_llm_end(LLMResult(generations=[[ChatGeneration(message=AIMessage(content="answer",
        usage_metadata={"input_tokens": 10, "output_tokens": 6, "total_tokens": 16}))]]))
    assert callback.get_usage()["total_tokens"] == 16
    assert callback.last_prompt_tokens == 10


def test_display_history_upsert_does_not_overwrite_message_or_diffs(monkeypatch):
    import db.supabase_chat as db
    captured = []
    class Connection:
        async def execute(self, query, *args):
            captured.append((query, args))
    class Acquire:
        async def __aenter__(self): return Connection()
        async def __aexit__(self, *args): pass
    async def pool(): return SimpleNamespace(acquire=lambda: Acquire())
    monkeypatch.setattr(db, "get_pool", pool)
    asyncio.run(db.save_thinking_trace("session", "message", {"rounds": [{"id": "1", "content": "内容"}], "status": "failed"}))
    update = captured[0][0].split("DO UPDATE SET")[1]
    assert update.strip() == "thinking_trace = EXCLUDED.thinking_trace"
    assert captured[0][1][:2] == ("session", "message")


@pytest.mark.parametrize("outcome", ["completed", "failed", "cancelled"])
def test_real_sse_route_finishes_after_all_rounds_and_persists_actual_outcome(monkeypatch, outcome):
    from unittest.mock import AsyncMock
    from routes import chat as route
    from test_project_changes import Store
    from test_preview_context_flow import FakeRequest, collect_events
    persisted = AsyncMock()
    async def run(messages, send_event, *args, **kwargs):
        for index in range(1, 6):
            for kind in ("thinking_start", "thinking_delta", "thinking_end"):
                send_event({"type": kind, "roundId": str(index), "content": f"内容{index}" if kind == "thinking_delta" else ""})
            send_event({"type":"tool_start", "name":"read_project_file", "args":'{"path":"/src/App.tsx"}'})
            send_event({"type":"tool_end", "name":"read_project_file", "result":'{"success":true}'})
        await asyncio.sleep(0)
        if outcome == "failed": raise RuntimeError("执行失败")
        if outcome == "cancelled": raise asyncio.CancelledError()
        send_event({"type": "token", "content": "最终正文"})
    monkeypatch.setattr(route, "run_agent", run)
    monkeypatch.setattr(route, "change_sets", Store())
    monkeypatch.setattr(route.context_engine, "build_context", AsyncMock(return_value={"summary": "", "recent_messages": []}))
    for name, value in [("get_session_preview_project", None), ("load_messages", []),
                        ("save_message", 1), ("deduct_model_quota", None), ("auto_generate_session_title", None)]:
        monkeypatch.setattr(route, name, AsyncMock(return_value=value))
    monkeypatch.setattr(route, "save_thinking_trace", persisted)
    async def exercise():
        response = await route.chat(FakeRequest(), route.ChatRequest(sessionId="s", message="验收",
            assistantMessageId="a", editMode="auto"))
        return await collect_events(response)
    events = asyncio.run(exercise())
    assert len([e for e in events if e["type"] == "thinking_start"]) == 5
    assert [e["type"] for e in events].index("done") > max(i for i, e in enumerate(events) if e["type"] == "thinking_end")
    assert persisted.await_args.args[:2] == ("s", "a")
    trace = persisted.await_args.args[2]
    assert trace["status"] == outcome
    assert len(trace["rounds"]) == 5
    assert all(r["title"] == "读取 App.tsx" and r["source"] == "tool" for r in trace["rounds"])
    updates = [e for e in events if e["type"] == "thinking_update"]
    assert len(updates) == 10
    assert updates[0]["roundId"] == "1"
    assert trace["rounds"][-1]["content"] == "内容5"
    if outcome == "failed": assert any(e["type"] == "error" for e in events)
    else: assert events[-1]["status"] == outcome



def test_adapter_never_requests_summary_and_keeps_decision(monkeypatch):
    import models.model as models
    def forbidden(): raise AssertionError("extra LLM request")
    monkeypatch.setattr(models, "get_streaming_llm", forbidden)
    decision = AIMessage(content="正文", additional_kwargs={"reasoning_content": "I need to read App.tsx"})
    class Model:
        calls = 0
        async def ainvoke(self, messages, config=None):
            self.calls += 1
            return decision
    model = Model()
    events = []
    result = asyncio.run(ThinkingAdapter(events.append, 1).invoke(model, [], []))
    assert result is decision
    assert model.calls == 1
    assert events[0]["type"] == "thinking_start"
    assert any(e.get("source") == "model" for e in events)
    assert events[-1]["type"] == "thinking_end"


def test_no_content_still_begins_round_without_placeholder_summary():
    class Model:
        async def ainvoke(self, messages, config=None): return AIMessage(content="正文")
    events = []
    asyncio.run(ThinkingAdapter(events.append, 1).invoke(Model(), [], []))
    assert events == [{"type":"thinking_start", "roundId":"1"}, {"type":"thinking_end", "roundId":"1"}]


def test_real_tool_projection_has_priority_and_freezes_previous_round():
    trace = ThinkingTrace()
    trace.accept({"type":"thinking_start", "roundId":"1"})
    trace.accept({"type":"thinking_update", "roundId":"1", "source":"model", **model_presentation("准备读取文件")})
    trace.accept({"type":"thinking_end", "roundId":"1"})
    start = trace.accept({"type":"tool_start", "name":"read_project_file", "args":'{"path":"/src/App.tsx"}'})
    assert start["title"] == "读取 App.tsx"
    assert "正在读取文件" in start["summary"]
    trace.accept({"type":"thinking_update", "roundId":"1", "source":"model", "title":"分析依赖"})
    assert trace.rounds[0]["title"] == "读取 App.tsx"
    end = trace.accept({"type":"tool_end", "name":"read_project_file", "result":'{"success":false,"error":"missing"}'})
    assert "未成功" in end["summary"]
    assert "已返回成功" not in end["summary"]
    previous = dict(trace.rounds[0])
    trace.accept({"type":"tool_start", "name":"web_search", "args":'{}'})
    previous = dict(trace.rounds[0])
    trace.accept({"type":"thinking_start", "roundId":"2"})
    assert trace.accept({"type":"tool_end", "name":"web_search", "result":'{"success":true}'}) is None
    assert trace.accept({"type":"thinking_update", "roundId":"1", "title":"过期"}) is None
    assert trace.rounds[0] == previous
    assert "summary" not in trace.rounds[1]


def test_results_unknown_tools_and_pending_file_operations_are_truthful():
    trace = ThinkingTrace()
    trace.accept({"type":"thinking_start", "roundId":"1"})
    trace.accept({"type":"tool_start", "name":"patch_project_file", "args":'{"path":"/src/App.tsx"}'})
    pending = trace.accept({"type":"project_file_changed", "path":"/src/App.tsx", "pending":True})
    assert pending["title"] == "准备修改 App.tsx"
    assert "尚未写入" in pending["summary"]
    trace.accept({"type":"tool_end", "name":"patch_project_file", "result":'{"success":true}'})
    assert "仍待确认" in trace.rounds[0]["summary"]
    assert "尚未写入" in trace.rounds[0]["summary"]
    trace.accept({"type":"tool_start", "name":"patch_project_file", "args":'{}'})
    trace.accept({"type":"tool_end", "name":"patch_project_file", "result":"未产生文件变更。"})
    assert "未产生文件变更" in trace.rounds[0]["summary"]
    trace.accept({"type":"tool_start", "name":"custom_tool", "args":"malformed"})
    result = trace.accept({"type":"tool_end", "name":"custom_tool", "result":"ordinary text"})
    assert result["title"] == "调用工具"
    assert "尚未确认是否成功" in result["summary"]
    assert trace.accept({"type":"tool_progress", "name":"custom_tool"}) is None


def test_model_keywords_alone_do_not_claim_actions():
    assert model_presentation("App.tsx TypeScript dependency") == {}
    assert model_presentation("I should not read App.tsx") == {}
    assert model_presentation("无需检查 TypeScript") == {}
    assert model_presentation("I need to check TypeScript") ["title"] == "分析类型检查"
    assert "尚不代表工具已执行" in model_presentation("准备读取 App.tsx")["summary"]


def test_phase_and_provider_summary_are_events_not_model_requests():
    events = []
    class Model:
        async def ainvoke(self, messages, config=None):
            return AIMessage(content=[{"type":"reasoning", "summary":[{"text":"准备核对组件依赖。"}]}])
    asyncio.run(ThinkingAdapter(events.append, 1, phase="final_response").invoke(Model(), [], []))
    assert events[0]["type"] == "thinking_start"
    assert events[1]["source"] == "phase"
    assert events[1]["title"] == "整理答复"
    assert any(e.get("summary") == "准备核对组件依赖。" for e in events)


def test_terminal_trace_does_not_accept_late_execution_receipts():
    trace = ThinkingTrace()
    trace.accept({"type":"thinking_start", "roundId":"1"})
    trace.status = "cancelled"
    assert trace.accept({"type":"tool_start", "name":"read_project_file", "args":'{}'}) is None
    assert trace.rounds[0] == {"id":"1", "content":"", "ended":False}


def test_provider_summary_waits_for_complete_sentence_and_rejects_unconfirmed_actions():
    events = []
    adapter = ThinkingAdapter(events.append, 1)
    for piece in ['准备','核对组件依赖','。']:
        adapter.observe(AIMessageChunk(content=[{"type":"reasoning", "summary":[{"text":piece}]}]))
    updates = [e for e in events if e["type"] == "thinking_update" and "summary" in e]
    assert updates[-1]["summary"] == "准备核对组件依赖。"
    assert not any(e.get("summary") in {'准备','核对组件依赖'} for e in updates)
    adapter.observe(AIMessageChunk(content=[{"type":"reasoning", "summary":[{"text":"已修改文件。"}]}]))
    assert not any('已修改' in e.get('summary','') for e in events)
