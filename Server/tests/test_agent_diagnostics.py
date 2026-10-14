import io
import json
import unittest
from contextlib import redirect_stdout
from types import SimpleNamespace

from agent.agent import _log_llm_response_diagnostics
from services.context_audit import input_token_breakdown
from langchain_core.messages import HumanMessage, AIMessage, SystemMessage, ToolMessage


class AgentDiagnosticsTest(unittest.TestCase):
    def test_input_breakdown_keeps_categories_and_messages_intact(self):
        old = HumanMessage(content="旧预算4000元")
        current = HumanMessage(content="当前请求不可删改")
        messages = [SystemMessage(content="系统规则"),
                    SystemMessage(content="【Conversation Context】\n已确认天数"),
                    old, HumanMessage(content="<presentation-schema-data>旧稿</presentation-schema-data>"),
                    current, AIMessage(content="", tool_calls=[{"name": "web_search", "args": {"query": "test"}, "id": "1"}]),
                    ToolMessage(content="查询证据", tool_call_id="1")]
        original = [m.model_dump() for m in messages]
        counts = input_token_breakdown(messages, [{"name": "web_search"}], current, {id(old)})
        for category in ("system", "history_summary", "recent_history", "current_request",
                         "task_data", "tool_results", "agent_responses", "tool_definitions"):
            self.assertGreater(counts[category], 0)
        self.assertEqual(counts["estimated_total"], sum(v for k, v in counts.items() if k != "estimated_total"))
        self.assertEqual([m.model_dump() for m in messages], original)

    def test_logs_call_shape_and_safe_usage_without_content(self):
        response = SimpleNamespace(
            response_metadata={
                "finish_reason": "length",
                "token_usage": {"prompt_tokens": 120, "completion_tokens": 42, "total_tokens": 162},
            },
            usage_metadata={"input_tokens": 120, "output_tokens": 42, "total_tokens": 162},
            tool_calls=[{"name": "create_ppt", "args": {"title": "PRIVATE_TITLE", "slides": [1, 2]}}],
            invalid_tool_calls=[{"name": "create_ppt", "args": "PRIVATE_ARGUMENTS", "error": "JSON decode failed near PRIVATE_VALUE"}],
        )
        output = io.StringIO()
        with redirect_stdout(output):
            _log_llm_response_diagnostics(response, call=3, phase="final_response", model_id="test-model")

        line = output.getvalue().strip()
        self.assertTrue(line.startswith("[LLMCallDiagnostics] "))
        record = json.loads(line.removeprefix("[LLMCallDiagnostics] "))
        self.assertEqual(record["call"], 3)
        self.assertEqual(record["phase"], "final_response")
        self.assertEqual(record["model"], "test-model")
        self.assertEqual(record["finish_reason"], "length")
        self.assertEqual(record["usage"]["prompt_tokens"], 120)
        self.assertEqual(record["usage"]["completion_tokens"], 42)
        self.assertEqual(record["tool_names"], ["create_ppt"])
        self.assertGreater(record["tool_argument_chars"][0], 0)
        self.assertEqual(record["invalid_tools"], [{"name": "create_ppt", "reason": "json_parse_error"}])
        self.assertNotIn("PRIVATE_", line)
        self.assertNotIn("PRIVATE_TITLE", line)


if __name__ == "__main__":
    unittest.main()
