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
    "git_status": ("查看 Git 状态", "查看 Git 状态"), "git_commit": ("提交代码", "提交代码"),
    "git_push": ("推送代码", "推送代码"),
    "list_toolchains": ("查看可运行的命令", "查看可运行的命令"), "run_toolchain_action": ("施行命令", "施行命令"),
    "delete_project": ("删除项目", "删除项目"), "read_external_file": ("读取项目外文件", "读取项目外文件"),
    "list_external_directory": ("查看项目外目录", "查看项目外目录"),
}

# 施行状态词与卡片一致：只在展示层映射，回执中的 status 不改名。
TOOLCHAIN_STATUS = {
    "completed": ("ok", "已施行"), "user_cancelled": ("cancelled", "未施行"),
    "approval_timeout": ("cancelled", "逾时未施"), "cancelled": ("cancelled", "中道而止"),
    "timed_out": ("fail", "逾时而止"), "plan_changed": ("fail", "内容有异"), "not_enabled": ("fail", "此令未开"),
    "rejected": ("fail", "不可施行"), "workspace_untrusted": ("fail", "未得信任"),
    "background": ("ok", "常驻施行"), "stopped": ("ok", "已收令"),
}
TOOLCHAIN_TITLES = {"typecheck": "类型检查", "lint": "代码检查", "env": "查看 Node 版本", "install": "安装依赖",
                    "logs": "查看运行输出", "stop": "止令"}
PYTHON_TITLES = {"env": "查看 Python 环境", "install": "安装 Python 依赖", "create_venv": "创建虚拟环境",
                 "format_check": "检查代码格式"}
GIT_TITLES = {"status": "查看 Git 状态", "diff": "读取改动差异", "log": "查看提交记录", "commit": "提交代码",
              "push": "推送代码", "pull": "拉取代码", "fetch": "获取远端更新", "discard": "放弃改动",
              "create_branch": "新建分支", "switch_branch": "切换到分支", "delete_branch": "删除分支"}


READ_TOOLS = {"read_project_file", "read_preview_file"}
SEARCH_CODE_TOOLS = {"search_project_code", "search_preview_code"}
LIST_TOOLS = {"list_project_files", "list_preview_files"}
EDIT_TOOLS = {"patch_project_file", "patch_preview_file", "write_project_file", "write_preview_file", "edit_project_file",
              "batch_patch_project_files", "batch_patch_preview_files", "create_project_file", "delete_project_file",
              "create_project_directory", "delete_project_directory"}
GENERATE_TOOLS = {"create_ppt", "create_word", "create_excel", "create_pdf", "generate_xiaoyunque_video", "set_3d_scene"}


def _basename(path):
    return path.replace("\\", "/").rstrip("/").split("/")[-1] if path else ""


def _int(value):
    return value if type(value) is int else None


def _line_range(start, end):
    if start and end:
        return f"第 {start}–{end} 行" if start != end else f"第 {start} 行"
    if start:
        return f"第 {start} 行起"
    if end:
        return f"前 {end} 行"
    return ""


def _tool_title(name, args, title):
    """在通用动作名上补充本次调用的真实参数，区分同名的多次调用。"""
    path = short(args.get("path"), 160)
    if title in {"读取", "修改", "写入", "创建", "删除"}:
        title = title + " " + _basename(path) if path else title + "文件"
        if name in READ_TOOLS:
            span = _line_range(_int(args.get("start_line")), _int(args.get("end_line")))
            title += " " + span if span else ""
        return title
    query = short(args.get("query"), 24)
    if name in SEARCH_CODE_TOOLS and query:
        return f"搜索「{query}」"
    if name == "web_search" and query:
        return f"检索「{query}」"
    if name == "web_reader" and isinstance(args.get("urls"), list) and args["urls"]:
        return f"读取 {len(args['urls'])} 篇网页"
    if name == "git_status" and args.get("include_diff") is True:
        return "读取改动差异"
    if name == "git_commit":
        paths = [_basename(p) for p in args.get("paths") or [] if isinstance(p, str) and p.strip()]
        suffix = "" if args.get("push") is False else "并推送"
        if not paths:
            return "提交全部改动" + suffix
        title = "提交 " + "、".join(paths[:2]) + (f" 等 {len(paths)} 个文件" if len(paths) > 2 else "")
        # 文件名后接中文时留一个空格，读起来不粘连
        return title + ((" " if title[-1].isascii() else "") + suffix if suffix else "")
    if name == "delete_project":
        return "删除项目 " + _basename(path) if path else title
    if name in {"read_external_file", "list_external_directory"}:
        return title + (" " + _basename(path) if path else "")
    if name == "run_toolchain_action" and args.get("toolchain") == "git":
        action, params = args.get("action"), args.get("params") if isinstance(args.get("params"), dict) else {}
        label = GIT_TITLES.get(action, "Git 操作")
        branch = short(params.get("name"), 60)
        return f"{label} {branch}" if branch and action in {"create_branch", "switch_branch", "delete_branch"} else label
    if name == "run_toolchain_action":
        action, params = args.get("action"), args.get("params") if isinstance(args.get("params"), dict) else {}
        if action == "run_script" and short(params.get("name"), 40):
            return "运行 npm run " + short(params.get("name"), 40)
        if action == "run_file" and short(params.get("file"), 160):
            return "运行 " + _basename(short(params.get("file"), 160))
        if action == "run_module" and short(params.get("module"), 40):
            return "运行 python -m " + short(params.get("module"), 40)
        if args.get("toolchain") == "python" and action in PYTHON_TITLES:
            return PYTHON_TITLES[action]
        if action == "test":
            target = _basename(short(params.get("path"), 160))
            return "运行测试" + (" " + target if target else "")
        return TOOLCHAIN_TITLES.get(action, title)
    if name == "git_push" and short(args.get("remote"), 40):
        return "推送代码到 " + short(args.get("remote"), 40)
    return title


def _count_files(entry):
    return entry.get("total", len(entry.get("files") or [])) if isinstance(entry, dict) else 0


def _result_digest(name, args, result, payload):
    """按工具解读真实回执，返回 (状态, 描述)。状态：ok / fail / cancelled / unknown。只陈述回执里的事实。"""
    if name == "run_toolchain_action" and payload.get("status"):
        summary = short(payload.get("summary"), 120)
        status = payload["status"]
        if status == "failed":
            diagnostics = payload.get("diagnostics") if isinstance(payload.get("diagnostics"), dict) else {}
            state, label = "fail", "见疏漏" if diagnostics.get("failed") else "未施成"
        else:
            state, label = TOOLCHAIN_STATUS.get(status, ("unknown", ""))
        if not label:
            return "unknown", ""
        command = short(payload.get("command"), 60)
        text = f"{label}：" + (f"{command}，" if command else "") + (summary.rstrip("。") or "无更多信息") + "。"
        warnings = [w for w in payload.get("warnings") or [] if isinstance(w, dict) and w.get("reason")]
        if warnings:
            label_text = "高度可疑" if any(w.get("level") == "high" for w in warnings) else "疑似风险"
            text += f"（{label_text}：{short(warnings[0]['reason'], 40)}）"
        if payload.get("appliedReviewFiles"):
            text += f"已先落笔 {payload['appliedReviewFiles']} 个审阅候选。"
        if payload.get("pendingReviewFiles"):
            text += f"另有 {payload['pendingReviewFiles']} 个审阅候选尚未落笔，命令针对的是落笔前的文件。"
        return state, text
    if name == "delete_project" and payload.get("deleted") is True:
        return "ok", f"已删除项目（{payload.get('fileCount', '若干')} 个文件，在系统回收站中）。"
    if name == "read_external_file" and isinstance(payload.get("content"), str):
        return "ok", f"已读取项目外文件（共 {payload.get('totalLines')} 行）。"
    if name == "list_external_directory" and isinstance(payload.get("entries"), list):
        return "ok", f"共 {payload.get('total', len(payload['entries']))} 项" + (
            f"，{payload['hiddenProtected']} 项受保护已隐藏" if payload.get("hiddenProtected") else "") + "。"
    if name == "list_toolchains" and isinstance(payload.get("toolchains"), list):
        packages = [p for t in payload["toolchains"] if isinstance(t, dict) for p in t.get("packages") or [] if isinstance(p, dict)]
        scripts = sum(len(p.get("scripts") or {}) for p in packages)
        return "ok", f"找到 {len(packages)} 个包目录，共 {scripts} 个脚本。" if packages else "没有找到可运行的 package.json。"
    code = payload.get("code")
    error = short(payload.get("error") or (payload.get("message") if payload.get("success") is False else ""), 80)
    if code == "USER_CANCELLED":
        return "cancelled", "你在确认框中取消了操作，未做任何改动。"
    if payload.get("success") is False or payload.get("error"):
        return "fail", error
    if name == "git_status" and "branch" in payload:
        branch = payload.get("branch") or "游离 HEAD"
        ahead = payload.get("ahead")
        parts = [f"分支 {branch}" + (f"（领先 {ahead} 个提交）" if ahead else "")]
        counts = [(label, _count_files(payload.get(key))) for label, key in (
            ("已暂存", "staged"), ("未暂存", "unstaged"), ("未跟踪", "untracked"), ("冲突", "conflicts"))]
        changed = "、".join(f"{label} {n}" for label, n in counts if n)
        parts.append(changed + " 个文件" if changed else "没有未提交的改动")
        if payload.get("dirtyDocuments"):
            parts.append(f"{len(payload['dirtyDocuments'])} 个文件未保存")
        if "diff" in payload:
            parts.append("差异已截断" if payload.get("diffTruncated") else "已取得差异")
        return "ok", "，".join(parts) + "。"
    if name == "git_commit" and payload.get("committed") is True:
        files = payload.get("files") or []
        commit = short(payload.get("commit"), 8)
        text = f"已提交 {len(files)} 个文件到 {payload.get('branch') or '当前分支'}" + (f"，提交号 {commit}" if commit else "")
        if payload.get("pushed") is True:
            text += f"，并推送到 {payload.get('upstream') or payload.get('remote')}" + ("（已设置上游）" if payload.get("setUpstream") else "")
        elif payload.get("pushError") or payload.get("pushSkipped"):
            text += "；" + short(payload.get("pushError") or payload.get("pushSkipped"), 60).rstrip("。")
        return "ok", text + "。"
    if name == "git_push" and payload.get("pushed") is True:
        count = payload.get("pushedCommits")
        target = payload.get("upstream") or f"{payload.get('remote')}/{payload.get('branch')}"
        return "ok", (f"已推送 {count} 个提交到 {target}" if count else f"已推送到 {target}") + (
            "，并设置了上游" if payload.get("setUpstream") else "") + "。"
    if name == "git_push" and payload.get("pushed") is False:
        return "ok", short(payload.get("message"), 80) or "没有需要推送的提交。"
    if name in READ_TOOLS and isinstance(payload.get("content"), str):
        total = _int(payload.get("totalLines"))
        span = _line_range(_int(payload.get("startLine") or args.get("start_line")),
                           _int(payload.get("endLine") or args.get("end_line")))
        return "ok", (f"已读取{span}" if span else "已读取全文") + (f"（文件共 {total} 行）" if total else "") + "。"
    if name in SEARCH_CODE_TOOLS:
        hits = payload.get("results") if isinstance(payload.get("results"), list) else payload.get("matches")
        if isinstance(result, list):
            hits = result
        if isinstance(hits, list):
            files = {h.get("path") for h in hits if isinstance(h, dict) and h.get("path")}
            return "ok", (f"找到 {len(hits)} 处匹配，涉及 {len(files)} 个文件" if hits else "没有找到匹配内容") + (
                "（结果已截断）" if payload.get("truncated") else "") + "。"
    if name in LIST_TOOLS and isinstance(payload.get("files"), list):
        return "ok", f"共 {len(payload['files'])} 个文件。"
    if name == "web_search" and isinstance(result, str):
        found = re.search(r"【结果 (\d+) 条】", result)
        if found:
            return "ok", f"找到 {found[1]} 条来源。" if int(found[1]) else "没有找到可用来源。"
    if name == "web_reader" and isinstance(payload.get("pages"), list):
        failures = len(payload.get("failures") or [])
        return "ok", f"成功读取 {len(payload['pages'])} 篇" + (f"，{failures} 篇读取失败" if failures else "") + "。"
    return "unknown", ""


def tool_presentation(name, args, result=None, finished=False):
    title, action = TOOL_ACTIONS.get(name, ("调用工具", "调用工具 " + short(name, 60)))
    path = short(args.get("path"), 160)
    title = _tool_title(name, args, title)
    detail = path or short(args.get("query")) or short(args.get("city"))
    target = "（" + detail + "）" if detail else ""
    if not finished:
        if name in {"git_commit", "git_push"}:
            return {"title": title, "summary": "正在等待你在 VS Code 确认框中确认" + action + "。"}
        if name in {"delete_project", "read_external_file", "list_external_directory"}:
            return {"title": title, "summary": "静候确认：两种模式下都需你在卡片中确认后才会执行。"}
        if name == "run_toolchain_action" and args.get("action") in {"logs", "stop"}:
            return {"title": title, "summary": "正在" + title + "。"}
        if name == "run_toolchain_action":
            return {"title": title, "summary": "静候施行：审阅落笔模式下需你在卡片中施行后才会运行。"}
        return {"title": title, "summary": "正在" + action + target + "。"}
    payload = object_value(result)
    failed = payload.get("success") is False or bool(payload.get("error")) or (isinstance(result, str) and result.startswith(("错误", "工具执行错误", "查询天气失败")))
    status, digest = _result_digest(name, args, result, payload)
    if name == "run_toolchain_action" and payload.get("status") and digest:
        return {"title": title, "summary": digest, "status": status}
    if status == "cancelled":
        summary = digest
    elif failed:
        summary = action + target + "未成功" + ("：" + digest.rstrip("。.") if digest else "，已保留收到的信息") + "。"
    elif status == "ok":
        summary = digest
    elif payload.get("success") is True or (isinstance(result, str) and result.startswith(("变更文件：", "变更目录：", "演示文稿已生成："))):
        summary = action + target + "已返回成功结果。"
    elif result == "未产生文件变更。":
        summary = "工具已返回，未产生文件变更。"
    else:
        summary = action + target + "已返回结果，尚未确认是否成功。"
    return {"title": title, "summary": summary, "status": "fail" if failed and status != "cancelled" else status}


def final_presentation(outcomes):
    """根据本轮已完成工具的真实结果命名最后的答复阶段；没有工具结果时返回 None（保留通用文案）。"""
    if not outcomes:
        return None
    groups = (
        ({"git_push"}, "汇总推送结果"), ({"git_commit"}, "汇总提交结果"), ({"run_toolchain_action"}, "汇总施行结果"),
        (EDIT_TOOLS, "汇总修改结果"),
        (GENERATE_TOOLS, "汇总生成结果"), ({"web_search", "web_reader", "search_github_code"}, "汇总检索结果"),
    )
    names = {o["name"] for o in outcomes}
    title = next((label for members, label in groups if names & members), "汇总查看结果")
    key = next((o for o in reversed(outcomes) if any(o["name"] in m for m, label in groups if label == title)),
               outcomes[-1])
    failed = sum(o["status"] == "fail" for o in outcomes)
    summary = f"结合 {len(outcomes)} 项工具结果向你说明" + (f"（其中 {failed} 项未成功）" if failed else "") + "："
    return {"title": title, "summary": summary + key["summary"]}


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
            self.emit("thinking_update", source="phase", phase=self.phase, title=title, summary=summary)
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
        # 本次 Agent 运行中已完成工具的真实结果，用于命名最后的答复阶段
        self.outcomes = []

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
                if event.get("source") == "phase" and event.get("phase") == "final_response":
                    final = final_presentation(self.outcomes)
                    if final:
                        # 原地改写：路由随后把同一事件发送给前端，两端看到相同的标题和摘要
                        event.update(final)
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
            self.outcomes.append({"name": name, "status": presentation.get("status", "unknown"),
                                  "summary": presentation["summary"]})
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
