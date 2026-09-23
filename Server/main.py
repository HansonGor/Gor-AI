"""
服务启动入口
运行方式：python main.py
"""
import uvicorn

from config import config

if __name__ == "__main__":
    print(f"\n🚀 通用聊天 Agent 服务已启动")
    print(f"   地址: http://localhost:{config.Server.PORT}")
    print(f"   健康检查: http://localhost:{config.Server.PORT}/api/health")
    print(f"   模型: {config.Ark.MODEL_ID}\n")

    uvicorn.run(
        "app:app",
        host="0.0.0.0",
        port=config.Server.PORT,
        reload=True,
        log_level="info",
    )
