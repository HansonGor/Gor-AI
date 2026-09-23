"""
Token 统计回调类
职责：通过 LangChain CallbackHandler 捕获每轮大模型 token 消耗并累加
"""
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

    def on_llm_end(self, response: LLMResult, **kwargs: Any) -> None:
        """大模型执行结束回调"""
        try:
            # LangChain 的 usage 可能在 response.llm_output 中
            llm_output = response.llm_output or {}
            token_usage = llm_output.get("token_usage", {})

            if token_usage:
                prompt = token_usage.get("prompt_tokens", 0)
                completion = token_usage.get("completion_tokens", 0)
                total = token_usage.get("total_tokens", prompt + completion)

                self.prompt_tokens += prompt
                self.completion_tokens += completion
                self.total_tokens += total
                self.last_prompt_tokens = prompt

                print(
                    f"[TokenCallback] 本轮: prompt={prompt}, completion={completion}, total={total} | "
                    f"累计: prompt={self.prompt_tokens}, completion={self.completion_tokens}, total={self.total_tokens}"
                )
        except Exception as e:
            print(f"[TokenCallback] 解析 usage 失败: {e}")

    def get_usage(self) -> Dict[str, int]:
        """获取累加完成的 token 数据"""
        return {
            "prompt_tokens": self.prompt_tokens,
            "completion_tokens": self.completion_tokens,
            "total_tokens": self.total_tokens,
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
