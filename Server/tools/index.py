"""
工具汇总导出模块
职责：统一导出所有 Agent 可用工具
"""
from langchain_core.tools import tool

from tools.weather import get_weather
from tools.web_search import web_search
from tools.document import create_word, create_excel, create_pdf
from tools.presentation import create_ppt
from tools.image_search import search_images
from tools.video import generate_xiaoyunque_video
from tools.vector_search import vector_search
from tools.code_execution import execute_python
from tools.project_files import (
    search_project_files,
    read_project_file as legacy_read_project_file,
    edit_project_file,
    create_project_file as legacy_create_project_file,
)
from tools.project_api_tools import (
    list_project_files,
    search_project_code,
    read_project_file,
    patch_project_file,
    batch_patch_project_files,
    write_project_file,
    create_project_file,
    create_project_directory,
    delete_project_file,
    delete_project_directory,
)
from tools.preview_project import PREVIEW_TOOLS
from tools.scene_spec import set_3d_scene

# 工具列表（按名称排序）
TOOLS = [
    get_weather,
    web_search,
    search_images,
    create_word,
    create_excel,
    create_ppt,
    create_pdf,
    generate_xiaoyunque_video,
    vector_search,
    execute_python,
    *PREVIEW_TOOLS,
    set_3d_scene,
]

# Real Web source tools remain available only through the explicit workspace-edit route.
WORKSPACE_TOOLS = TOOLS + [
    list_project_files,
    search_project_code,
    read_project_file,
    patch_project_file,
    batch_patch_project_files,
    write_project_file,
    create_project_file,
    create_project_directory,
    delete_project_file,
    delete_project_directory,
    search_project_files,
    edit_project_file,
]

__all__ = ["TOOLS", "WORKSPACE_TOOLS", "legacy_read_project_file", "legacy_create_project_file"]
