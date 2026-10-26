"""Shared, source-free completion text for Web and VS Code project operations."""
import re
import json

PROJECT_REPLY_PROMPT = """项目操作完成后，用通俗易懂的一两句话说明本次做了什么以及结果。
源码、代码块和逐行差异只放到 Diff；聊天回复不要重复源码，也不要只罗列文件路径。
只描述工具确认成功的操作；失败或未执行的步骤要如实说明。读和查按用户问题简洁解释，不倾倒完整源码。"""

# 桌面端「书斋」：沿用插件的工作区工具，只需让模型知道这里没有 VS Code 界面。
DESKTOP_WORKSPACE_PROMPT = """当前客户端是 Gor 桌面端的「书斋」模式：工作区是用户在桌面端选定的本机文件夹，没有打开 VS Code。
工具说明里提到的「VS Code 工作区」在这里就是这个书斋文件夹；向用户说明时称「书斋」，不要让用户去 VS Code 里操作。
书斋暂不支持 Git（提交、推送、查看改动等），用户要求时如实说明并建议在 VS Code 插件或终端中完成；
命令输出与确认在桌面端弹出的对话框中完成，不要提示「输出」面板或状态栏。"""

ADDITIONAL_TASK_LABELS = {
    'web_search': '联网检索', 'web_reader': '网页正文读取', 'search_github_code': 'GitHub 源码检索',
    'search_images': '图片检索', 'get_weather': '天气查询',
    'create_word': 'Word 文档生成', 'create_excel': '表格生成',
    'create_ppt': '演示文稿生成', 'create_pdf': 'PDF 生成',
    'generate_xiaoyunque_video': '视频生成', 'execute_python': '代码执行',
    'vector_search': '知识库检索',
}


def summarize_additional_tasks(outcomes: dict[str, bool | None]) -> str:
    """Summarize confirmed activity, never echo source or claim loading executed a task."""
    parts = []
    for status, prefix in [(True, '另外完成了'), (False, '另有未完成的步骤：'), (None, '另外调用了')]:
        labels = [ADDITIONAL_TASK_LABELS[name] for name, result in outcomes.items()
                  if name in ADDITIONAL_TASK_LABELS and result is status]
        if labels:
            parts.append(prefix + '、'.join(labels) + '。')
    return ('\n\n' + ''.join(parts) + '相关结果、失败原因或附件请查看对应工具反馈。') if parts else ''


def project_subject(files: dict[str, str]) -> str:
    """Use a confirmed content title, never echo implementation/source lines."""
    candidates = []
    try:
        candidates.append(json.loads(files.get('/src/scene.json', '{}')).get('name', ''))
    except (ValueError, AttributeError):
        pass
    match = re.search(r'<title[^>]*>([^<>]+)</title>', files.get('/index.html', ''), re.I)
    if match:
        candidates.append(match.group(1))
    for value in candidates:
        if isinstance(value, str):
            value = re.sub(r'[\r\n`<>{}]', '', value).strip()[:40]
            if value and not re.search(r'^(?:New |Gor )?(?:React |HTML )?(?:Preview|Project)$', value, re.I):
                return value
    return ''


def chinese_count(count: int) -> str:
    if count < 0 or count > 9999:
        return str(count)
    if not count:
        return '零'
    result, gap = '', False
    for place in range(3, -1, -1):
        digit = count // (10 ** place) % 10
        if digit:
            result += ('零' if gap else '') + '零一二三四五六七八九'[digit] + ('', '十', '百', '千')[place]
            gap = False
        elif result:
            gap = True
    return re.sub(r'^一十', '十', result)


def summarize_project_changes(request: str, paths: list[str], *, scene: bool = False, directories: bool = False, provider: str = 'web', subject: str = '') -> str:
    count = len(set(paths))
    if not count:
        return "检查完成，当前内容已符合要求，没有产生新的变更。"
    from project_api.changes import current_recorder
    recorder = current_recorder.get()
    if recorder and recorder.edit_mode == "review":
        # Keep existing display copy; candidates must not claim saved/completed work.
        return f"此番落笔 · {chinese_count(count)}卷留痕"
    if scene:
        title = f'“{subject}”' if subject else '你需要的'
        return f"已完成{title} 3D 模型。生成完成后会自动打开预览，你也可以点击“预览模型”查看、下载 GLB，或点击“阅览源码”查看细节。"
    if re.search(r"删除|删掉|移除", request) and re.search(r"文件|目录|文件夹", request):
        action = "删除了你指定的目录" if directories else "删除了你指定的文件"
    elif re.search(r"恢复|还原|改回|换回|回滚", request):
        action = "将你指定的内容恢复为之前的版本"
    elif re.search(r"生成|新建|创建|搭建|开发|制作|做一个|做个", request):
        action = "创建了一个 React 项目" if re.search(r"react", request, re.I) else "创建了你需要的项目内容"
    elif "标题" in request:
        action = "调整了你指定的标题"
    else:
        action = "完成了你要求的内容调整"
    topic = next((label for pattern, label in [
        (r'待办|todo|清单', '待办清单'), (r'计数|counter', '计数器'),
        (r'登录|login', '登录页面'), (r'天气', '天气展示'),
    ] if re.search(pattern, request, re.I)), '')
    detail = f'，内容是{topic}' if topic else (f'，主题为“{subject}”' if subject else '')
    trace = f'本次涉及 {count} 个目录' if directories else f'此番落笔 · {chinese_count(count)}卷留痕'
    guide = '你可以在 VS Code 工作区查看结果，在 Diff 中查看具体变更。' if provider == 'vscode' else '完成后会自动打开预览；点击“预览项目”查看效果，点击“阅览源码”或展开 Diff 查看细节。'
    return f"已{action}{detail}。{trace}。{guide}"
