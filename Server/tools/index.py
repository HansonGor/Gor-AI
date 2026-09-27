"""
工具汇总导出模块
职责：统一导出所有 Agent 可用工具
"""
from langchain_core.tools import tool

from tools.weather import get_weather
from tools.web_search import (
    web_search,
    web_search_overseas,
    web_search_deep,
    search_github_code,
)
from tools.document import create_word, create_excel, create_ppt, create_pdf
from tools.presentation import create_presentation
from tools.video import generate_xiaoyunque_video
from tools.vector_search import vector_search
from tools.code_execution import execute_python
from tools.project_files import search_project_files, read_project_file, edit_project_file, create_project_file
from tools.preview_project import PREVIEW_TOOLS
from tools.scene_spec import set_3d_scene

# 工具列表（按名称排序）
TOOLS = [
    get_weather,
    web_search,
    web_search_overseas,
    web_search_deep,
    search_github_code,
    create_word,
    create_excel,
    create_ppt,
    create_presentation,
    create_pdf,
    generate_xiaoyunque_video,
    vector_search,
    execute_python,
    *PREVIEW_TOOLS,
    set_3d_scene,
]

# Real Web source tools remain available only through the explicit workspace-edit route.
WORKSPACE_TOOLS = TOOLS + [search_project_files, read_project_file, edit_project_file, create_project_file]

__all__ = ["TOOLS", "WORKSPACE_TOOLS"]
