"""酌思（auto）：发送时按规则决定本轮用随思还是深思，运行中遇到问题再升级为深思。

判定只用规则，不额外调用模型，判断本身不增加耗时。优先级从高到低：
1. 用户明确要求（"仔细想想" → 深思，"简单说" → 随思）
2. 任务类型（工具路由 profile / 预览任务类型）
3. 内容复杂度（长文、代码、附件、数学推理、方案决策、多个子问题）
4. 短追问沿用上一轮
5. 其余默认随思
"""
from __future__ import annotations

import re
from dataclasses import dataclass


@dataclass(frozen=True)
class ThinkingDecision:
    deep: bool
    reason: str


# 改项目/代码、生成演示文稿或文档：需要先想清楚再动手
_DEEP_PROFILES = {
    "preview": "修改项目",
    "vscode_project_edit": "修改项目",
    "workspace": "修改项目",
    "presentation": "生成演示文稿",
    "documents": "生成文档",
}
# 预览任务里的构建修复本身就是"遇到问题"
_DEEP_TASK_KINDS = {"REPAIR": "修复构建错误"}

_LIGHT_PROFILE_REASONS = (
    ("news_research", "联网新闻"),
    ("weather", "天气查询"),
    ("web", "联网搜索"),
    ("web_reader", "联网搜索"),
    ("images", "图片搜索"),
    ("video", "视频生成"),
    ("knowledge", "知识库查询"),
    ("github_code", "代码检索"),
    ("workspace_toolchain", "执行命令"),
    ("python", "运行代码"),
    ("vscode_project", "读取工作区"),
    ("preview_read", "读取项目"),
    ("preview_export", "导出产物"),
)

_EXPLICIT_DEEP = re.compile(
    r"仔细(?:想|思考|分析|推敲|琢磨)|深入(?:分析|思考|研究|讲解)|深度(?:思考|分析)|一步(?:一)?步|逐步(?:推理|分析)|"
    r"认真(?:想|思考|分析|比较)|论证|严谨|think\s+(?:hard|carefully|step\s+by\s+step)",
    re.I,
)
_EXPLICIT_LIGHT = re.compile(r"简单(?:说|讲|回答|介绍|聊)|快速(?:回答|说)|一句话|简短|大概(?:说|讲|就行)|随便聊", re.I)

_MATH_LOGIC = re.compile(
    r"方程|证明|推导|概率|期望值|复杂度|积分|导数|微分|矩阵|数学题|逻辑题|推理题|算法题|几何|数列|"
    r"\bprove\b|\bderive\b|\bprobability\b|\bcomplexity\b",
    re.I,
)
_DECISION = re.compile(
    r"方案|架构|选型|优劣|利弊|权衡|规划|对比分析|差异分析|评估|设计一[个套]|怎么设计|如何设计|"
    r"trade-?offs?|architecture|pros\s+and\s+cons",
    re.I,
)
# 工具链：执行命令随思，排查报错/分析失败原因深思
_DIAGNOSE = re.compile(r"报错|失败|排查|为什么|原因|修复|定位问题|debug|调试|异常|错误", re.I)
# 非新闻的时效性问题（"现任美联储主席是谁"）：2026-10-17 评测中随思有 8/24 题没联网就凭记忆作答，
# 集中在这类问题；新闻类已强制先搜索，不受此影响
_TIME_SENSITIVE = re.compile(r"现任|目前|当前|如今|现在(?:的|是|谁)|最新|今年|本月|本周|近期|latest|current(?:ly)?", re.I)
# GitHub：找仓库随思，讲解实现/分析源码深思
_CODE_ANALYSIS = re.compile(r"原理|实现(?:方式|思路|细节)?|源码分析|分析(?:一下)?(?:源码|代码)|怎么实现|如何实现|讲解", re.I)
_FOLLOW_UP = re.compile(
    r"^\s*(?:继续|接着|然后呢|还有呢|还有吗|再(?:详细|具体|展开|多说)|详细(?:点|一点|些|说说)|展开(?:说说|讲讲)?|"
    r"那.{0,10}呢|为什么呢|然后)\s*[？?。!！]*\s*$"
)

LONG_TEXT_CHARS = 800
MANY_QUESTIONS = 3


def _complexity_reason(text: str) -> str | None:
    if "<uploaded-content>" in text:
        return "分析附件"
    if "```" in text:
        return "包含代码"
    if len(text) > LONG_TEXT_CHARS:
        return "内容较长"
    if _MATH_LOGIC.search(text):
        return "数学或逻辑推理"
    if _DECISION.search(text):
        return "方案与决策"
    if len(re.findall(r"[？?]", text)) >= MANY_QUESTIONS:
        return "多个子问题"
    return None


def _previous_user_text(history: list[dict] | None) -> str:
    for message in reversed(history or []):
        if message.get("role") == "user" and isinstance(message.get("content"), str):
            return message["content"]
    return ""


def decide_thinking(text: str, profile: str = "", *, task_kind: str = "GENERAL",
                    has_images: bool = False, history: list[dict] | None = None,
                    _depth: int = 0) -> ThinkingDecision:
    """按规则决定本轮初始思考方式；返回是否深思及给用户看的简短原因。"""
    text = text or ""
    profiles = set(filter(None, (profile or "").split("+")))

    # ① 用户明确要求
    if _EXPLICIT_DEEP.search(text):
        return ThinkingDecision(True, "按你的要求深入思考")
    if _EXPLICIT_LIGHT.search(text):
        return ThinkingDecision(False, "按你的要求简要作答")

    # ② 任务类型：改项目、生成文档等直接深思
    if task_kind in _DEEP_TASK_KINDS:
        return ThinkingDecision(True, _DEEP_TASK_KINDS[task_kind])
    for name, reason in _DEEP_PROFILES.items():
        if name in profiles:
            return ThinkingDecision(True, reason)
    if "workspace_toolchain" in profiles and _DIAGNOSE.search(text):
        return ThinkingDecision(True, "排查问题")
    if "github_code" in profiles and _CODE_ANALYSIS.search(text):
        return ThinkingDecision(True, "分析源码")
    # 普通问答（chat 路由自带不强制的联网兜底）或普通联网：时效性问题走深思，促使先联网核实
    if profiles <= {"chat", "web", "web_reader"} and _TIME_SENSITIVE.search(text):
        return ThinkingDecision(True, "时效性问题")

    # ③ 内容复杂度
    complexity = _complexity_reason(text)
    if complexity:
        return ThinkingDecision(True, complexity)
    if has_images:
        return ThinkingDecision(True, "分析图片")

    # ④ 短追问沿用上一轮（只回看一层，避免追问链无限回溯）
    if _depth == 0 and _FOLLOW_UP.match(text):
        previous = _previous_user_text(history)
        if previous:
            inherited = decide_thinking(previous, profile, task_kind=task_kind, history=None, _depth=1)
            return ThinkingDecision(inherited.deep, "沿用上一轮")

    # ⑤ 任务类型偏轻量，或没有任何信号：随思
    for name, reason in _LIGHT_PROFILE_REASONS:
        if name in profiles:
            return ThinkingDecision(False, reason)
    return ThinkingDecision(False, "常规问答")


# 运行中"遇到问题"时升级为深思的原因
ESCALATION_REASONS = {
    "patch_conflict": "修改冲突",
    "build_repair": "修复构建错误",
    "citation_revision": "引用核验未通过",
    "reader_retry": "正文读取需重试",
    "tool_failures": "工具多次执行失败",
}
TOOL_FAILURE_ESCALATION = 2


def tool_result_failed(result: object) -> bool:
    """工具回执是否表示失败：JSON 里 success=false、带 error、或 status 为失败类。"""
    if not isinstance(result, str):
        return False
    text = result.strip()
    if not text.startswith("{"):
        return False
    try:
        import json
        payload = json.loads(text)
    except (ValueError, TypeError):
        return False
    if not isinstance(payload, dict):
        return False
    if payload.get("success") is False:
        return True
    if payload.get("error") and payload.get("success") is not True:
        return True
    return str(payload.get("status", "")).lower() in {"failed", "error"}
