"""Observe reasoning and project real execution events; never request another LLM."""
import json
import re
from langchain_core.callbacks import BaseCallbackHandler
from langchain_openai import ChatOpenAI


def object_value(value):
    if isinstance(value, dict):
        return value
    try:
        result = json.loads(value)
        return result if isinstance(result, dict) else {}
    except (ValueError, TypeError):
        return {}


def short(value, limit=100):
    return re.sub(r"[\r\n\t]+", " ", value).strip()[:limit] if isinstance(value, str) else ""


def model_presentation(text):
    """Conservative intent labels, not claims that the planned tool has run."""
    if re.search(r"(?:不要|无需|不需要|不必|不能|should not|don't|do not|no need to)", text, re.I):
        return {}
    patterns = (
        (r"(?:TypeScript|类型检查|类型错误|tsc)", "类型检查"),
        (r"(?:依赖|dependencies|dependency)", "组件依赖"),
        (r"(?:项目结构|文件结构|directory structure|project structure)", "项目结构"),
        (r"(?:修改方案|修改计划|implementation plan)", "修改方案"),
        (r"(?:验证|测试|verify|verification|tests?\b)", "验证方案"),
        (r"(?:读取|read\b|inspect\b)", "文件读取方案"),
    )
    # Require an explicit planning marker; keywords alone are not evidence.
    if not re.search(r"(?:准备|计划|需要|先|接下来|should|need to|plan to|will |let me)", text, re.I):
        return {}
    for pattern, topic in patterns:
        if re.search(pattern, text, re.I):
            return {"title": "分析" + topic, "summary": "正在分析" + topic + "，此处为模型计划，尚不代表工具已执行。"}
    return {}


TOOL_ACTIONS = {
    "list_project_files": ("检查项目文件结构", "检查项目文件结构"),
    "list_preview_files": ("检查项目文件结构", "检查项目文件结构"),
    "read_project_file": ("读取", "读取文件"), "read_preview_file": ("读取", "读取文件"),
    "search_project_code": ("搜索项目代码", "搜索项目代码"), "search_preview_code": ("搜索项目代码", "搜索项目代码"),
    "patch_project_file": ("修改", "修改文件"), "patch_preview_file": ("修改", "修改文件"),
    "write_project_file": ("写入", "写入文件"), "write_preview_file": ("写入", "写入文件"),
    "edit_project_file": ("修改", "修改文件"),
    "batch_patch_project_files": ("批量修改文件", "批量修改文件"), "batch_patch_preview_files": ("批量修改文件", "批量修改文件"),
    "create_project_file": ("创建", "创建文件"), "delete_project_file": ("删除", "删除文件"),
    "create_project_directory": ("创建目录", "创建目录"), "delete_project_directory": ("删除目录", "删除目录"),
    "web_search": ("检索相关资料", "检索资料"), "web_reader": ("读取网页资料", "读取网页资料"),
    "search_github_code": ("检索仓库代码", "检索仓库代码"), "get_weather": ("查询天气信息", "查询天气信息"),
    "request_tools": ("检查可用工具", "检查可用工具"), "create_ppt": ("制作演示文稿", "制作演示文稿"),
}


def tool_presentation(name, args, result=None, finished=False):
    title, action = TOOL_ACTIONS.get(name, ("调用工具", "调用工具 " + short(name, 60)))
    path = short(args.get("path"), 160)
    basename = path.replace("\\", "/").rstrip("/").split("/")[-1] if path else ""
    if basename and title in {"读取", "修改", "写入", "创建", "删除"}:
        title += " " + basename
    elif title in {"读取", "修改", "写入", "创建", "删除"}:
        title += "文件"
    detail = path or short(args.get("query")) or short(args.get("city"))
    target = "（" + detail + "）" if detail else ""
    if not finished:
        return {"title": title, "summary": "正在" + action + target + "。"}
    payload = object_value(result)
    failed = payload.get("success") is False or bool(payload.get("error")) or (isinstance(result, str) and result.startswith(("错误", "工具执行错误", "查询天气失败")))
    if failed:
        summary = action + target + "未成功，已保留收到的信息。"
    elif payload.get("success") is True or (isinstance(result, str) and result.startswith(("变更文件：", "变更目录：", "演示文稿已生成："))):
        summary = action + target + "已返回成功结果。"
    elif result == "未产生文件变更。":
        summary = "工具已返回，未产生文件变更。"
    else:
        summary = action + target + "已返回结果，尚未确认是否成功。"
    return {"title": title, "summary": summary}


def reasoning_text(value):
    if not isinstance(value, dict):
        return ""
    for key in ("reasoning_content", "reasoning", "thinking"):
        if isinstance(value.get(key), str):
            return value[key]
    blocks = value.get("content", [])
    if not isinstance(blocks, list):
        return ""
    parts = []
    for block in blocks:
        if not isinstance(block, dict):
            continue
        if block.get("type") in {"thinking", "reasoning", "reasoning_content"}:
            text = block.get("thinking") or block.get("text")
            if isinstance(text, str):
                parts.append(text)
            for summary in block.get("summary", []) or []:
                if isinstance(summary, dict) and isinstance(summary.get("text"), str):
                    parts.append(summary["text"])
    return "".join(parts)


class ThinkingChatOpenAI(ChatOpenAI):
    """Keep compatible providers' fields otherwise dropped by ChatOpenAI."""

    def _convert_chunk_to_generation_chunk(self, chunk, default_chunk_class, base_generation_info):
        result = super()._convert_chunk_to_generation_chunk(chunk, default_chunk_class, base_generation_info)
        choices = chunk.get("choices") or chunk.get("chunk", {}).get("choices", [])
        text = reasoning_text(choices[0].get("delta") or {}) if choices else ""
        if result is not None and text:
            result.message.additional_kwargs["reasoning_content"] = text
        return result

    def _create_chat_result(self, response, generation_info=None):
        result = super()._create_chat_result(response, generation_info)
        raw = response if isinstance(response, dict) else response.model_dump()
        for output, choice in zip(result.generations, raw.get("choices", [])):
            text = reasoning_text(choice.get("message") or {})
            if text:
                output.message.additional_kwargs["reasoning_content"] = text
        return result


class ThinkingAdapter(BaseCallbackHandler):
    run_inline = True

    def __init__(self, send_event, round_id, phase=None):
        self.send_event = send_event
        self.round_id = str(round_id)
        self.received = False
        self.text = ""
        self.presentation = {}
        self.display_summary = ""
        self.confirmed_summary = ""
        self.phase = phase

    def emit(self, kind, **payload):
        self.send_event({"type": kind, "roundId": self.round_id, **payload})

    def on_llm_new_token(self, token, *, chunk=None, **kwargs):
        message = getattr(chunk, "message", None)
        if message is not None:
            self.observe(message)

    def observe(self, message):
        text = reasoning_text(getattr(message, "additional_kwargs", {})) or reasoning_text({"content": getattr(message, "content", [])})
        if text:
            self.received = True
            self.text += text
            self.emit("thinking_delta", content=text)
            presentation = model_presentation(self.text[-2000:])
            if presentation and presentation != self.presentation:
                self.presentation = presentation
                self.emit("thinking_update", source="model", **presentation)
        # Providers may supply an already condensed, displayable summary. Do not
        # expose raw reasoning or invent a translation for unsupported languages.
        blocks = getattr(message, "content", [])
        if isinstance(blocks, list):
            for block in blocks:
                if not isinstance(block, dict) or block.get("type") != "reasoning":
                    continue
                for summary in block.get("summary", []) or []:
                    piece = summary.get("text", "") if isinstance(summary, dict) else ""
                    if not isinstance(piece, str):
                        continue
                    self.display_summary = (self.display_summary + piece)[:600]
                    sentences = re.findall(r"[^。！？.!?]+[。！？.!?]", self.display_summary)
                    value = short("".join(sentences), 240)
                    unconfirmed_action = re.search(r"(?:正在|已|完成|成功).{0,6}(?:读|写|修改|执行|构建|测试|运行|搜索|检索|删除|创建)", value)
                    if value and value != self.confirmed_summary and re.search(r"[\u4e00-\u9fff]", value) and not unconfirmed_action:
                        self.confirmed_summary = value
                        self.emit("thinking_update", source="model", summary=value)

    async def invoke(self, model, messages, callbacks):
        self.emit("thinking_start")
        stages = {"initial_response": ("分析并理解需求", "正在结合当前对话分析任务需求。"),
                  "final_response": ("整理答复", "正在结合已收到的信息组织答复。"),
                  "build_repair": ("分析构建问题", "正在分析已有构建诊断。"),
                  "search_plan": ("制定检索方案", "正在规划检索范围，尚未开始工具执行。"),
                  "patch_generation": ("制定修改方案", "正在分析文件修改方案，尚未执行本轮修改。"),
                  "simple_patch_generation": ("制定修改方案", "正在分析本轮文本修改方案。"),
                  "patch_conflict": ("分析修改冲突", "正在分析已收到的修改冲突信息。")}
        if self.phase in stages:
            title, summary = stages[self.phase]
            self.emit("thinking_update", source="phase", title=title, summary=summary)
        try:
            response = await model.ainvoke(messages, config={"callbacks": [*callbacks, self]})
            if not self.received:
                self.observe(response)
            return response
        finally:
            self.emit("thinking_end")  # model-call boundary, never Agent completion


class ThinkingTrace:
    """UI projection and history, never supplied to Agent model context."""
    def __init__(self):
        self.rounds = []
        self.status = "interrupted"
        self.active_tool = None
        self.pending_edit = False

    def update(self, item, presentation, source, step=None):
        priority = {"model": 1, "phase": 2, "tool": 3}
        if priority.get(source, 0) < priority.get(item.get("source"), 0):
            return None
        changed = any(item.get(key) != presentation.get(key, item.get(key)) for key in ("title", "summary"))
        if not changed:
            return None
        for key in ("title", "summary"):
            if isinstance(presentation.get(key), str) and presentation[key].strip():
                item[key] = short(presentation[key], 300)
        item["source"] = source
        if step is not None:
            steps = item.setdefault("steps", [])
            if step < len(steps):
                steps[step] = item.get("summary", "")
            else:
                steps.append(item.get("summary", ""))
        return {"type": "thinking_update", "roundId": item["id"], "source": source,
                "title": item.get("title"), "summary": item.get("summary"), "steps": list(item.get("steps", [])),
                "toolName": item.get("toolName"), "toolRunning": item.get("toolRunning", False)}

    def accept(self, event):
        if self.status in {"completed", "failed", "cancelled"}:
            return None
        kind, round_id = event.get("type"), event.get("roundId")
        if kind == "thinking_start" and round_id:
            if not any(r["id"] == round_id for r in self.rounds):
                self.active_tool = None
                self.rounds.append({"id": round_id, "content": "", "ended": False})
            return None
        item = self.rounds[-1] if self.rounds else None
        if item is None:
            return None
        if round_id and item["id"] != round_id:
            return None
        if kind.startswith("thinking_"):
            # Late updates never rewrite older rounds.
            if item["id"] != round_id:
                return None
            if kind == "thinking_delta":
                item["content"] += event.get("content", "")
            elif kind == "thinking_end":
                item["ended"] = True
                self.update(item, event, event.get("source", "model"))
            elif kind in {"thinking_update", "thinking_title", "thinking_summary_delta"}:
                presentation = dict(event)
                if kind == "thinking_summary_delta":
                    presentation["summary"] = item.get("summary", "") + event.get("content", "")
                self.update(item, presentation, event.get("source", "model"))
            return None
        if kind == "tool_start":
            name = event.get("name", "")
            args = object_value(event.get("args"))
            step = len(item.get("steps", []))
            self.active_tool = (item["id"], name, args, step)
            self.pending_edit = False
            item["toolName"], item["toolRunning"] = name, True
            return self.update(item, tool_presentation(name, args), "tool", step)
        if kind == "tool_end" and self.active_tool:
            owner, name, args, step = self.active_tool
            if owner != item["id"] or name != event.get("name"):
                return None
            self.active_tool = None
            item["toolRunning"] = False
            presentation = tool_presentation(name, args, event.get("result"), True)
            if self.pending_edit and "未成功" not in presentation["summary"]:
                presentation["summary"] = "修改工具已返回；本轮变更仍待确认，尚未写入实际项目。"
            return self.update(item, presentation, "tool", step)
        if kind in {"project_file_changed", "preview_file_changed"} and self.active_tool:
            owner, _, _, _ = self.active_tool
            path = short(event.get("path"), 160)
            if owner != item["id"] or not path:
                return None
            label = path.replace("\\", "/").split("/")[-1]
            pending = bool(event.get("pending"))
            self.pending_edit = self.pending_edit or pending
            presentation = {"title": ("准备修改 " if pending else "修改 ") + label,
                            "summary": ("已生成待确认修改，尚未写入实际项目：" if pending else "已收到文件变更回执，最终状态待工具结果确认：") + path}
            return self.update(item, presentation, "tool", len(item.get("steps", [])))
        return None

    def snapshot(self):
        return {"rounds": self.rounds, "status": self.status}
