"""酌思（auto）：发送时的规则判定、运行中遇到问题升级为深思、思考记录保存实际模式。"""
import asyncio
import json

import pytest
from langchain_core.messages import AIMessage

import agent.agent as agent_module
from agent.thinking_policy import decide_thinking, tool_result_failed
from models.thinking import ThinkingTrace
from tools.web_search import _SEARCH_RESULT_MARKER


# ---------------------------------------------------------------- 规则判定
@pytest.mark.parametrize("text, profile, expected_deep", [
    # 联网、天气、闲聊等简单问题走随思
    ("广州新闻", "web+news_research+web_reader", False),
    ("美国最新爆点新闻", "web+news_research+web_reader", False),
    ("明天广州天气怎么样", "weather", False),
    ("你好", "", False),
    ("帮我找几张西湖的图片", "images", False),
    ("广州陈家祠开放时间", "web", False),
    ("OpenAI 最新发布了什么模型", "web+news_research", False),   # 新闻类已强制先搜索
    # 非新闻的时效性问题：随思易凭记忆作答，走深思
    ("现任美联储主席是谁", "chat", True),        # chat 路由自带不强制的联网兜底
    ("目前央行行长是谁", "web", True),
    ("广州陈家祠开放时间", "chat", False),
    ("antd mobile 的仓库在哪", "github_code", False),
    ("帮我跑一下测试", "workspace_toolchain", False),
    ("查看 src/app.ts 的内容", "vscode_project", False),
    ("知识库里有没有报销流程", "knowledge", False),
    # 修改项目、生成文档等走深思
    ("把首页标题改成红色", "preview", True),
    ("在 utils 里加一个日期格式化函数", "vscode_project_edit", True),
    ("做一份季度汇报 PPT", "presentation", True),
    ("生成一份 Word 周报", "documents", True),
    # 同一类任务里，排查/分析源码升级为深思
    ("测试为什么失败了，帮我排查一下", "workspace_toolchain", True),
    ("讲讲 React useMemo 的实现原理", "github_code", True),
    # 内容复杂度
    ("证明根号 2 是无理数", "", True),
    ("这个算法的时间复杂度是多少", "", True),
    ("帮我设计一个高可用的订单系统架构", "", True),
    ("Vue 和 React 选型怎么权衡", "", True),
    ("A 是什么？B 是什么？C 和 D 有什么区别？", "", True),
    ("帮我看看这段代码\n```python\nprint(1)\n```", "", True),
    ("总结一下这份文件<uploaded-content>内容</uploaded-content>", "", True),
    ("长文" * 500, "", True),
    # 用户明确表态优先于任务类型
    ("仔细想想广州新闻里哪条最重要", "web+news_research", True),
    ("一步步推理这道题", "", True),
    ("简单说下怎么改首页标题", "preview", False),
    ("一句话介绍量子计算", "", False),
])
def test_rules_choose_light_or_deep(text, profile, expected_deep):
    decision = decide_thinking(text, profile)
    assert decision.deep is expected_deep, decision
    assert decision.reason


def test_build_repair_task_starts_deep():
    assert decide_thinking("构建报错了", "preview", task_kind="REPAIR").deep is True


def test_images_make_it_deep():
    assert decide_thinking("这是什么", "", has_images=True).deep is True


def test_short_follow_up_inherits_previous_turn():
    deep_history = [{"role": "user", "content": "帮我设计一个高可用的订单系统架构"},
                    {"role": "assistant", "content": "……"}]
    light_history = [{"role": "user", "content": "广州新闻"}, {"role": "assistant", "content": "……"}]
    assert decide_thinking("继续", "", history=deep_history) == decide_thinking("继续", "", history=deep_history)
    assert decide_thinking("继续", "", history=deep_history).deep is True
    assert decide_thinking("那深圳呢", "web+news_research", history=light_history).deep is False
    assert decide_thinking("继续", "", history=deep_history).reason == "沿用上一轮"


def test_tool_failure_detection():
    assert tool_result_failed('{"success": false, "error": "x"}')
    assert tool_result_failed('{"status": "failed"}')
    assert tool_result_failed('{"error": "timeout"}')
    assert not tool_result_failed('{"success": true, "pages": []}')
    assert not tool_result_failed(_SEARCH_RESULT_MARKER + '{"text": ""}')
    assert not tool_result_failed("北京 晴 20℃")
    assert not tool_result_failed(None)


# ---------------------------------------------------------------- Agent 集成
PAYLOAD = {
    "intent": "news", "query": "国内新闻",
    "results": [
        {"sourceId": "S1", "title": "人民网要闻", "url": "https://example.com/1", "domain": "example.com",
         "snippet": "9月CPI", "provider": "tavily", "providers": ["tavily"], "publishedAt": "2026-10-15"},
        {"sourceId": "S2", "title": "央行发布", "url": "https://example.com/2", "domain": "example.com",
         "snippet": "M2", "provider": "tavily", "providers": ["tavily"], "publishedAt": "2026-10-14"},
    ],
    "providers_used": [["tavily", "preferred"]], "trace": [], "fallback_used": False,
}
UNCITED = "## 国内要闻\n9月CPI同比上涨0.9%。M2余额同比增长7.2%。[S2]"
CITED = "## 国内要闻\n9月CPI同比上涨0.9%。[S1]\nM2余额同比增长7.2%。[S2]"


def run_news(monkeypatch, answers, *, auto_thinking=True):
    calls = []

    class Model:
        def __init__(self, kwargs):
            self.kwargs = kwargs

        async def ainvoke(self, messages, config=None):
            calls.append(self.kwargs)
            step = len(calls)
            if step == 1:
                return AIMessage(content="", tool_calls=[{"id": "s", "name": "web_search", "args": {"query": "国内新闻"}}])
            if step == 2:
                return AIMessage(content="", tool_calls=[{"id": "r", "name": "web_reader", "args": {
                    "urls": ["https://example.com/1", "https://example.com/2"], "query": "国内新闻"}}])
            return AIMessage(content=answers[min(step - 3, len(answers) - 1)])

    async def execute(name, args, *extra):
        if name == "web_search":
            return _SEARCH_RESULT_MARKER + json.dumps({"text": "[S1] 人民网要闻\n[S2] 央行发布", "payload": PAYLOAD})
        return json.dumps({"success": True, "requested_pages": 2, "failures": [], "pages": [
            {"url": "https://example.com/1", "title": "人民网要闻", "body": "9月CPI同比上涨0.9%。" * 20},
            {"url": "https://example.com/2", "title": "央行发布", "body": "M2余额同比增长7.2%。" * 20},
        ]}, ensure_ascii=False)

    monkeypatch.setattr(agent_module, "get_model_for_tools", lambda names, **kwargs: Model(kwargs))
    monkeypatch.setattr(agent_module, "execute_tool", execute)
    monkeypatch.setattr(agent_module, "TYPING_DELAY_MS", 0)
    monkeypatch.setattr(agent_module, "MAX_ITERATIONS", 6)
    events = []
    asyncio.run(agent_module.run_agent([{"role": "user", "content": "最近一周国内有什么重要新闻"}], events.append,
                                       auto_thinking=auto_thinking))
    modes = [e for e in events if e.get("type") == "thinking_mode"]
    return calls, modes


def test_auto_news_runs_light_when_nothing_goes_wrong(monkeypatch):
    calls, modes = run_news(monkeypatch, [CITED])
    assert calls and all(kwargs == {"deep": False} for kwargs in calls)
    assert modes == [{"type": "thinking_mode", "mode": "light", "reason": "联网新闻", "escalated": False}]


def test_auto_escalates_to_deep_when_citation_check_fails(monkeypatch):
    calls, modes = run_news(monkeypatch, [UNCITED, CITED])
    assert len(calls) == 4
    assert calls[:3] == [{"deep": False}] * 3          # 判定为随思
    assert calls[3] == {}                              # 核验未通过后的修订改用深思
    assert [m["mode"] for m in modes] == ["light", "deep"]
    assert modes[1]["escalated"] is True and modes[1]["reason"] == "引用核验未通过"


def test_fixed_modes_never_emit_auto_events(monkeypatch):
    calls, modes = run_news(monkeypatch, [CITED], auto_thinking=False)
    assert modes == [] and all(kwargs == {} for kwargs in calls)


def test_auto_escalates_after_repeated_tool_failures(monkeypatch):
    calls = []

    class Model:
        def __init__(self, kwargs):
            self.kwargs = kwargs

        async def ainvoke(self, messages, config=None):
            calls.append(self.kwargs)
            if len(calls) <= 2:
                return AIMessage(content="", tool_calls=[{"id": f"w{len(calls)}", "name": "get_weather",
                                                          "args": {"city": ["北京", "上海"][len(calls) - 1]}}])
            return AIMessage(content="暂时查不到天气。")

    async def execute(name, args, *extra):
        return json.dumps({"success": False, "error": "天气服务不可用"}, ensure_ascii=False)

    monkeypatch.setattr(agent_module, "get_model_for_tools", lambda names, **kwargs: Model(kwargs))
    monkeypatch.setattr(agent_module, "execute_tool", execute)
    monkeypatch.setattr(agent_module, "TYPING_DELAY_MS", 0)
    events = []
    asyncio.run(agent_module.run_agent([{"role": "user", "content": "北京天气怎么样"}], events.append,
                                       auto_thinking=True))
    assert calls[:2] == [{"deep": False}] * 2
    assert calls[2] == {}
    escalated = [e for e in events if e.get("type") == "thinking_mode" and e.get("escalated")]
    assert escalated and escalated[0]["reason"] == "工具多次执行失败"


# ---------------------------------------------------------------- 思考记录
def test_trace_keeps_resolved_mode_and_initial_reason():
    trace = ThinkingTrace()
    trace.accept({"type": "thinking_mode", "mode": "light", "reason": "联网新闻", "escalated": False})
    assert trace.snapshot()["thinkingMode"] == {"mode": "light", "reason": "联网新闻", "escalated": False}
    trace.accept({"type": "thinking_mode", "mode": "deep", "reason": "引用核验未通过", "escalated": True})
    assert trace.snapshot()["thinkingMode"] == {
        "mode": "deep", "reason": "引用核验未通过", "escalated": True, "initialReason": "联网新闻"}


def test_trace_without_auto_has_no_mode_field():
    assert "thinkingMode" not in ThinkingTrace().snapshot()
