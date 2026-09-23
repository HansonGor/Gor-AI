"""
SSE 流式聊天路由
职责：建立 SSE 长连接，接收用户消息，委托 agent 执行推理循环，推送结果给客户端
"""
import asyncio
import json
from typing import AsyncGenerator, Dict, Any

from fastapi import APIRouter, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from agent.agent import run_agent
from tools.preview_project import PreviewProjectWorkspace
from agent.token_callback import TokenCountCallback
from config import config
from db.model_quota import deduct_model_quota, get_model_display_name
from db.supabase_chat import (
    auto_generate_session_title,
    load_messages,
    save_message,
)

router = APIRouter()


class ChatRequest(BaseModel):
    sessionId: str
    message: str = ""
    messages: list = []
    previewProject: dict | None = None
    workspaceEdit: bool = False


@router.post("/chat")
async def chat(request: Request, body: ChatRequest):
    """
    POST /api/chat
    SSE 流式聊天接口
    """
    print("[SSE] 收到请求")

    async def event_generator() -> AsyncGenerator[str, None]:
        # ===== SSE 连接建立 =====
        yield ": connected\n\n"

        # ===== SSE 事件发送辅助函数 =====
        def send_event(event: Dict[str, Any]) -> str:
            return f"data: {json.dumps(event, ensure_ascii=False)}\n\n"

        try:
            session_id = body.sessionId
            message = body.message
            messages = body.messages

            # 校验 sessionId 非空
            if not session_id:
                yield send_event({"type": "error", "message": "缺少 sessionId，请先创建会话"})
                yield send_event({"type": "done"})
                return

            # 获取当前用户消息内容
            user_content = message
            if not user_content and isinstance(messages, list) and len(messages) > 0:
                last_msg = messages[-1]
                user_content = last_msg.get("content", "")

            if not user_content:
                yield send_event({"type": "error", "message": "消息内容不能为空"})
                yield send_event({"type": "done"})
                return

            # Browser Virtual FS is sent as a bounded snapshot for this request only.
            # Real workspace edits require an explicit, separate opt-in.
            try:
                preview_workspace = PreviewProjectWorkspace.from_request(body.previewProject)
            except ValueError as exc:
                yield send_event({"type": "error", "message": str(exc)})
                yield send_event({"type": "done"})
                return
            print(f"[SSE] Preview Project snapshot: {preview_workspace.project_id if preview_workspace else 'none'}")

            # 1. 保存用户消息到数据库（包含图片信息）
            user_images = None
            if isinstance(messages, list) and len(messages) > 0:
                last_msg = messages[-1]
                if last_msg.get("images"):
                    user_images = last_msg["images"]

            try:
                await save_message(session_id, "user", user_content, images=user_images)
                print("[SSE] 用户消息已保存（含图片）")
            except Exception as db_err:
                print(f"[SSE] 保存用户消息失败: {db_err}")
                # 不中断流程，继续执行

            # 2. 从数据库加载最近 30 条历史消息
            history_messages = []
            try:
                db_messages = await load_messages(session_id)
                # 取最近 30 条（包含刚保存的用户消息）
                recent_messages = db_messages[-30:]
                history_messages = [
                    {
                        "role": m["role"],
                        "content": m["content"],
                        "images": m.get("images"),
                    }
                    for m in recent_messages
                ]
                print(f"[SSE] 加载历史消息 {len(history_messages)} 条")
            except Exception as db_err:
                print(f"[SSE] 加载历史消息失败: {db_err}")
                # 加载失败时使用当前请求中的消息（含图片）
                history_messages = []
                if isinstance(messages, list) and len(messages) > 0:
                    history_messages = [
                        {
                            "role": m.get("role", "user"),
                            "content": m.get("content", ""),
                            "images": m.get("images"),
                        }
                        for m in messages
                    ]

            # 如果请求体中有图片信息，合并到历史消息的最后一条中
            if isinstance(messages, list) and len(messages) > 0:
                last_msg = messages[-1]
                if last_msg.get("images") and len(last_msg["images"]) > 0:
                    if history_messages:
                        history_messages[-1]["images"] = last_msg["images"]
                    else:
                        history_messages.append({
                            "role": "user",
                            "content": user_content,
                            "images": last_msg["images"],
                        })

            # 3. 累计 AI 完整回答，用于流结束后存库
            full_assistant_content = ""
            full_assistant_files = []

            # 使用队列传递事件（必须在 wrapped_send_event 之前创建）
            event_queue: asyncio.Queue[Dict[str, Any]] = asyncio.Queue()

            def wrapped_send_event(event: Dict[str, Any]) -> None:
                nonlocal full_assistant_content, full_assistant_files
                if event.get("type") == "token" and event.get("content"):
                    full_assistant_content += event["content"]
                if event.get("type") == "file_ready" and event.get("downloadUrl"):
                    full_assistant_files.append({
                        "fileType": event.get("fileType", ""),
                        "displayName": event.get("displayName", ""),
                        "downloadUrl": event.get("downloadUrl", ""),
                    })
                # 将事件放入队列，由主循环读取并发送
                event_queue.put_nowait(event)

            # 4. 创建 token 统计回调实例
            token_callback = TokenCountCallback()

            # 5. 创建取消信号
            cancel_event = asyncio.Event()

            # 启动 Agent 执行（后台任务）
            agent_task = asyncio.create_task(
                run_agent(
                    history_messages,
                    wrapped_send_event,
                    cancel_event,  # signal
                    [token_callback],
                    preview_workspace,
                    body.workspaceEdit,
                )
            )

            # 6. 从队列读取事件并发送
            while not agent_task.done() or not event_queue.empty():
                # 检查连接是否断开
                if await request.is_disconnected():
                    print("[SSE] 客户端连接关闭，取消 Agent")
                    cancel_event.set()
                    agent_task.cancel()
                    break
                try:
                    event = await asyncio.wait_for(event_queue.get(), timeout=0.5)
                    yield send_event(event)
                except asyncio.TimeoutError:
                    continue

            # 等待 Agent 完成
            try:
                await agent_task
            except asyncio.CancelledError:
                pass

            # 7. 获取累加完成的 token 数据
            token_usage = token_callback.get_usage()
            print(
                f"[SSE] 本次对话 token 消耗: prompt={token_usage['prompt_tokens']}, "
                f"completion={token_usage['completion_tokens']}, total={token_usage['total_tokens']}"
            )

            # 8. 发送 token_usage 事件给前端
            yield send_event({
                "type": "token_usage",
                "prompt_tokens": token_usage["prompt_tokens"],
                "completion_tokens": token_usage["completion_tokens"],
                "total_tokens": token_usage["total_tokens"],
            })

            # 9. 计算上下文剩余信息，发送 context_remain 事件
            context_remain = token_callback.get_context_remain()
            print(
                f"[SSE] 上下文剩余: 已用={context_remain['prompt_tokens']}/{context_remain['max_context']}, "
                f"剩余={context_remain['remain_token']}, 告警={context_remain['warning']}"
            )
            yield send_event({
                "type": "context_remain",
                "prompt_tokens": context_remain["prompt_tokens"],
                "max_context": context_remain["max_context"],
                "remain_token": context_remain["remain_token"],
                "warning": context_remain["warning"],
            })

            # 10. 模型额度扣减，发送 model_quota_info 事件
            model_display_name = get_model_display_name(config.Ark.MODEL_ID)
            total_tokens = token_usage["total_tokens"]
            quota_result = await deduct_model_quota(model_display_name, total_tokens)

            if quota_result:
                print(
                    f"[SSE] 模型额度扣减: {quota_result['model_name']}, "
                    f"旧={quota_result['old_remain']}, 消耗={quota_result['cost_total']}, 新={quota_result['new_remain']}"
                )
                yield send_event({
                    "type": "model_quota_info",
                    "model_name": quota_result["model_name"],
                    "old_remain": quota_result["old_remain"],
                    "cost_total": quota_result["cost_total"],
                    "new_remain": quota_result["new_remain"],
                })
            else:
                print(f"[SSE] 模型 {model_display_name} 额度扣减失败或表中无记录")

            # 11. 全局埋点：写入监控日志
            print(
                f"[MetricsLog] sessionId={session_id}, model={config.Ark.MODEL_ID}, "
                f"prompt_tokens={token_usage['prompt_tokens']}, "
                f"completion_tokens={token_usage['completion_tokens']}, "
                f"total_tokens={token_usage['total_tokens']}, "
                f"remain_token={context_remain['remain_token']}, "
                f"warning={context_remain['warning']}, "
                f"model_quota={quota_result['new_remain'] if quota_result else 'N/A'}"
            )

            # 12. 流结束后保存 AI 完整回答（包含 token 数据）
            if full_assistant_content.strip():
                try:
                    await save_message(
                        session_id,
                        "assistant",
                        full_assistant_content,
                        token_usage,
                        attachments=full_assistant_files,
                    )
                    print("[SSE] AI 回答已保存（含 token 数据）")

                    # 13. AI 回答保存后，判断是否需要自动生成会话标题
                    try:
                        await auto_generate_session_title(session_id)
                    except Exception as title_err:
                        print(f"[SSE] 自动生成标题失败: {title_err}")
                except Exception as db_err:
                    print(f"[SSE] 保存 AI 回答失败: {db_err}")

            yield send_event({"type": "done"})

        except Exception as err:
            print(f"[Chat Error] {err}")
            import traceback
            traceback.print_exc()
            yield send_event({"type": "error", "message": str(err) or "服务内部错误"})
            yield send_event({"type": "done"})
        finally:
            print("[SSE] 连接已关闭")

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )
