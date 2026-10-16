"""思考面板标题与摘要：按真实参数和回执说明每一步在做什么，不额外调用模型。"""

import asyncio
import json

from langchain_core.messages import AIMessage

from models.thinking import ThinkingAdapter, ThinkingTrace, final_presentation, tool_presentation


def run_tool(trace, round_id, name, args, result):
    trace.accept({"type": "thinking_start", "roundId": round_id})
    trace.accept({"type": "thinking_end", "roundId": round_id})
    trace.accept({"type": "tool_start", "name": name, "args": json.dumps(args, ensure_ascii=False)})
    payload = result if isinstance(result, str) else json.dumps(result, ensure_ascii=False)
    return trace.accept({"type": "tool_end", "name": name, "result": payload})


def final_event(round_id):
    return {"type": "thinking_update", "roundId": round_id, "source": "phase", "phase": "final_response",
            "title": "整理答复", "summary": "正在结合已收到的信息组织答复。"}


def test_commit_session_replay_has_distinct_titles_and_concrete_summaries():
    """复现会话 1db36e00 的真实调用序列。"""
    trace = ThinkingTrace()
    status = {"branch": "main", "ahead": 0, "staged": {"files": [], "total": 0},
              "unstaged": {"files": [{"path": "/project.md", "status": "modified"}], "total": 1},
              "untracked": {"files": [], "total": 0}, "conflicts": {"files": [], "total": 0}, "dirtyDocuments": []}
    run_tool(trace, "1", "git_status", {}, status)
    run_tool(trace, "2", "git_status", {"include_diff": True}, {**status, "diff": "...", "diffTruncated": True})
    run_tool(trace, "3", "read_project_file", {"path": "/project.md", "start_line": 1, "end_line": 80},
             {"success": True, "content": "x", "totalLines": 480, "startLine": 1, "endLine": 80})
    run_tool(trace, "4", "search_project_code", {"query": "2026-10-15", "path": "/project.md"},
             {"results": [{"path": "/project.md", "line": 241}, {"path": "/project.md", "line": 244}], "truncated": False})
    run_tool(trace, "5", "read_project_file", {"path": "/project.md", "start_line": 236, "end_line": 245},
             {"success": True, "content": "y", "totalLines": 480})
    run_tool(trace, "6", "git_commit", {"message": "docs: 更新 project.md", "paths": ["/project.md"]},
             {"committed": True, "branch": "main", "commit": "bbbbbbbb2222", "files": [{"path": "/project.md"}]})
    trace.accept({"type": "thinking_start", "roundId": "7"})
    event = final_event("7")
    trace.accept(event)

    titles = [r["title"] for r in trace.rounds]
    assert titles == ["查看 Git 状态", "读取改动差异", "读取 project.md 第 1–80 行", "搜索「2026-10-15」",
                      "读取 project.md 第 236–245 行", "提交 project.md 并推送", "汇总提交结果"]
    summaries = [r["summary"] for r in trace.rounds]
    assert summaries[0] == "分支 main，未暂存 1 个文件。"
    assert summaries[1] == "分支 main，未暂存 1 个文件，差异已截断。"
    assert summaries[2] == "已读取第 1–80 行（文件共 480 行）。"
    assert summaries[3] == "找到 2 处匹配，涉及 1 个文件。"
    assert summaries[4] == "已读取第 236–245 行（文件共 480 行）。"
    assert summaries[5] == "已提交 1 个文件到 main，提交号 bbbbbbbb。"
    assert summaries[6] == "结合 6 项工具结果向你说明：已提交 1 个文件到 main，提交号 bbbbbbbb。"
    assert not any("尚未确认是否成功" in s or "整理答复" in s for s in summaries)
    # 前端收到的是同一个事件对象，标题与持久化记录一致
    assert event["title"] == "汇总提交结果" and event["summary"] == summaries[6]


def test_git_running_cancel_and_failure_are_truthful():
    running = tool_presentation("git_push", {"remote": "origin"})
    assert running["title"] == "推送代码到 origin"
    assert "等待你在 VS Code 确认框中确认" in running["summary"]

    cancelled = tool_presentation("git_commit", {}, json.dumps(
        {"success": False, "code": "USER_CANCELLED", "error": "用户取消了提交，未做任何改动。"}), True)
    assert cancelled["title"] == "提交全部改动并推送"
    assert cancelled["summary"] == "你在确认框中取消了操作，未做任何改动。"
    assert cancelled["status"] == "cancelled"

    failed = tool_presentation("git_commit", {"paths": ["/a.ts", "/b.ts", "/c.ts"]}, json.dumps(
        {"success": False, "code": "DIRTY_DOCUMENTS", "error": "有未保存的文件，提交不会包含这些修改。"}), True)
    assert failed["title"] == "提交 a.ts、b.ts 等 3 个文件并推送"
    assert failed["summary"] == "提交代码未成功：有未保存的文件，提交不会包含这些修改。"
    assert failed["status"] == "fail"

    pushed = tool_presentation("git_push", {}, json.dumps(
        {"pushed": True, "remote": "origin", "branch": "feat", "pushedCommits": None, "setUpstream": True,
         "upstream": "origin/feat"}), True)
    assert pushed["summary"] == "已推送到 origin/feat，并设置了上游。"
    nothing = tool_presentation("git_push", {}, json.dumps({"pushed": False, "message": "没有需要推送的提交。"}), True)
    assert nothing["summary"] == "没有需要推送的提交。"


def test_search_list_reader_and_web_search_digests():
    assert tool_presentation("web_search", {"query": "美联储 利率"}, "【搜索意图】news\n【结果 6 条】\n[S1] ...", True) == {
        "title": "检索「美联储 利率」", "summary": "找到 6 条来源。", "status": "ok"}
    assert tool_presentation("web_search", {}, "【结果 0 条】", True)["summary"] == "没有找到可用来源。"
    reader = tool_presentation("web_reader", {"urls": ["https://a", "https://b", "https://c"]}, json.dumps(
        {"success": True, "pages": [{}, {}], "failures": [{"url": "https://c"}]}), True)
    assert reader["title"] == "读取 3 篇网页"
    assert reader["summary"] == "成功读取 2 篇，1 篇读取失败。"
    assert tool_presentation("list_project_files", {}, json.dumps({"success": True, "files": ["/a", "/b"]}), True
                             )["summary"] == "共 2 个文件。"
    empty = tool_presentation("search_preview_code", {"query": "Counter"}, json.dumps({"success": True, "matches": []}), True)
    assert empty["title"] == "搜索「Counter」"
    assert empty["summary"] == "没有找到匹配内容。"
    whole = tool_presentation("read_preview_file", {"path": "/src/App.tsx"}, json.dumps(
        {"success": True, "content": "x", "totalLines": 12}), True)
    assert whole["title"] == "读取 App.tsx"
    assert whole["summary"] == "已读取全文（文件共 12 行）。"


def test_final_round_keeps_generic_text_without_tool_results_and_reports_failures():
    trace = ThinkingTrace()
    trace.accept({"type": "thinking_start", "roundId": "1"})
    event = final_event("1")
    trace.accept(event)
    assert trace.rounds[0]["title"] == "整理答复"
    assert event["title"] == "整理答复"

    outcomes = [
        {"name": "web_search", "status": "ok", "summary": "找到 6 条来源。"},
        {"name": "web_reader", "status": "fail", "summary": "读取网页资料未成功。"},
        {"name": "read_project_file", "status": "ok", "summary": "已读取全文。"},
    ]
    final = final_presentation(outcomes)
    assert final["title"] == "汇总检索结果"
    assert final["summary"] == "结合 3 项工具结果向你说明（其中 1 项未成功）：读取网页资料未成功。"
    assert final_presentation([{"name": "patch_project_file", "status": "ok", "summary": "已修改。"},
                               {"name": "git_status", "status": "ok", "summary": "分支 main。"}])["title"] == "汇总修改结果"
    assert final_presentation([{"name": "git_status", "status": "ok", "summary": "分支 main。"}])["title"] == "汇总查看结果"


def test_other_phases_are_not_rewritten_and_adapter_tags_phase():
    trace = ThinkingTrace()
    run_tool(trace, "1", "git_status", {}, {"branch": "main"})
    trace.accept({"type": "thinking_start", "roundId": "2"})
    event = {"type": "thinking_update", "roundId": "2", "source": "phase", "phase": "patch_generation",
             "title": "制定修改方案", "summary": "正在分析文件修改方案，尚未执行本轮修改。"}
    trace.accept(event)
    assert event["title"] == "制定修改方案"

    events = []

    class Model:
        async def ainvoke(self, messages, config=None):
            return AIMessage(content="ok")

    asyncio.run(ThinkingAdapter(events.append, 3, phase="final_response").invoke(Model(), [], []))
    assert events[1]["phase"] == "final_response" and events[1]["source"] == "phase"
