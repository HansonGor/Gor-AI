"""
FastAPI 应用实例
职责：创建 FastAPI 应用，注册中间件和路由
"""
from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from config import config
from db.supabase_chat import init_db
from tools.index import TOOLS
from routes.chat import router as chat_router
from routes.chat_routes import router as chat_session_router
from routes.download import router as download_router
from routes.video import router as video_router
from routes.weather import router as weather_router
from routes.music import router as music_router
from routes.judge import router as judge_router
from routes.vscode import router as vscode_router
from routes.project_changes import router as project_changes_router
from routes.auth import SessionAccessMiddleware, router as auth_router
from routes.sync import router as sync_router


@asynccontextmanager
async def lifespan(app: FastAPI):
    """应用生命周期：启动时初始化数据库"""
    print("\n🚀 通用聊天 Agent 服务启动中...")
    print(f"   模型: {config.Ark.MODEL_ID}")
    print(f"   工具: {', '.join(tool.name for tool in TOOLS)}")

    # 初始化数据库
    try:
        await init_db()
        print("   数据库: 初始化完成")
    except Exception as e:
        print(f"   数据库: 初始化失败 - {e}")

    yield

    print("\n👋 服务已关闭")


app = FastAPI(
    title="通用聊天 Agent API",
    description="基于 LangChain + FastAPI 的 AI 聊天 Agent 服务",
    version="1.0.0",
    lifespan=lifespan,
)

# 会话归属校验：先于 CORS 注册，使其位于 CORS 内层，拒绝响应同样带 CORS 头
app.add_middleware(SessionAccessMiddleware)

# CORS 中间件
app.add_middleware(
    CORSMiddleware,
    allow_origins=[config.Server.CLIENT_ORIGIN, "*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# 健康检查
@app.get("/api/health")
async def health_check():
    from datetime import datetime
    return {"status": "ok", "timestamp": datetime.now().isoformat()}


# 路由注册
app.include_router(chat_router, prefix="/api")              # POST /api/chat (SSE流式聊天)
app.include_router(download_router, prefix="/api")          # GET /api/download/:filename
app.include_router(video_router, prefix="/api/video")       # GET /api/video/tasks, /task/:id, /proxy
app.include_router(chat_session_router, prefix="/api/chat") # 会话管理: /session/create, /sessions 等
app.include_router(weather_router, prefix="/api")            # GET /api/weather?lat=xx&lng=xx
app.include_router(music_router, prefix="/api")              # GET /api/music/random
app.include_router(judge_router, prefix="/api")              # POST /api/judge/execute
app.include_router(vscode_router)                              # WebSocket /ws/vscode
app.include_router(project_changes_router, prefix="/api/chat")
app.include_router(auth_router, prefix="/api/auth")                    # 账号: /register, /login, /logout, /me
app.include_router(sync_router, prefix="/api")                         # 多端同步: /sync/events, /chat/runs/{id}/cancel
