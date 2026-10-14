"""Text-only input estimates. No prompt, arguments or reasoning are logged."""
import json
from typing import Any

from services.token_estimator import estimate_tokens


def input_token_breakdown(messages: list[Any], tools: list[Any], current: Any,
                          history_ids: set[int]) -> dict[str, int]:
    counts = dict.fromkeys(("system", "history_summary", "recent_history", "current_request",
                            "task_data", "tool_results", "agent_responses"), 0)
    for message in messages:
        content = getattr(message, "content", "")
        text = content if isinstance(content, str) else json.dumps(content, ensure_ascii=False)
        kind = getattr(message, "type", "")
        if message is current:
            category = "current_request"
        elif "<presentation-schema-data>" in text or text.startswith("历史演示文稿数据"):
            category = "task_data"
        elif kind == "system" and text.startswith("【Conversation Context】"):
            category = "history_summary"
        elif id(message) in history_ids:
            category = "recent_history"
        elif kind == "tool":
            category = "tool_results"
        elif kind == "system":
            category = "system"
        else:
            category = "agent_responses"
        counts[category] += estimate_tokens(text)
        calls = getattr(message, "tool_calls", None)
        if calls:
            counts[category] += estimate_tokens(json.dumps(calls, ensure_ascii=False))
    counts["tool_definitions"] = estimate_tokens(json.dumps(tools, ensure_ascii=False)) if tools else 0
    counts["message_overhead"] = len(messages) * 4
    counts["estimated_total"] = sum(counts.values())
    return counts
