"""工具轮次用完后：不带工具再调用一次模型作答；只对查询/只读类运行生效。"""

import asyncio
import json

import pytest
from langchain_core.messages import AIMessage, SystemMessage

import agent.agent as agent_module
from tools.web_search import _SEARCH_RESULT_MARKER

PAYLOAD = {"query": "q", "results": [
    {"title": "气象台", "url": "https://example.com/1", "source_id": "S1", "snippet": "明天广州多云，降雨概率 17%"},
]}
LIMIT_NOTICE = "已达到最大工具调用轮次限制"


def run(monkeypatch, *, tool_name="web_search", wrap_answer="明天广州多云，降雨概率 17%。[S1]", wrap_error=None,
        iterations=3, answer_at=None, signal=None, after_execute=None):
    """每次带工具的调用都再发起一个工具调用（模拟模型一直在查）；无工具调用返回收尾回答。"""
    calls = []

    class ToolModel:
        async def ainvoke(self, messages, config=None):
            calls.append({"tools": True, "messages": list(messages)})
            number = len([c for c in calls if c["tools"]])
            if answer_at == number:
                return AIMessage(content="这是正常的最终回答。")
            args = {"query": f"广州天气 {number}"} if tool_name == "web_search" else {"city": "广州"}
            if tool_name == "create_word":
                args = {"title": "t", "content": "c"}
            return AIMessage(content="", tool_calls=[{"id": f"t{number}", "name": tool_name, "args": args}])

    class WrapUpModel:
        async def ainvoke(self, messages, config=None):
            calls.append({"tools": False, "messages": list(messages)})
            if wrap_error:
                raise wrap_error
            return AIMessage(content=wrap_answer)

    factory_calls = []

    def factory(names, **kwargs):
        factory_calls.append((tuple(names), kwargs))
        return WrapUpModel() if not names else ToolModel()

    async def execute(name, args, *extra):
        if after_execute:
            after_execute(name, args)
        if name == "web_search":
            return _SEARCH_RESULT_MARKER + json.dumps({"text": "[S1] 气象台", "payload": PAYLOAD})
        if name == "get_weather":
            return "查询天气失败：高德天气：请求超时；备用来源 wttr.in：请求超时。"
        return "文档已生成"

    monkeypatch.setattr(agent_module, "get_model_for_tools", factory)
    monkeypatch.setattr(agent_module, "execute_tool", execute)
    monkeypatch.setattr(agent_module, "TYPING_DELAY_MS", 0)
    monkeypatch.setattr(agent_module, "MAX_ITERATIONS", iterations)
    events = []
    asyncio.run(agent_module.run_agent([{"role": "user", "content": "明天广州下雨吗"}], events.append, signal=signal))
    visible = "".join(e.get("content", "") for e in events if e.get("type") == "token")
    return calls, factory_calls, visible, events


def test_exhausted_research_run_gets_one_tool_free_answer(monkeypatch):
    calls, factory_calls, visible, events = run(monkeypatch)
    assert [c["tools"] for c in calls] == [True, True, True, False]
    assert factory_calls[-1][0] == ()                       # 收尾调用不带任何工具
    wrap_messages = calls[-1]["messages"]
    assert isinstance(wrap_messages[-1], SystemMessage) and "现在不能再调用任何工具" in wrap_messages[-1].content
    assert "不要猜测、不要编造" in wrap_messages[-1].content
    assert visible == "明天广州多云，降雨概率 17%。[S1]"
    assert LIMIT_NOTICE not in visible
    # 思考面板：收尾调用作为 final_response 的一轮出现
    starts = [e for e in events if e.get("type") == "thinking_start"]
    phases = [e for e in events if e.get("type") == "thinking_update" and e.get("phase") == "final_response"]
    assert starts[-1]["roundId"] == str(len(calls)) and phases and phases[-1]["roundId"] == str(len(calls))


def test_wrap_up_answer_is_cleaned_by_citation_verifier(monkeypatch):
    answer = "明天广州多云，降雨概率 17%。[S1]\n另据报道降水量将达 80 毫米。"
    calls, _, visible, events = run(monkeypatch, wrap_answer=answer)
    assert len(calls) == 4                                   # 收尾不再追加修订轮
    assert "80 毫米" not in visible
    assert visible.startswith("明天广州多云，降雨概率 17%。[S1]")
    assert "已删除" not in visible
    verification = [e for e in events if e.get("type") == "answer_verification"]
    assert verification and verification[0]["revised"] is False and verification[0]["removedSentences"] == 1


def test_weather_failure_run_also_wraps_up_and_is_not_verified(monkeypatch):
    # get_weather 不属于纯检索工具集合：不做引用核验，但仍然要给出答复
    calls, _, visible, events = run(monkeypatch, tool_name="get_weather",
                                    wrap_answer="天气服务暂时不可用，没能查到明天的预报，建议查看中国天气网。")
    assert [c["tools"] for c in calls] == [True, True, True, False]
    assert visible == "天气服务暂时不可用，没能查到明天的预报，建议查看中国天气网。"
    assert not [e for e in events if e.get("type") == "answer_verification"]


def test_wrap_up_failure_or_empty_answer_falls_back_to_honest_message(monkeypatch):
    for kwargs in ({"wrap_error": RuntimeError("provider down")}, {"wrap_answer": "   "}):
        _, _, visible, _ = run(monkeypatch, **kwargs)
        assert visible == agent_module.WRAP_UP_FALLBACK
        assert LIMIT_NOTICE not in visible


def test_runs_that_write_or_generate_keep_the_original_notice_without_extra_call(monkeypatch):
    calls, _, visible, _ = run(monkeypatch, tool_name="create_word")
    assert [c["tools"] for c in calls] == [True, True, True]
    assert visible.endswith("（已达到最大工具调用轮次限制）")


def test_answer_on_the_last_iteration_is_not_treated_as_exhausted(monkeypatch):
    # 旧逻辑只看 iterations<=0：第 3 轮正常作答后仍会追加“已达到最大轮次”提示
    calls, _, visible, _ = run(monkeypatch, answer_at=3)
    assert [c["tools"] for c in calls] == [True, True, True]
    assert visible == "这是正常的最终回答。"


def test_cancelled_runs_do_not_start_a_wrap_up_call(monkeypatch):
    class Signal:
        value = False

        def is_set(self):
            return self.value

    signal = Signal()

    def cancel_after_second_search(name, args):
        if args.get("query", "").endswith("2"):
            signal.value = True

    # 取消后循环检测到信号就中断，不应再调用模型收尾
    calls, _, visible, _ = run(monkeypatch, signal=signal, iterations=5, after_execute=cancel_after_second_search)
    assert calls and all(c["tools"] for c in calls)
    assert "已中断" in visible and agent_module.WRAP_UP_FALLBACK not in visible
