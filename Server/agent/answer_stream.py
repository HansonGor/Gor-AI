"""联网回答边写边显示：逐句核验通过后再推送，不出现"显示后又删除/替换"。

模型以流式输出最终回答时，本模块按行、按句缓冲：
- 句末的 [S#]、"（来源：…）"归前一句，所以要等下一句开头出现（或整行结束）才判定上一句完整；
- 完整的句子用 answer_verifier 同一套规则判断：没有有效来源的事实句直接丢弃、不显示，无效编号剔除；
- 标题先挂起，等该节第一句有效正文出现时一起推送；整节被删空时标题也不显示（与 cleanup 一致）；
- 表格、代码块整块缓冲，结束后按 cleanup 处理再推送；
- 在出现第一个标题或第一句带有效来源的事实句之前，内容只缓冲不推送，
  避免把模型调用工具前的过渡语（"我再查一下"）提前显示出来。

纯文本处理，不联网、不调用模型；send 回调负责把片段作为 token 事件发给前端。
"""
from __future__ import annotations

import re
import time
from typing import Callable

from langchain_core.callbacks import BaseCallbackHandler

from agent import answer_verifier as av

_HEADING_RE = re.compile(r"^\s*#{1,6}\s")


def _complete_sentences(parts: list[str]) -> int:
    """当前行已切出的句子中，前几句可以确定已经完整（后面接着的是新句子的正文）。"""
    if len(parts) < 2:
        return 0
    tail = parts[-1].lstrip()
    # 末段还只是 "[S1" 这样的未写完编号或"（来源"说明，它们可能归前一句，暂不判定
    if not tail or tail.startswith("[") or tail.startswith(("（", "(")):
        return max(0, len(parts) - 2)
    return len(parts) - 1


class StreamingAnswerFilter(BaseCallbackHandler):
    """挂在"写回答"那次模型调用上的回调：逐句核验后再推送正文。"""

    run_inline = True

    def __init__(self, valid_ids: set[str], send: Callable[[str], None]):
        self.valid_ids = set(valid_ids)
        self.send = send
        self.buffer = ""            # 尚未处理完的文本（当前行的剩余部分）
        self.consumed = ""          # 已收到的全部模型正文
        self.output = ""            # 已决定显示的文本（含尚未推送的 held 部分）
        self.held = ""              # started 之前缓冲的显示文本
        self.started = False
        self.stopped = False        # 模型转去调用工具后不再推送
        self.removed = 0
        self.pending_headings: list[str] = []
        self.block: list[str] = []  # 表格或代码块
        self.block_kind = ""
        self.line_sentences_done = 0
        self.line_prefix_done = False
        self.first_sent_at: float | None = None   # 第一段正文推送给前端的时刻（perf_counter）

    def _send(self, text: str) -> None:
        if self.first_sent_at is None:
            self.first_sent_at = time.perf_counter()
        self.send(text)

    # ------------------------------------------------------------ LangChain 回调
    def on_llm_new_token(self, token, *, chunk=None, **kwargs):
        message = getattr(chunk, "message", None)
        if message is not None and getattr(message, "tool_call_chunks", None):
            self.stopped = True
            return
        content = getattr(message, "content", token) if message is not None else token
        if isinstance(content, str) and content and not self.stopped:
            self.feed(content)

    # ------------------------------------------------------------ 推送
    @property
    def emitted_anything(self) -> bool:
        return bool(self.output)

    def _emit(self, text: str) -> None:
        if not text:
            return
        self.output += text
        if self.started:
            self._send(text)
        else:
            self.held += text

    def _start(self) -> None:
        if not self.started:
            self.started = True
            if self.held:
                self._send(self.held)
                self.held = ""

    def _flush_headings(self) -> None:
        for heading in self.pending_headings:
            self._emit(heading.rstrip() + "\n")
        self.pending_headings = []

    def _emit_body(self, text: str, *, start: bool = False) -> None:
        self._flush_headings()
        if start:
            self._start()
        self._emit(text)

    # ------------------------------------------------------------ 逐行逐句处理
    def feed(self, text: str) -> None:
        self.consumed += text
        self.buffer += text
        while "\n" in self.buffer:
            line, self.buffer = self.buffer.split("\n", 1)
            self._finish_line(line)
        self._progress_line(self.buffer)

    def _line_body(self, line: str) -> tuple[str, str]:
        match = av.LIST_PREFIX_RE.match(line)
        prefix = match.group(1) if match else ""
        return prefix, line[len(prefix):]

    def _is_plain_text_line(self, line: str) -> bool:
        stripped = line.strip()
        if not stripped or self.block_kind or stripped.startswith(("#", "|", "```")):
            return False
        prefix, body = self._line_body(line)
        plain = av._plain(body)
        return not (re.match(r"^\[S\d+\]", body.strip()) or plain.startswith(("来源：", "来源:", "参考来源", "参考资料")))

    def _emit_sentence(self, prefix: str, sentence_text: str) -> None:
        sentence = av._sentence(sentence_text, self.valid_ids)
        if sentence.fact and not sentence.valid:
            self.removed += 1
            return
        if not re.search(r"[\w一-鿿]", av._plain(sentence.text)):
            # 只剩标点、编号之类的碎片：跟着本行已显示的内容走，不单独起头
            if not self.line_prefix_done:
                return
        text = av._strip_invalid(sentence.text, self.valid_ids) if sentence.invalid else sentence.text
        if not self.line_prefix_done:
            text = prefix + text.lstrip()
            self.line_prefix_done = True
        self._emit_body(text, start=sentence.fact and bool(sentence.valid))

    def _progress_line(self, partial: str) -> None:
        """当前行还没写完：把已能确定完整的句子先推送出去。"""
        if not self._is_plain_text_line(partial):
            return
        prefix, body = self._line_body(partial)
        parts = av._split_sentences(body)
        ready = _complete_sentences(parts)
        for sentence_text in parts[self.line_sentences_done:ready]:
            self._emit_sentence(prefix, sentence_text)
        self.line_sentences_done = max(self.line_sentences_done, ready)

    def _end_line_state(self) -> None:
        self.line_sentences_done = 0
        self.line_prefix_done = False

    def _finish_line(self, line: str) -> None:
        stripped = line.strip()
        # 代码块、表格整块缓冲
        if self.block_kind == "code":
            self.block.append(line)
            if stripped.startswith("```"):
                self._flush_block()
            return
        if stripped.startswith("```"):
            self._flush_block()
            self.block_kind, self.block = "code", [line]
            return
        if stripped.startswith("|"):
            if self.block_kind != "table":
                self._flush_block()
                self.block_kind = "table"
            self.block.append(line)
            return
        if self.block_kind == "table":
            self._flush_block()

        if not stripped:
            self._end_line_state()
            if self.output and not self.output.endswith("\n\n"):
                self._emit("\n")
            return
        if _HEADING_RE.match(line) or stripped.startswith("#"):
            level = av._heading_level(line)
            # 新标题出现时，同级或更低级、仍未有正文的挂起标题说明那一节被删空了
            self.pending_headings = [h for h in self.pending_headings if av._heading_level(h) < level]
            self.pending_headings.append(line)
            self._end_line_state()
            return
        if not self._is_plain_text_line(line):
            # 参考来源列表等行：整行原样显示
            self._emit_body(line + "\n")
            self._end_line_state()
            return

        prefix, body = self._line_body(line)
        parts = av._split_sentences(body)
        for sentence_text in parts[self.line_sentences_done:]:
            self._emit_sentence(prefix, sentence_text)
        if self.line_prefix_done:
            self._emit("\n")
        self._end_line_state()

    def _flush_block(self) -> None:
        if not self.block:
            self.block_kind = ""
            return
        raw = "\n".join(self.block)
        if self.block_kind == "code":
            self._emit_body(raw + "\n")
        else:
            cleaned, removed = av.cleanup(raw, self.valid_ids)
            self.removed += removed
            if cleaned.strip():
                self._emit_body(cleaned + "\n")
        self.block, self.block_kind = [], ""

    # ------------------------------------------------------------ 收尾
    def finish(self, full_content: str) -> str | None:
        """模型调用结束：补齐未处理的文本并推送剩余部分。

        返回最终显示的正文；整次调用一句都没能流式处理时返回 None，交回原来的整篇核验流程。
        """
        if not self.consumed or (self.stopped and not self.output):
            # 一个字都没有逐字收到（模型不支持流式等）：什么都没显示，交回整篇核验流程（必要时仍可重写）
            return None
        if full_content and full_content.startswith(self.consumed) and len(full_content) > len(self.consumed):
            self.feed(full_content[len(self.consumed):])   # 回调漏掉的尾部
        if self.buffer:
            line, self.buffer = self.buffer, ""
            self._finish_line(line)
        self._flush_block()
        self.pending_headings = []                         # 末尾没有正文的标题不显示
        self._start()
        return self.output.strip()
