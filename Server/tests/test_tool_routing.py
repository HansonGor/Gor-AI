from agent.tool_routing import route_request
from agent.prompts import SYSTEM_PROMPT
from agent.tool_routing import PRESENTATION_PROMPT
from agent.agent import execute_tool
import asyncio


def test_static_question_gets_no_tools():
    route = route_request("revision 是什么？")
    assert route.profile == "chat"
    assert route.tool_names == ()


def test_web_search_is_not_bound_to_other_tools():
    route = route_request("帮我查一下 Python 3.14 的最新发布信息")
    assert route.tool_names == ("web_search",)
    assert "联网检索" in route.system_prompt


def test_weather_does_not_also_bind_web_search():
    route = route_request("查一下广州今天的天气")
    assert route.tool_names == ("get_weather",)


def test_preview_edit_only_gets_preview_tools():
    route = route_request("把 Preview 页面标题改成清单", has_preview=True)
    assert set(route.tool_names) == {
        "batch_patch_preview_files",
        "list_preview_files",
        "patch_preview_file",
        "read_preview_file",
        "search_preview_code",
        "write_preview_file",
    }
    assert "web_search" not in route.tool_names
    assert "create_ppt" not in route.tool_names


def test_document_generation_uses_matching_format_only():
    route = route_request("请把以下内容生成 Word 文档")
    assert route.tool_names == ("create_word",)


def test_local_project_tools_require_explicit_authorization():
    text = "修改当前项目的按钮颜色"
    assert route_request(text, allow_workspace_edit=False).tool_names == ()
    route = route_request(text, allow_workspace_edit=True)
    assert set(route.tool_names) == {
        "create_project_file",
        "edit_project_file",
        "read_project_file",
        "search_project_files",
    }


def test_local_project_read_is_read_only_and_permission_gated():
    text = "帮我查看本地项目源码"
    assert route_request(text, allow_workspace_edit=False).tool_names == ()
    route = route_request(text, allow_workspace_edit=True)
    assert route.tool_names == ("read_project_file", "search_project_files")


def test_presentation_context_forces_presentation_tool():
    route = route_request("继续优化这份演示文稿", presentation_context={"title": "demo"})
    assert "create_ppt" in route.tool_names
    assert len(route.system_prompt) < len(SYSTEM_PROMPT)
    assert "Preview Project 源码工具" not in PRESENTATION_PROMPT


def test_simple_presentation_uses_the_unified_presentation_tool():
    route = route_request("帮我制作一个简单的标题正文型 PPT")
    assert route.tool_names == ("create_ppt",)
    assert route.profile == "presentation"
    assert "Motion Schema" in route.system_prompt


def test_unrelated_presentation_history_does_not_enable_tools():
    route = route_request("你好，今天怎么样？", presentation_context={"title": "old deck"})
    assert route.tool_names == ()


def test_short_presentation_revision_uses_recent_schema_without_web_tools():
    route = route_request("标题再大点", presentation_context={"title": "old deck"})
    assert route.tool_names == ("create_ppt",)


def test_question_about_local_latest_code_does_not_route_to_web():
    route = route_request("后台是否启用最新代码")
    assert route.tool_names == ()


def test_current_recommendations_get_web_only():
    route = route_request("推荐几家东京餐厅")
    assert route.tool_names == ("web_search",)


def test_execution_layer_enforces_selected_tool_allowlist():
    result = asyncio.run(execute_tool("get_weather", {"city": "广州"}, allowed_tool_names=set()))
    assert "未开放工具" in result
