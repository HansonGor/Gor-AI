"""Independent public GitHub code-search skill; source text stays bounded."""

import json

from langchain_core.tools import tool

from tools.web_search import _SEARCH_RESULT_MARKER


@tool
def search_github_code(query: str, original_query: str = "", user_language: str = "") -> str:
    """Search public GitHub source code, independently of general Web Search.

    Use for GitHub/open-source repositories, implementations, code examples,
    issues/PR references, or when Web results reveal a code topic worth checking.
    First discover repositories: an explicit GitHub URL/owner-repo is resolved
    directly; otherwise exact-name matches rank first and fuzzy matches are
    ordered by stars. Known aliases (for example "antd mobile") resolve to the
    canonical project name. Search code only when the request asks for source,
    implementation, examples or similar details, and scope it to the top repo
    candidate when available. query should contain concrete product/code terms.
    Returns bounded file references and source markers, never whole source files.
    Summarize the implementation and cite the actual references; do not dump code.
    Missing credentials, errors and no matches are reported separately.
    """
    from tools.search_orchestrator import orchestrator, format_results

    payload = orchestrator.run_github(query, original_query=original_query, user_language=user_language)
    text = format_results(payload)
    code_status = payload.get("github_code_search_status", "not_requested")
    if code_status not in ("success", "not_requested"):
        text += "\nGitHub 代码搜索状态：" + code_status
        if payload.get("github_code_search_error"):
            text += "\n" + payload["github_code_search_error"]
    if payload.get("github_repositories_status") == "error":
        text += "\nGitHub 仓库搜索失败。"
        for entry in payload.get("trace", []):
            if entry.get("provider") == "github_repositories" and entry.get("error"):
                text += "\n" + entry["error"]
    return _SEARCH_RESULT_MARKER + json.dumps({
        "text": text, "payload": payload,
    }, ensure_ascii=False)
