"""
Agent 核心循环：图片解析 + 工具调用 + 流式输出
职责：执行 Agent 推理循环，处理工具调用，流式输出最终回答
"""
import asyncio
import json
from typing import Any, Callable, Dict, List, Optional
from urllib.parse import quote

from langchain_core.messages import (
    AIMessage,
    BaseMessage,
    HumanMessage,
    SystemMessage,
    ToolMessage,
)

from config import config
from models.model import model_with_tools, model_with_workspace_tools
from models.vision import analyze_images
from agent.prompts import SYSTEM_PROMPT
from tools.index import TOOLS, WORKSPACE_TOOLS
from tools.preview_project import PREVIEW_TOOL_NAMES, PreviewProjectWorkspace, execute_preview_tool

MAX_ITERATIONS = config.Agent.MAX_ITERATIONS
TYPING_CHUNK_SIZE = config.Agent.TYPING_CHUNK_SIZE
TYPING_DELAY_MS = config.Agent.TYPING_DELAY_MS


async def run_agent(
    user_messages: List[Dict[str, Any]],
    send_event: Callable[[Dict[str, Any]], None],
    signal: Optional[Any] = None,
    callbacks: Optional[List[Any]] = None,
    preview_workspace: Optional[PreviewProjectWorkspace] = None,
    allow_workspace_edit: bool = False,
) -> None:
    """
    运行 Agent 循环

    Args:
        user_messages: 用户消息历史 [{role, content, images?}]
        send_event: 发送 SSE 事件的回调 (event) -> None
        signal: 中止信号（asyncio.Event，连接断开时触发）
        callbacks: LangChain 回调数组（用于 token 统计等）
    """
    callbacks = callbacks or []

    # 检查是否已取消
    if signal and signal.is_set():
        print("[Agent] 启动前检测到取消信号，直接退出")
        return

    # 处理最新一条消息中的图片
    last_message = user_messages[-1] if user_messages else None
    image_analysis = ""

    if last_message and isinstance(last_message.get("images"), list) and len(last_message["images"]) > 0:
        print(f"[Agent] 检测到 {len(last_message['images'])} 张图片，开始解析...")

        send_event({
            "type": "tool_start",
            "name": "image_analysis",
            "args": json.dumps({"count": len(last_message["images"])}),
        })

        image_analysis = analyze_images(last_message["images"], last_message.get("content", ""))

        send_event({
            "type": "tool_end",
            "name": "image_analysis",
            "result": image_analysis,
        })

        print(f"[Agent] 图片解析完成，长度: {len(image_analysis)}")

    # 构造消息列表
    messages: List[BaseMessage] = [SystemMessage(content=SYSTEM_PROMPT)]

    for idx, m in enumerate(user_messages):
        # 最新一条消息，如果有图片，将解析结果拼入内容
        if idx == len(user_messages) - 1 and image_analysis:
            enriched_content = f"[图片解析结果]\n{image_analysis}\n\n[用户问题]\n{m['content']}"
            if m["role"] == "assistant":
                messages.append(AIMessage(content=enriched_content))
            else:
                messages.append(HumanMessage(content=enriched_content))
        else:
            if m["role"] == "assistant":
                messages.append(AIMessage(content=m["content"]))
            else:
                messages.append(HumanMessage(content=m["content"]))

    iterations = MAX_ITERATIONS

    while iterations > 0:
        iterations -= 1
        current_iter = MAX_ITERATIONS - iterations
        print(f"[Agent] 第 {current_iter} 轮调用")

        # 检查取消信号
        if signal and signal.is_set():
            print("[Agent] 检测到取消信号，中断 Agent 循环")
            send_event({"type": "token", "content": "\n\n（响应已中断）"})
            break

        # 立即发送思考状态，避免连接建立后长时间无数据
        send_event({"type": "thinking", "status": "模型思考中..."})

        # 大模型调用期间发送心跳，防止 SSE 连接因长时间无数据而断开
        thinking_heartbeat = asyncio.create_task(_heartbeat(send_event, "thinking", 1.0))

        response = None
        try:
            # 非流式调用，检测是否需要工具，传入 callbacks 捕获 token 消耗
            selected_model = model_with_workspace_tools if allow_workspace_edit else model_with_tools
            response = await selected_model.ainvoke(messages, config={"callbacks": callbacks})
            tool_calls = getattr(response, "tool_calls", None) or []
            content = getattr(response, "content", "") or ""
            print(f"[Agent] 响应: tool_calls={len(tool_calls)}, content长度={len(content)}")
            messages.append(response)
        finally:
            thinking_heartbeat.cancel()
            try:
                await thinking_heartbeat
            except asyncio.CancelledError:
                pass

        # A truncated JSON tool argument is not a successful empty answer.
        # Never execute partial tool calls or retry invisibly at additional cost.
        metadata = getattr(response, "response_metadata", {}) or {}
        if metadata.get("finish_reason") == "length" or getattr(response, "invalid_tool_calls", None):
            send_event({"type": "token", "content": "本次模型输出被截断或工具参数不完整，未执行本轮文件写入。请简化场景或分步生成；也可检查 ARK_MAX_OUTPUT_TOKENS 是否适合当前模型。之前已生成的虚拟文件仍保留。"})
            break

        # 无工具调用 → 最终回答，流式输出
        tool_calls = getattr(response, "tool_calls", None) or []
        if not tool_calls:
            print("[Agent] 无工具调用，发送最终回答")
            content = getattr(response, "content", "") or ""
            if content:
                await stream_content(content, send_event)
            else:
                send_event({"type": "token", "content": "模型未返回可显示的内容或有效工具调用，请重试或简化需求。"})
            break

        # 执行所有工具调用
        for tc in tool_calls:
            tool_name = tc.get("name", "")
            tool_args = tc.get("args", {}) or {}
            visible_args = {"path": tool_args.get("path", "")} if tool_name in {"edit_project_file", "create_project_file", "write_preview_file"} else tool_args
            print(f"[Agent] 调用工具: {tool_name}", json.dumps(visible_args, ensure_ascii=False))
            send_event({
                "type": "tool_start",
                "name": tool_name,
                "args": json.dumps(visible_args, ensure_ascii=False),
            })

            # 长时间运行的工具执行期间也发送心跳
            tool_heartbeat = asyncio.create_task(_heartbeat(send_event, "tool_progress", 1.0, tool_name))

            result = None
            try:
                result = await execute_tool(tool_name, tool_args, signal, preview_workspace, allow_workspace_edit)
            finally:
                tool_heartbeat.cancel()
                try:
                    await tool_heartbeat
                except asyncio.CancelledError:
                    pass

            print(f"[Agent] 工具 {tool_name} 结果长度: {len(str(result))}")
            send_event({"type": "tool_end", "name": tool_name, "result": str(result)})

            # 检测文档生成工具返回的下载链接，发送 file_ready 事件
            # 检测视频生成工具返回的视频URL，发送 video_ready 事件
            try:
                parsed = json.loads(str(result))
                if parsed.get("success") and parsed.get("downloadUrl"):
                    send_event({
                        "type": "file_ready",
                        "fileType": parsed.get("fileType"),
                        "displayName": parsed.get("displayName"),
                        "downloadUrl": parsed.get("downloadUrl"),
                    })
                    print(f"[Agent] 文件已生成: {parsed.get('displayName')}")
                if parsed.get("success") and parsed.get("videoUrl"):
                    send_event({
                        "type": "video_ready",
                        "taskId": parsed.get("taskId"),
                        "videoUrl": parsed.get("videoUrl"),
                    })
                    print(f"[Agent] 视频已生成: {parsed.get('videoUrl')}")
                if tool_name in {"edit_project_file", "create_project_file"} and parsed.get("success"):
                    changed_path = parsed["path"]
                    send_event({
                        "type": "project_file_changed",
                        "path": changed_path,
                        "diff": parsed["diff"],
                    })
                    # Standalone HTML written into the Vite workspace is also a
                    # generated preview artifact. Register it with the same
                    # file_ready flow used by Office/PDF/3D generators so it is
                    # shown by Preview Worker and persisted with the message.
                    if changed_path.lower().endswith((".html", ".htm")):
                        preview_url = "/" + "/".join(quote(part) for part in changed_path.split("/"))
                        send_event({
                            "type": "file_ready",
                            "fileType": "html",
                            "displayName": changed_path.rsplit("/", 1)[-1],
                            "downloadUrl": preview_url,
                        })
                if tool_name == "write_preview_file" and parsed.get("success") and parsed.get("changed"):
                    send_event({
                        "type": "preview_file_changed",
                        "projectId": parsed["projectId"],
                        "path": parsed["path"],
                        "content": parsed["content"],
                        "diff": parsed["diff"],
                    })
            except (json.JSONDecodeError, TypeError):
                # 非 JSON 结果，忽略
                pass

            messages.append(ToolMessage(
                tool_call_id=tc.get("id", ""),
                content=str(result),
            ))

    if iterations <= 0:
        send_event({"type": "token", "content": "\n\n（已达到最大工具调用轮次限制）"})

    print("[Agent] 完成")


async def stream_content(content: str, send_event: Callable[[Dict[str, Any]], None]) -> None:
    """
    分段流式输出文本（模拟打字效果）
    """
    # 按 TYPING_CHUNK_SIZE 个字符分段
    chunks = [content[i:i + TYPING_CHUNK_SIZE] for i in range(0, len(content), TYPING_CHUNK_SIZE)]
    if not chunks:
        chunks = [content]

    print(f"[Stream] 开始流式输出，总长度: {len(content)}，共 {len(chunks)} 段")

    for chunk in chunks:
        send_event({"type": "token", "content": chunk})
        await asyncio.sleep(TYPING_DELAY_MS / 1000.0)

    print("[Stream] 流式输出完成")


async def execute_tool(
    tool_name: str,
    tool_args: Dict[str, Any],
    signal: Optional[Any] = None,
    preview_workspace: Optional[PreviewProjectWorkspace] = None,
    allow_workspace_edit: bool = False,
) -> str:
    """
    执行单个工具
    """
    try:
        if tool_name in PREVIEW_TOOL_NAMES:
            return execute_preview_tool(preview_workspace, tool_name, tool_args)
        if tool_name in {"search_project_files", "read_project_file", "edit_project_file", "create_project_file"} and not allow_workspace_edit:
            return "错误：本轮对话未授权访问真实项目文件，请使用 Preview Project 虚拟文件工具。"
        matched_tool = None
        for t in WORKSPACE_TOOLS if allow_workspace_edit else TOOLS:
            if t.name == tool_name:
                matched_tool = t
                break

        if matched_tool:
            # 视频生成工具需要传递 abort signal
            if tool_name == "generate_xiaoyunque_video":
                # Python 版暂不实现 signal 传递，工具内部已处理超时
                pass

            # 调用工具（支持同步和异步工具）
            result = await matched_tool.ainvoke(tool_args)
            return str(result)

        return f"错误：未找到工具 {tool_name}"
    except Exception as err:
        return f"工具执行错误：{str(err)}"


async def _heartbeat(
    send_event: Callable[[Dict[str, Any]], None],
    event_type: str,
    interval: float,
    tool_name: Optional[str] = None,
) -> None:
    """心跳协程，定期发送状态事件"""
    while True:
        if event_type == "thinking":
            send_event({"type": "thinking", "status": "模型思考中..."})
        elif event_type == "tool_progress" and tool_name:
            send_event({"type": "tool_progress", "name": tool_name, "status": "执行中..."})
        await asyncio.sleep(interval)
