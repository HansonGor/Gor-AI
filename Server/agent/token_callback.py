"""
Token 统计回调类
职责：通过 LangChain CallbackHandler 捕获每轮大模型 token 消耗并累加
"""
import json
from typing import Any, Dict, List, Optional
from langchain_core.callbacks import BaseCallbackHandler
from langchain_core.outputs import LLMResult

from config import config


class TokenCountCallback(BaseCallbackHandler):
    """
    Token 统计回调
    - 重写 handle_llm_end 方法，每轮大模型执行结束累加 usage
    - Agent 多轮工具调用时，每一次大模型请求都会产生一组 usage，需要累加
    """

    def __init__(self):
        self.prompt_tokens = 0
        self.completion_tokens = 0
        self.total_tokens = 0
        self.last_prompt_tokens = 0  # 记录最后一轮的 prompt_tokens，用于上下文剩余计算
        self.calls: List[Dict[str, Any]] = []
        self._unmatched_calls: List[Dict[str, Any]] = []
        self.preview_tool_calls = 0
        self.search_calls = 0
        self.read_calls = 0
        self.patch_calls = 0
        self.batch_patch_calls = 0
        self.patch_operations = 0
        self.search_queries: List[str] = []
        self.range_read_chars = 0
        self.full_preview_file_chars = 0
        self.read_reasons: List[str] = []

    def begin_call(self, reason: str, context_audit: Optional[Dict[str, Any]] = None) -> None:
        record = {"index": len(self.calls) + 1, "prompt_tokens": 0, "completion_tokens": 0, "reason": reason}
        if context_audit:
            record.update({
                key: context_audit.get(key)
                for key in (
                    "contains_preview_committed_content",
                    "contains_preview_file_changed_content",
                    "preview_source_chars",
                    "search_snippet_chars",
                    "range_read_chars",
                    "project_file_text_matches_in_prompt",
                    "committed_content_chars",
                    "preview_file_changed_chars",
                )
            })
        self.calls.append(record)
        self._unmatched_calls.append(record)
        print(f"[AgentLoop] call={record['index']} reason={reason}")

    def record_tool_call(
        self,
        name: str,
        result: Any = None,
        *,
        args: Optional[Dict[str, Any]] = None,
        reason: Optional[str] = None,
    ) -> None:
        print(f"[AgentLoop] tool={name}")
        if name in {"list_preview_files", "search_preview_code", "read_preview_file", "write_preview_file", "patch_preview_file", "batch_patch_preview_files"}:
            self.preview_tool_calls += 1
        if name == "search_preview_code":
            self.search_calls += 1
            query = args.get("query") if isinstance(args, dict) else None
            if isinstance(query, str):
                self.search_queries.append(query)
        elif name == "read_preview_file":
            self.read_calls += 1
            if reason:
                self.read_reasons.append(reason)
            try:
                payload = result if isinstance(result, dict) else json.loads(result) if isinstance(result, str) else {}
                content = payload.get("content", "") if isinstance(payload, dict) and payload.get("success") else ""
                if isinstance(content, str):
                    read_args = args if isinstance(args, dict) else {}
                    if read_args.get("start_line") is None and read_args.get("end_line") is None:
                        self.full_preview_file_chars += len(content)
                    else:
                        self.range_read_chars += len(content)
            except (ValueError, TypeError):
                pass
        if name == "patch_preview_file":
            self.patch_calls += 1
            self.patch_operations += 1
        elif name == "batch_patch_preview_files":
            self.batch_patch_calls += 1
            try:
                payload = result if isinstance(result, dict) else json.loads(result) if isinstance(result, str) else {}
                if payload.get("success"):
                    self.patch_operations += int(payload.get("patchCount", 0) or 0)
            except (ValueError, TypeError):
                pass

    def on_llm_end(self, response: LLMResult, **kwargs: Any) -> None:
        """大模型执行结束回调"""
        try:
            # LangChain 的 usage 可能在 response.llm_output 中
            llm_output = response.llm_output or {}
            token_usage = llm_output.get("token_usage", {})
            if not token_usage and response.generations and response.generations[0]:
                usage = getattr(response.generations[0][0].message, "usage_metadata", None) or {}
                if usage:
                    token_usage = {"prompt_tokens": usage.get("input_tokens", 0),
                                   "completion_tokens": usage.get("output_tokens", 0),
                                   "total_tokens": usage.get("total_tokens", 0)}

            record = self._unmatched_calls.pop(0) if self._unmatched_calls else None
            if token_usage:
                prompt = int(token_usage.get("prompt_tokens", 0) or 0)
                completion = int(token_usage.get("completion_tokens", 0) or 0)
                total = token_usage.get("total_tokens", prompt + completion)

                self.prompt_tokens += prompt
                self.completion_tokens += completion
                self.total_tokens += total
                self.last_prompt_tokens = prompt
                if record is not None:
                    record["prompt_tokens"] = prompt
                    record["completion_tokens"] = completion

                print(
                    f"[AgentLoop] call={record['index'] if record else '?'} "
                    f"reason={record['reason'] if record else 'unknown'} prompt_tokens={prompt} completion_tokens={completion} | "
                    f"累计: prompt={self.prompt_tokens}, completion={self.completion_tokens}, total={self.total_tokens}"
                )
            elif record is not None:
                print(f"[AgentLoop] call={record['index']} reason={record['reason']} prompt_tokens=unavailable")
        except Exception as e:
            print(f"[TokenCallback] 解析 usage 失败: {e}")

    def record_presentation_usage(self, usage: "TokenCountCallback") -> None:
        """Charge presentation requests without changing Agent context accounting."""
        self.prompt_tokens += usage.prompt_tokens
        self.completion_tokens += usage.completion_tokens
        self.total_tokens += usage.total_tokens
        for call in usage.calls:
            self.calls.append({**call, "index": len(self.calls) + 1})

    def get_usage(self) -> Dict[str, Any]:
        """获取累加完成的 token 数据"""
        return {
            "prompt_tokens": self.prompt_tokens,
            "completion_tokens": self.completion_tokens,
            "total_tokens": self.total_tokens,
            "llm_call_count": len(self.calls),
            "calls": [dict(call) for call in self.calls],
            "last_prompt_tokens": self.last_prompt_tokens,
            "execution_llm_calls": sum(1 for call in self.calls if call["reason"] not in {"final_response", "thinking_summary"}),
            "final_response_llm_calls": sum(1 for call in self.calls if call["reason"] == "final_response"),
            "preview_tool_calls": self.preview_tool_calls,
            "search_calls": self.search_calls,
            "read_calls": self.read_calls,
            "patch_calls": self.patch_calls,
            "batch_patch_calls": self.batch_patch_calls,
            "patch_operations": self.patch_operations,
            "search_queries": list(self.search_queries),
            "range_read_chars": self.range_read_chars,
            "full_preview_file_chars": self.full_preview_file_chars,
            "read_reason": list(dict.fromkeys(self.read_reasons)),
        }

    def get_context_remain(self) -> Dict[str, Any]:
        """获取上下文剩余信息"""
        max_context = config.Context.MAX_CONTEXT
        used_prompt = self.last_prompt_tokens
        remain_token = max_context - used_prompt
        warning = remain_token <= config.Context.WARNING_THRESHOLD

        return {
            "prompt_tokens": used_prompt,
            "max_context": max_context,
            "remain_token": remain_token,
            "warning": warning,
        }
