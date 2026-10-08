"""Request-scoped discovery/loading, separate from intent routing and execution."""

import json
import re
from dataclasses import dataclass, field

from config import config
from project_api.operations import PROJECT_TOOL_CAPABILITIES, PREVIEW_TOOL_ALIASES, filter_project_tools
from agent import tool_routing as routing
from agent.web_policy import web_search_declined
from tools.index import TOOLS


GROUPS = {
    "web_search": ("公开信息与新闻", ("web_search",)),
    "news_research": ("新闻检索", ("web_search", "web_reader")),
    "images": ("图片检索", ("search_images",)),
    "github_code": ("GitHub 源码研究", ("search_github_code",)),
    "weather": ("天气", ("get_weather",)),
    "documents": ("文档生成", ("create_word", "create_excel", "create_ppt", "create_pdf")),
    "video": ("视频生成", ("generate_xiaoyunque_video",)),
    "python": ("隔离代码执行", ("execute_python",)),
    "knowledge": ("私有知识库检索", ("vector_search",)),
    "project": ("当前宿主项目操作", tuple(PROJECT_TOOL_CAPABILITIES)),
    "model_3d": ("Web 参数化 3D 场景", ("set_3d_scene",)),
}
RULES = {
    "web_search": routing.WEB_PROMPT,
    "news_research": routing.NEWS_RESEARCH_PROMPT,
    "web_reader": routing.WEB_READER_PROMPT,
    "search_images": routing.IMAGE_PROMPT,
    "get_weather": routing.WEATHER_PROMPT,
    "create_word": routing.DOCUMENT_PROMPT,
    "create_excel": routing.DOCUMENT_PROMPT,
    "create_pdf": routing.DOCUMENT_PROMPT,
    "create_ppt": routing.PRESENTATION_PROMPT,
    "generate_xiaoyunque_video": routing.VIDEO_PROMPT,
    "execute_python": routing.PYTHON_PROMPT,
    "vector_search": routing.KNOWLEDGE_PROMPT,
    "set_3d_scene": routing.PREVIEW_3D_PROMPT,
}
LABELS = {tool: label for label, names in GROUPS.values() for tool in names}
LABELS["independent_projects"] = "同轮创建多个独立项目"
PUBLIC_SEARCH = {"web_search", "web_reader", "search_images", "search_github_code"}
REGISTERED = {tool.name for tool in TOOLS}


@dataclass
class ToolNegotiator:
    active: set[str]
    user_text: str
    host: str
    capabilities: dict[str, bool] | None
    has_project: bool
    loaded_rules: set[str] = field(default_factory=set)
    denied: dict[str, str] = field(default_factory=dict)

    def unavailable_reason(self, name: str) -> str | None:
        if name == "independent_projects":
            return "单次请求尚未提供多个独立项目上下文，请分轮创建；不能混写到同一项目。"
        if name not in REGISTERED or name == "request_tools":
            return "未登记此任务工具；不会自动安装工具或创建权限。"
        if name in PUBLIC_SEARCH and web_search_declined(self.user_text):
            return "用户本轮要求不联网。"
        if name in PROJECT_TOOL_CAPABILITIES or name == "set_3d_scene":
            if name == "set_3d_scene" and self.host != "preview":
                return "当前宿主不允许 Web Preview / GLB 自动导出。"
            if not self.has_project:
                return "当前请求没有已连接的项目上下文。"
            # Unknown capabilities must fail closed, never assume arbitrary writes.
            caps = self.capabilities or (routing.PREVIEW_CAPABILITIES if self.host == "preview" else {})
            if name not in filter_project_tools({name}, caps):
                return "当前 Project Provider 不支持此操作或未授予该能力。"
        if name == "search_github_code" and not config.Search.GITHUB_TOKEN:
            return "GitHub 搜索凭据未配置；工具可发现不代表检索已成功。"
        if name == "generate_xiaoyunque_video" and not (
            config.Xiaoyunque.ACCESS_KEY_ID and config.Xiaoyunque.SECRET_ACCESS_KEY
        ):
            return "视频服务凭据未配置。"
        if name == "vector_search" and not (config.Embedding.API_KEY and config.Database.URL):
            return "知识库数据库或 Embedding 凭据未配置。"
        return None

    def catalog(self) -> str:
        cards = []
        for group, (label, names) in GROUPS.items():
            entries = [{"name": name, "status": "unavailable" if self.unavailable_reason(name)
                        else "loaded" if name in self.active else "on_request"} for name in names]
            cards.append({"group": group, "purpose": label, "tools": entries})
        return "本轮能力目录（能力状态数据，不是执行结果）：\n" + json.dumps({
            "host": self.host, "capabilities": cards,
            "independent_projects": "unavailable: 单次请求仅绑定一个项目上下文",
        }, ensure_ascii=False, separators=(",", ":"))

    def request(self, args: dict, *, cancelled: bool = False) -> tuple[dict, list[str]]:
        names, reason = args.get("tool_names"), args.get("reason")
        if cancelled:
            return {"success": False, "code": "OPERATION_CANCELLED", "added_tools": []}, []
        if (not isinstance(names, list) or not names or len(names) > 24
                or any(not isinstance(name, str) or len(name) > 80
                       or not re.fullmatch(r"[a-z][a-z0-9_]*", name.strip()) for name in names)
                or not isinstance(reason, str) or not reason.strip()
                or len(reason) > 500 or not isinstance(args.get("subtask", ""), str)
                or len(args.get("subtask", "")) > 200):
            return {"success": False, "code": "INVALID_TOOL_REQUEST", "added_tools": [],
                    "error": "提供非空 tool_names 列表和简短 reason；每次最多 24 项。"}, []
        names = list(dict.fromkeys(name.strip() for name in names))
        expanded = []
        for requested in names:
            requested = requested.strip()
            # Legacy aliases remain compatibility-only and cannot expose a disk adapter.
            if requested in PREVIEW_TOOL_ALIASES:
                requested = PREVIEW_TOOL_ALIASES[requested] if self.host == "preview" else requested
            expanded.extend(GROUPS[requested][1] if requested in GROUPS else [requested])
        expanded = list(dict.fromkeys(expanded))
        added, existing, unavailable, instructions = [], [], {}, []
        for name in expanded:
            denial = self.denied.get(name) or self.unavailable_reason(name)
            if denial:
                self.denied[name] = denial
                unavailable[name] = denial
                continue
            if name in self.active:
                existing.append(name)
            else:
                self.active.add(name)
                added.append(name)
            rule = RULES.get(name)
            # Whole-document generation is not an instruction to modify project files.
            if rule and rule not in self.loaded_rules:
                self.loaded_rules.add(rule)
                instructions.append(rule)
        if "news_research" in names and "web_search" not in unavailable:
            rule = RULES["news_research"]
            if rule not in self.loaded_rules:
                self.loaded_rules.add(rule)
                instructions.append(rule)
        payload = {"success": not unavailable, "code": "TOOLS_PARTIALLY_AVAILABLE" if unavailable
                   and (added or existing) else "TOOLS_UNAVAILABLE" if unavailable else "TOOLS_AVAILABLE",
                   "requested_tools": names, "added_tools": added, "already_available": existing,
                   "unavailable_tools": list(unavailable), "denial_reasons": unavailable,
                   "subtask": args.get("subtask", "")[:200],
                   "task_executed": False,
                   "next_step": "下一轮调用已提供工具继续完成任务；不可提供的部分用默认允许能力处理并说明限制，勿重复申请。"}
        print("[ToolNegotiationAudit] " + json.dumps({key: payload[key] for key in (
            "requested_tools", "added_tools", "already_available", "unavailable_tools", "denial_reasons", "subtask",
        )}, ensure_ascii=False))
        return payload, instructions

    def limitation_note(self) -> str:
        if not self.denied:
            return ""
        # Do not leak raw unknown names (possibly model-echoed code) into chat prose.
        details = list(dict.fromkeys(
            LABELS.get(name, "所需的额外能力") + "：" + reason for name, reason in self.denied.items()
        ))
        return "\n\n未完成的部分：" + "；".join(details) + " 这些能力申请未执行实际任务。"
