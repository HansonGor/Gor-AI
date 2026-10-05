"""Conservative per-turn tool and prompt routing for chat requests."""

from dataclasses import dataclass
import re
from typing import Optional

from agent.prompts import SYSTEM_PROMPT
from tools.index import TOOLS, WORKSPACE_TOOLS
from tools.preview_project import PREVIEW_TOOLS
from tools.scene_spec import set_3d_scene


BASE_PROMPT = """你是 Gor，一个可靠、友善的中文 AI 助手。优先直接回答用户，不要为了调用工具而调用工具。
仅可使用本轮明确提供的工具；没有提供相关工具时，基于已知信息回答，或说明完成任务还需要什么。
不要声称执行了实际上未执行的搜索、代码修改、文件生成或运行操作。回答自然、简洁，并遵循用户要求的语言。"""

WEB_PROMPT = """本轮任务需要联网检索。先提炼查询词，最多进行两轮搜索；回答仅依据工具本轮返回的来源，不要编造事实、来源或链接。使用搜索结果时，在对应事实后标注 [S1]、[S2] 等来源编号；不要自行附加来源清单。"""
WEATHER_PROMPT = """用户需要实时天气信息。使用天气工具查询；城市不明确时先询问，不要猜测位置。明确区分实时结果和一般性建议。"""
IMAGE_PROMPT = """用户需要图片素材候选。用具体主体、场景和构图描述搜索，简要比较相关性，并如实保留工具返回的来源与许可信息；候选图不代表已下载或已嵌入。"""
DOCUMENT_PROMPT = """用户明确要求生成可下载文档。只调用与所需格式匹配的生成工具；先组织完整、准确的内容，生成后简洁告知文件和必要限制。"""
PREVIEW_PROMPT = """用户正在当前 Preview Project 中创建、检查或修改项目。只修改浏览器内虚拟文件，不访问本地磁盘。
修改已有源码时先搜索目标；snippet 不足以安全定位时再按范围读取。小修改优先 exact old_text patch，old_text 必须来自本轮最新源码并唯一匹配；冲突后重新读取。一次请求尽量合并成一个 batch patch。仅新文件或确属整体重构时才 write。不得把整份源码放进最终答复。Preview 修改应保持原项目；只有用户要求新建不同项目时才另起项目。
如果用户要求参数化 3D 场景，优先用 set_3d_scene。不要声称 Preview 已构建成功，除非收到构建结果。"""
PROJECT_PROMPT = """用户明确授权修改真实工作区中的项目文件。先搜索并读取相关文件，只改用户要求的目标；谨慎使用局部修改，避免覆盖无关内容。操作失败时说明，不要虚称成功。"""
PYTHON_PROMPT = """仅在用户明确要求运行、验证或调试代码时使用隔离 Python 工具。运行前确认代码和输入来自本轮任务；只汇报实际运行结果，不把普通代码编写问题误当成执行请求。"""
KNOWLEDGE_PROMPT = """用户询问私有知识库或已上传资料。使用知识库检索，严格基于返回片段回答；无结果时说明未检索到，不补造资料内容。"""
VIDEO_PROMPT = """用户明确要求生成视频。把需求整理为清晰的创作指令，只有必要时加入参考图；说明工具实际返回的任务状态，不把已提交说成已完成。"""
PRESENTATION_RULES = SYSTEM_PROMPT.partition("PPT 设计与生成规范：")[2].partition("可用工具：")[0]
PRESENTATION_PROMPT = "PPT 设计与生成规范：\n" + PRESENTATION_RULES


@dataclass(frozen=True)
class ToolRoute:
    profile: str
    tool_names: tuple[str, ...]
    system_prompt: str


_TOOL_NAMES = {item.name for item in (*TOOLS, *WORKSPACE_TOOLS)}


def _has(pattern: str, text: str) -> bool:
    return re.search(pattern, text, re.IGNORECASE) is not None


def route_request(
    text: str,
    *,
    has_preview: bool = False,
    allow_workspace_edit: bool = False,
    presentation_context: Optional[dict] = None,
) -> ToolRoute:
    """Select the smallest deterministic tool set implied by the latest request."""
    text = text or ""
    selected: set[str] = set()
    profiles: list[str] = []
    instructions: list[str] = []

    ppt_intent = _has(
        r"(?:生成|制作|创建|重做|修改|导出|做)(?:一份|一个|个)?[^。\n]{0,18}(?:pptx?|powerpoint|演示文稿|幻灯片)|(?:pptx?|powerpoint|演示文稿|幻灯片)[^。\n]{0,24}(?:生成|制作|创建|重做|修改|导出)", text
    )
    presentation_topic = _has(
        r"(?:每页|这一页|第\s*\d+\s*页|一页|加一页|封面|演示文稿|幻灯片|PPT|ppt|动画|转场|动画时间轴|主题配色|版式|标题|字号|字体|图表|Logo|logo|图片|主题|排版)", text
    )
    if presentation_context and presentation_topic and (
        _has(r"(?:修改|调整|增加|添加|删除|移除|替换|改成|换成|改|优化|实现|修复|重做|继续|去掉|关掉)", text)
        or _has(r"(?:更|再|太|有点|不够|一点|一些|试试|好看|简洁|精致|大点|小点)", text)
    ):
        ppt_intent = True
    preview_intent = has_preview and _has(
        r"(?:修改|调整|增加|添加|删除|移除|替换|改成|换成|优化|完善|实现|修复|生成|创建|检查|查看|读取|预览|设计|设置|做成|改|加上|去掉|搜索|搜一下|查找)", text
    ) and _has(r"(?:preview|预览|项目|源码|代码|页面|网页|网站|react|tsx|jsx|组件|demo|应用|功能|样式|布局|按钮|标题|场景|three\.js|logo|favicon|头像)", text)
    if has_preview and _has(r"(?:缩小|放大|调大|调小|大点|小点|颜色|配色|圆角|间距|居中|动画|过渡)", text):
        preview_intent = True
    if _has(r"(?:怎么|如何|为什么|为何|是什么|是否|是不是|区别|原因)", text) and not _has(
        r"(?:帮我|请|直接|继续|把|将|给我).{0,12}(?:修改|调整|添加|删除|替换|改成|换成|优化|实现|生成|创建)", text
    ):
        preview_intent = False

    if preview_intent:
        selected.update(item.name for item in PREVIEW_TOOLS)
        profiles.append("preview")
        instructions.append(PREVIEW_PROMPT)
        if _has(r"(?:3d|三维|低多边形|参数化模型|场景模型)", text):
            selected.add(set_3d_scene.name)

    workspace_reference = _has(r"(?:真实项目|本地项目|本地源码|磁盘|工作区|当前 Web 项目|Gor 源码|服务端源码|项目文件)", text)
    local_edit = allow_workspace_edit and _has(r"(?:修改|编辑|增加|添加|删除|替换|改成|修复|调整|重构|创建|加上|加一个|插入)", text)
    local_read = allow_workspace_edit and workspace_reference and _has(r"(?:查看|读取|搜索|查找|检查|分析|定位)", text)
    if (local_edit or local_read) and not preview_intent:
        selected.update({"search_project_files", "read_project_file"})
        if local_edit:
            selected.update({"edit_project_file", "create_project_file"})
        profiles.append("workspace")
        instructions.append(PROJECT_PROMPT)

    if ppt_intent:
        selected.add("create_ppt")
        profiles.append("presentation")
        # Keep detailed deck-design guidance only on presentation turns.
        instructions.append(PRESENTATION_PROMPT)
        if _has(r"(?:研究|市场|行业|趋势|最新|现状|数据|政策|竞争|报告|调研)", text):
            selected.add("web_search")
        if _has(r"(?:配图|图片|照片|素材|视觉参考)", text):
            selected.add("search_images")

    weather_intent = _has(r"(?:天气|气温|降雨|下雨|风速|湿度|天气预报)", text)
    if weather_intent:
        selected.add("get_weather")
        profiles.append("weather")
        instructions.append(WEATHER_PROMPT)

    if _has(r"(?:知识库|私有资料|内部文档|上传的(?:文件|资料|文档)|我上传的)", text):
        selected.add("vector_search")
        profiles.append("knowledge")
        instructions.append(KNOWLEDGE_PROMPT)

    image_intent = _has(r"(?:搜索图片|找图片|找些图片|图片素材|图片候选|找配图|搜索.*(?:图片|素材)|图片灵感)", text)
    if image_intent:
        selected.add("search_images")
        profiles.append("images")
        instructions.append(IMAGE_PROMPT)

    web_intent = _has(
        r"(?:新闻|时事|实时(?:新闻|资讯|信息|价格|行情|数据)|最新(?:的)?|当前(?:的)?(?:价格|版本|政策|规则|行情)|联网|上网|搜索(?:一下|最新|资料|信息)?|搜一下|查一下|帮我查|查找资料|官方文档|官方资料|来源链接|GitHub|开源实现|代码片段|最佳实践|汇率|利率|票价|多少钱|赛程|比分|排名)", text
    ) or _has(r"(?:医疗|用药|药物副作用|法律法规|法律建议|投资建议|股价|基金净值|产品对比|比价|旅游攻略|旅行规划|机票|酒店推荐|餐厅推荐|景点推荐|推荐.{0,12}(?:餐厅|酒店|产品|软件|路线|景点|餐馆|咖啡)|现任.{0,8}(?:总统|总理|首相|CEO|董事长|市长)|谁是.{0,8}(?:总统|总理|首相|CEO|董事长|市长))", text)
    web_intent = web_intent and not weather_intent and not _has(
        r"(?:代码|源码|项目|工作区|服务端|后台).{0,10}(?:最新|版本|搜索|查找)|(?:最新|当前).{0,10}(?:代码|源码|项目|工作区|服务端|后台)", text
    ) and not _has(r"(?:本地|磁盘|工作区|当前项目|Gor).{0,10}(?:代码|源码|文件|项目)", text) and not _has(
        r"(?:Preview|preview|预览项目).{0,12}(?:搜索|查找|源码|代码)", text
    )
    if web_intent:
        selected.add("web_search")
        profiles.append("web")
        instructions.append(WEB_PROMPT)

    create_doc = _has(r"(?:生成|制作|创建|导出|做成|写成|帮我做|帮我生成)", text)
    if create_doc and _has(r"(?:word|docx|word文档|文档文件)", text):
        selected.add("create_word")
    if create_doc and _has(r"(?:excel|xlsx|电子表格|表格文件)", text):
        selected.add("create_excel")
    if create_doc and _has(r"(?:pdf|PDF)", text):
        selected.add("create_pdf")
    if selected & {"create_word", "create_excel", "create_pdf"}:
        profiles.append("documents")
        instructions.append(DOCUMENT_PROMPT)

    if _has(r"(?:生成视频|制作视频|做个视频|视频生成|小云雀)", text):
        selected.add("generate_xiaoyunque_video")
        profiles.append("video")
        instructions.append(VIDEO_PROMPT)

    explicit_execution = _has(r"(?:运行|执行|测试|验证|调试)", text) and _has(
        r"(?:python|代码|脚本|程序|函数|算法)", text
    )
    if explicit_execution and not (preview_intent or local_edit):
        selected.add("execute_python")
        profiles.append("python")
        instructions.append(PYTHON_PROMPT)

    # Project inspection is often phrased as a question, not an edit request.
    if has_preview and not preview_intent and _has(r"(?:当前项目|这个项目|项目源码|源码结构|文件结构)", text):
        selected.update(item.name for item in PREVIEW_TOOLS[:3])
        profiles.append("preview_read")
        instructions.append(PREVIEW_PROMPT)

    selected.intersection_update(_TOOL_NAMES)
    if not selected:
        return ToolRoute("chat", (), BASE_PROMPT)

    profile = "+".join(dict.fromkeys(profiles)) or "chat"
    prompt_parts = [BASE_PROMPT, *dict.fromkeys(instructions)]
    return ToolRoute(profile, tuple(sorted(selected)), "\n\n".join(prompt_parts))
