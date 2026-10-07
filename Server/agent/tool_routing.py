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
PREVIEW_3D_PROMPT = """本轮是 Web Preview 中的 3D 模型任务。用户明确要求创建或修改 3D 模型时，直接调用 set_3d_scene，不要只给建模建议或把整段源码贴进聊天。首次创建使用紧凑 SceneSpec；已有场景先读取 /src/scene.json 再做最小 patch。工具完成后，前端会自动构建并导出 GLB 到本轮会话；不要把内部 index.html/Three.js 渲染壳当作交付物，也不要要求用户手动点击导出。最终只简短说明模型已生成及场景文件路径；不要回显源码。"""
PREVIEW_GLB_EXPORT_PROMPT = """用户只要求导出已有的 3D 场景。不要重新生成或修改场景；GLB 会在场景生成或更新后自动保存到对应会话消息，提示用户下载该 GLB 产物。不要把预览所需的 HTML/Three.js 渲染壳说成 3D 模型文件。"""
PROJECT_PROMPT = """用户明确授权修改真实工作区中的项目文件。先搜索并读取相关文件，只改用户要求的目标；谨慎使用局部修改，避免覆盖无关内容。操作失败时说明，不要虚称成功。"""
VSCODE_PROJECT_READ_PROMPT = """本轮只读当前已连接的 VS Code 工作区。工作区目录树由系统按当前工作区和连接代次缓存：未知时自动读取一次，已知时复用；文件或目录操作与实际状态冲突时，系统刷新一次目录树后再返回原操作结果，不要重复枚举或猜测路径。目录树包含工作区相对文件和目录；多根工作区若返回 WORKSPACE_ROOT_REQUIRED，使用结果提供的 root id 重试。不要读取绝对路径，不要尝试写入、创建、删除、构建或运行文件。只根据工具真实返回的文件和片段回答；写入能力当前未开放，不得声称已修改源码。"""
VSCODE_PROJECT_EDIT_PROMPT = """用户已明确要求操作当前 VS Code 工作区，本轮可直接执行，不要再向用户请求手动确认。只能通过通用 Project API 工具；当前已连接工作区就是默认目标，不要求用户重复说“工作区/文件”。按动作词选工具：创建/新建/增加文件或目录用 create_project_file/create_project_directory；修改/改回/恢复/还原已有内容，先搜索并读取，再用 write_project_file 或 patch/batch patch；查找/搜索/定位用 search_project_code；读取/查看用 list_project_files/read_project_file；删除/移除具体文件或目录用对应 delete 工具。复合请求按顺序组合相应工具。目标路径不明确时先用目录树或搜索定位；候选仍不唯一时再询问，不得猜路径或误删。开始文件操作前系统会自动确保当前工作区目录树已读取并缓存；未知时读一次，已知时复用，路径与实际冲突时自动刷新一次。修改已有文件时先读取完整的最新 TextDocument，默认用 write_project_file 直接覆盖目标文件，并传入最新 fileVersion 作为 expected_file_version；只有文件过大或确实不适合整文件覆盖时才使用 exact-text patch/batch patch，old_text 必须来自刚读取的内容且唯一匹配。多文件按各自最新版本分别写入。新文件父目录不存在时，只在目标路径已明确的前提下按需创建缺失父目录，再创建文件。目录删除仅允许空目录，绝不递归删除。遇到版本冲突时重新读取后再处理；遇到路径树冲突时系统已刷新，不要连续盲目重试。不要自动保存，不运行终端、构建、Git 或诊断。成功仅依据工具真实返回确认。最终用通俗句子说明做了什么，只描述成功结果；源码和逐行 diff 仅在 Diff 中展示，不重复列出源码。不要创建 Preview Project、触发 Preview Worker。"""
VSCODE_ACCESS_CHECK_PROMPT = """用户只是在确认 Gor 是否能访问 VS Code 本地工作区。调用 list_project_files 验证工作区连接，但不要把完整文件列表倾倒给用户；成功时简洁说明可以读取当前打开的工作区文件，并请用户指定文件或路径。只有后续明确要求查看某个文件时才读取源码。"""
VSCODE_UNREGISTERED_PROMPT = """当前请求来自 VS Code 插件，但工作区尚未成功注册或没有附带工作区标识。可以尝试调用只读工作区工具确认状态；如果返回 PROJECT_CONTEXT_UNAVAILABLE 或 WORKSPACE_NOT_FOUND，应明确说明 Gor 服务已连接但 VS Code 工作区桥接未就绪，请等待状态栏显示工作区已连接后重试。若用户要求修改文件而本轮没有可用工作区标识，不要调用修改工具或声称已读写文件，先提示连接尚未就绪。不要说插件完全不支持读取。"""
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


def _workspace_followup_context(text: str, history: list[dict] | None) -> str:
    """Resolve short continuations only against a recent user-grounded code task.

    Historical assistant claims are not evidence of capabilities or completed
    edits. An unrelated intervening user turn ends the implicit edit context.
    """
    if _has(r"(?:不要|不用|别|先不|暂不|不需要|不必|取消|停止|怎么|如何|为什么|是否)", text):
        return ""
    continuation = _has(r"(?:上面|上述|刚才|之前|原来|那个|这个|这样|继续|再.{0,8}(?:大|小|一点|一些))", text)
    acknowledgement = re.fullmatch(r"\s*(?:好|好的|可以|行|嗯|对|没问题)[，,。\s]*(?:(?:就|直接)?(?:按上面|按这个|这样|执行|做吧|继续|改吧|照做|处理)[吧。！!\s]*)?", text)
    if not continuation and not acknowledgement:
        return ""
    for message in reversed((history or [])[-8:]):
        if message.get("role") != "user":
            continue
        content = str(message.get("content", ""))[:2000]
        if re.fullmatch(r"\s*(?:好|好的|可以|行|嗯|对|继续)[。！!\s]*", content):
            continue
        if _has(r"(?:项目|代码|文件|目录|文件夹|组件|页面|路由|标题|文案|按钮|样式|功能|\.tsx?\b|\.jsx?\b|\.html\b|\.css\b)", content) and _has(
            r"(?:改|换|恢复|还原|创建|新建|新增|增加|添加|删除|删掉|移除|修复|优化|实现|完善|重构)", content
        ):
            return content
        return ""
    return ""


def route_request(
    text: str,
    *,
    has_preview: bool = False,
    allow_workspace_edit: bool = False,
    vscode_workspace_id: str | None = None,
    vscode_client_mode: bool = False,
    presentation_context: Optional[dict] = None,
    conversation_context: list[dict] | None = None,
) -> ToolRoute:
    """Select the smallest deterministic tool set implied by the latest request."""
    text = text or ""
    if vscode_client_mode or vscode_workspace_id:
        # A stale Web preview must never capture a VS Code workspace request.
        has_preview = False
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
    preview_3d_target = _has(r"(?:(?<![a-z0-9])3d(?![a-z0-9])|三维|模型|glb|gltf|低多边形|建模|场景模型|物体模型)", text)
    preview_3d_scene_action = _has(
        r"(?:生成|新建|创建|制作|建模|搭建|建一个|建个|想要|来一个|来个|做一个|做个|添加|增加|修改|调整|改成|优化|实现)",
        text,
    )
    preview_3d_export_only = (
        has_preview
        and not vscode_client_mode
        and _has(r"(?:glb|gltf|3d|三维|模型)", text)
        and _has(r"(?:导出|下载|保存)", text)
        and not preview_3d_scene_action
    )
    preview_3d_scene_intent = (
        has_preview and not vscode_client_mode and preview_3d_target and preview_3d_scene_action
    )
    preview_3d_edit_intent = preview_3d_scene_intent and _has(
        r"(?:修改|调整|添加|增加|改成|优化|完善|修复|更新|删除|移除)", text,
    )
    preview_3d_intent = preview_3d_scene_intent or preview_3d_export_only
    preview_intent = has_preview and _has(
        r"(?:修改|调整|增加|添加|删除|移除|替换|改成|换成|优化|完善|实现|修复|生成|新建|创建|开发|搭建|制作|做个|做一个|检查|查看|读取|预览|设计|设置|做成|改|加上|去掉|搜索|搜一下|查找)", text
    ) and _has(r"(?:preview|预览|项目|源码|代码|文件|目录|文件夹|页面|网页|网站|react|tsx|jsx|组件|demo|应用|功能|样式|布局|按钮|标题|场景|three\.js|logo|favicon|头像)", text)
    if has_preview and _has(r"(?:改回|恢复原来|还原|继续修改)", text):
        preview_intent = True
    preview_intent = preview_intent or preview_3d_intent
    if has_preview and _has(r"(?:缩小|放大|调大|调小|大点|小点|颜色|配色|圆角|间距|居中|动画|过渡)", text):
        preview_intent = True
    if _has(r"(?:怎么|如何|为什么|为何|是什么|是否|是不是|区别|原因)", text) and not _has(
        r"(?:帮我|请|直接|继续|把|将|给我).{0,12}(?:修改|调整|添加|删除|替换|改成|换成|优化|实现|生成|创建)", text
    ):
        preview_intent = False

    if preview_intent and not preview_3d_export_only:
        profiles.append("preview")
        if preview_3d_scene_intent:
            selected.add(set_3d_scene.name)
            instructions.append(PREVIEW_3D_PROMPT)
            if preview_3d_edit_intent:
                selected.update({"list_preview_files", "read_preview_file"})
        else:
            selected.update(item.name for item in PREVIEW_TOOLS)
            instructions.append(PREVIEW_PROMPT)
    elif preview_3d_export_only:
        profiles.append("preview_export")
        instructions.append(PREVIEW_GLB_EXPORT_PROMPT)

    workspace_reference = _has(r"(?:真实项目|本地项目|本地源码|磁盘|工作区|当前 Web 项目|Gor 源码|服务端源码|项目文件)", text)
    local_edit = allow_workspace_edit and _has(r"(?:修改|编辑|增加|添加|删除|替换|改成|修复|调整|重构|创建|加上|加一个|插入)", text)
    local_read = allow_workspace_edit and workspace_reference and _has(r"(?:查看|读取|搜索|查找|检查|分析|定位)", text)
    if (local_edit or local_read) and not preview_intent and not vscode_workspace_id:
        selected.update({"search_project_files", "read_project_file"})
        if local_edit:
            selected.update({"edit_project_file", "create_project_file"})
        profiles.append("workspace")
        instructions.append(PROJECT_PROMPT)

    # In the VS Code extension, action verbs are the primary signal for choosing
    # Project API tools. Keep the categories distinct so read/search requests do
    # not accidentally receive write tools, while natural edit phrasings such as
    # “改回原来的标题” still select the write workflow.
    followup_context = _workspace_followup_context(text, conversation_context) if (vscode_workspace_id or vscode_client_mode) else ""
    contextual_execution = bool(followup_context) and (
        _has(r"(?:按|照|继续|执行|做吧|改吧|就这样|再.{0,8}(?:大|小|一点|一些))", text)
        or re.fullmatch(r"\s*(?:好|好的|可以|行|嗯|对|没问题)[。！!\s]*", text) is not None
    )
    action_text = f"{text}\n{followup_context}" if contextual_execution else text
    scope_text = f"{text}\n{followup_context}"
    vscode_create_intent = _has(
        r"(?:生成|制作|开发|做一个|做个|新建|新增|创建|增加|添加|加一个|加个|建一个|建个)", action_text,
    )
    vscode_delete_action = _has(
        r"(?:删除|删掉|删去|移除|清除|清理掉|移走)", action_text,
    )
    vscode_update_action = _has(
        r"(?:修改|编辑|更改|调整|修复|改(?:回|为|成|掉|一下)?|换回|换成|替换|恢复|还原|回滚|变回|重命名|重构|优化|实现|完善|更新)",
        action_text,
    )
    if contextual_execution and not (vscode_create_intent or vscode_delete_action or vscode_update_action):
        vscode_update_action = True
    vscode_search_action = _has(
        r"(?:搜索|搜一下|搜寻|搜|查找|查一下|查询|查|找一下|找出|找|定位|检索|在哪|哪里|哪个文件|哪段代码|列出|枚举)",
        text,
    )
    vscode_read_action = _has(
        r"(?:读取|读一下|读下|读到|读|阅读|查看|看一下|看下|看看|看|打开|能看到|解释|说明|介绍|展示|显示)",
        text,
    )
    vscode_directory_create_intent = vscode_create_intent and _has(r"(?:目录|文件夹)", scope_text)
    vscode_file_create_intent = vscode_create_intent and _has(
        r"(?:react|demo|模型|文件|组件文件|页面文件|应用|小工具|程序|网页|网站|项目|组件|页面|前端|(?<![\w.-])[\w./-]+\.(?:tsx?|jsx?|vue|svelte|html|css|scss|less|json|md)\b)", scope_text,
    )
    if vscode_directory_create_intent and not _has(r"(?:文件|\.(?:tsx?|jsx?|vue|svelte|html|css|scss|less|json|md)\b)", scope_text):
        vscode_file_create_intent = False
    vscode_delete_ui_element = _has(r"(?:页面|组件|模块).{0,8}(?:上|里|中)(?:的|那个|这|该)", text)
    vscode_file_delete_intent = vscode_delete_action and _has(
        r"(?:文件|组件|页面|模块|(?<![\w.-])[\w./-]+\.(?:tsx?|jsx?|vue|svelte|html|css|scss|less|json|md)\b)", scope_text,
    ) and not vscode_delete_ui_element
    vscode_directory_delete_intent = vscode_delete_action and _has(r"(?:目录|文件夹)", scope_text)
    vscode_edit_intent = vscode_update_action or vscode_create_intent or vscode_delete_action
    if _has(r"(?:不要|不用|别|先不|暂不|不需要|不必|取消|停止).{0,10}(?:改|编辑|写|创|建|加|增|删|执行|操作)|^(?:取消|停止)$", text):
        vscode_edit_intent = False
    vscode_add_page_intent = _has(r"(?:增加|添加|加上|加一个|加个|新建|创建).{0,12}(?:页面|网页|路由|组件)", text)
    vscode_question_only = _has(
        r"(?:怎么|如何|为什么|为何|是否|是不是|能不能|可不可以|可否|吗[？?]?$)",
        text,
    ) and not _has(
        r"^\s*(?:帮我|帮忙|请|直接|把|将|替我|麻烦|给我|能不能|可不可以|可以(?:帮我|帮忙)?).{0,32}(?:新建|新增|创建|增加|添加|删除|删掉|删去|移除|修改|编辑|更改|调整|修复|改(?:回|为|成|掉|一下)?|换回|换成|替换|恢复|还原|回滚|重命名|重构|优化|实现|完善|更新)",
        text,
    )
    vscode_project_scope = _has(
        r"(?:项目|工作区|仓库|代码库|源码|代码|文件|目录|文件夹|组件|页面|网页|路由|函数|方法|接口|变量|配置|依赖|功能|逻辑|入口|事件|报错|错误|引用|调用|(?<![\w.-])[\w./-]+\.(?:tsx?|jsx?|vue|svelte|html|css|scss|less|json|md)\b|在哪(?:里)?(?:定义|实现|使用|调用))",
        text,
    )
    vscode_project_reference = (bool(vscode_workspace_id) or vscode_client_mode) and (
        # The active VS Code workspace is implicit for explicit mutations.
        # Read/search still need an object or code-location clue to avoid routing
        # unrelated questions (for example, “查一下天气”) into the source tree.
        (vscode_edit_intent and not vscode_question_only)
        or ((vscode_search_action or vscode_read_action) and vscode_project_scope)
        or (
            vscode_project_scope
            and _has(r"(?:有哪些|列出|枚举|结构|内容|技术栈|干嘛|做什么|用途|作用|是什么|是否存在|有没有)", text)
        )
    )
    vscode_project_action = (
        vscode_search_action
        or vscode_read_action
        or vscode_edit_intent
        or _has(r"(?:有哪些|能读到|读得到|能读取|可以读取|可以读到|访问|分析|检查|干嘛|做什么|用途|作用|是什么|什么|结构|内容|使用|用了|技术栈)", text)
    )
    if vscode_project_reference and vscode_project_action and not preview_intent:
        if vscode_edit_intent and not vscode_question_only:
            profiles.append("vscode_project_edit")
            instructions.append(VSCODE_PROJECT_EDIT_PROMPT)
            instructions.append(
                "当前工具清单和本轮连接状态是能力的唯一依据；历史助手声称‘没有工具/只能手动修改’不代表现在的能力。"
                "结合最近用户请求、助手方案和已确认工具结果解析‘改回来/原来的/这个/上面的/继续/就这样’。"
                "用户已要求修改或明确同意前文方案时，直接操作，不要求重复提供路径或代码。"
                "先读目标文件的最新内容再修改；恢复原值应从前文用户内容、已读取源码或变更记录确认，"
                "不能把助手的猜测当原值。只有前文不足以确定目标或原值时才简短询问。"
            )
            if vscode_client_mode and not vscode_workspace_id:
                instructions.append(VSCODE_UNREGISTERED_PROMPT)
            else:
                if vscode_file_create_intent:
                    selected.add("create_project_file")
                    selected.add("create_project_directory")
                if vscode_directory_create_intent:
                    selected.add("create_project_directory")
                if vscode_file_delete_intent:
                    selected.add("delete_project_file")
                if vscode_directory_delete_intent:
                    selected.add("delete_project_directory")

                # A basename or an unnamed target still needs discovery tools;
                # exact workspace-relative paths can go straight to the CRUD API.
                explicit_file_path = re.search(
                    r"(?<![\w.-])/?(?:[\w.-]+[/\\])+[\w.-]+\.(?:tsx?|jsx?|vue|svelte|html|css|scss|less|json|md)\b",
                    text,
                    re.IGNORECASE,
                )
                explicit_directory_path = re.search(
                    r"(?<![\w.-])/?(?:[\w.-]+[/\\])+[\w.-]+",
                    text,
                )
                if (
                    (vscode_file_delete_intent and not explicit_file_path)
                    or (vscode_directory_delete_intent and not explicit_directory_path)
                ):
                    selected.update({"list_project_files", "search_project_code", "read_project_file"})

                # Code-level changes in the same request still use the normal
                # search/read/patch flow; pure CRUD requests get only their CRUD tool.
                code_edit_intent = vscode_update_action or _has(
                    r"(?:清理引用|更新引用|(?:并|同时).{0,30}(?:使用|导入|引用|更新|修改|添加|接入|注册|调用))",
                    text,
                ) or vscode_add_page_intent
                if code_edit_intent or not (
                    vscode_file_create_intent or vscode_directory_create_intent
                    or vscode_file_delete_intent or vscode_directory_delete_intent
                ):
                    selected.update({
                        "search_project_code",
                        "read_project_file",
                        "patch_project_file",
                        "batch_patch_project_files",
                        "write_project_file",
                    })
            # Explicit VS Code edits should never fall through to the read-only route.
            vscode_project_reference = False
        if not vscode_project_reference:
            pass
        else:
            list_intent = _has(r"(?:有哪些.{0,12}(?:文件|目录)|(?:文件|目录).{0,8}(?:列表|结构|有哪些)|列出.{0,8}(?:文件|目录)|枚举.{0,8}(?:文件|目录)|文件结构|目录结构)", text)
            search_intent = vscode_search_action or _has(r"(?:找到|找下|定位|在哪|哪里|包含|哪个文件|哪个源码|哪段代码)", text)
            read_intent = vscode_read_action or _has(
                r"(?:能读到|读得到|能读取|可以读取|可以读到|访问|看到|干嘛|做什么|用途|作用|(?:文件|代码).{0,8}(?:内容|解释))",
                text,
            )
            access_check = _has(r"(?:能|可以|可不可以|是否|能不能).{0,10}(?:读到|读取|访问).{0,12}(?:本地|工作区|项目|文件)|(?:本地|工作区|项目).{0,8}(?:文件).{0,10}(?:能|可以|是否).{0,8}(?:读到|读取|访问)", text)
            filename_match = re.search(r"(?<![\w.-])[\w./-]+\.(?:tsx?|jsx?|vue|svelte|html|css|scss|less|json|md)\b", text, re.IGNORECASE)
            if list_intent:
                selected.add("list_project_files")
            elif search_intent:
                selected.update({"search_project_code", "read_project_file"})
            elif access_check:
                selected.add("list_project_files")
            elif read_intent:
                if filename_match:
                    # A basename is not necessarily a workspace-relative path.
                    # List paths first so the model can resolve it without guessing.
                    selected.update({"list_project_files", "read_project_file"})
                else:
                    # For an implicit target, inspect the tree/search first; the
                    # model can then read the matching workspace-relative file.
                    selected.update({"list_project_files", "search_project_code", "read_project_file"})
            else:
                selected.update({"list_project_files", "search_project_code", "read_project_file"})
            profiles.append("vscode_project")
            instructions.append(VSCODE_PROJECT_READ_PROMPT)
            if access_check:
                instructions.append(VSCODE_ACCESS_CHECK_PROMPT)
            if vscode_client_mode and not vscode_workspace_id:
                instructions.append(VSCODE_UNREGISTERED_PROMPT)

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
        if instructions:
            profile = "+".join(dict.fromkeys(profiles)) or "chat"
            return ToolRoute(profile, (), "\n\n".join([BASE_PROMPT, *dict.fromkeys(instructions)]))
        return ToolRoute("chat", (), BASE_PROMPT)

    profile = "+".join(dict.fromkeys(profiles)) or "chat"
    prompt_parts = [BASE_PROMPT, *dict.fromkeys(instructions)]
    return ToolRoute(profile, tuple(sorted(selected)), "\n\n".join(prompt_parts))
