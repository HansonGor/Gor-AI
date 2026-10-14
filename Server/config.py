"""
config.py - 全局配置管理模块

本模块集中管理所有环境变量配置，通过嵌套类对配置项进行分组。
所有敏感信息和环境相关的配置均通过 .env 文件加载，避免硬编码。
"""

import os
from pathlib import Path
from dotenv import load_dotenv

# 加载 .env 文件中的环境变量（必须在读取任何配置之前调用）
load_dotenv()


class Config:
    """全局配置类，包含所有子配置项的分组。"""

    # ================================================================
    # 火山引擎方舟（Volcengine Ark）- 大模型 API 配置
    # ================================================================
    class Ark:
        """火山引擎方舟大模型服务的相关配置。"""
        # API 请求的基础地址
        API_URL = os.getenv("ARK_API_URL", "https://ark.cn-beijing.volces.com/api/v3")
        # API 认证密钥（必须通过环境变量或 .env 文件设置）
        API_KEY = os.getenv("ARK_API_KEY", "")
        # 默认使用的模型 ID
        MODEL_ID = os.getenv("ARK_MODEL_ID", "deepseek-v4-pro")
        # Source-generating tool calls need more room than short chat answers.
        MAX_OUTPUT_TOKENS = max(1024, min(32768, int(os.getenv("ARK_MAX_OUTPUT_TOKENS", "16384"))))
        # 视觉/多模态模型 ID（用于图像理解等任务）
        VISION_MODEL_ID = os.getenv("ARK_VISION_MODEL_ID", "doubao-seed-2.0-1ite")

    # ================================================================
    # 多搜索引擎 API 配置
    # ================================================================
    class Search:
        """多搜索引擎 API 的配置（用于联网搜索能力，缺哪个 key 哪个源就自动跳过）。"""
        # 豆包搜索（火山引擎 feedcoopapi，国内中文首选）
        DOUBAO_SEARCH_API_KEY = os.getenv("DOUBAO_SEARCH_API_KEY", "")
        # Tavily（通用网页搜索，已有）
        TAVILY_API_KEY = os.getenv("TAVILY_API_KEY", "")
        # 博查 Web Search（https://open.bochaai.com）
        BOCHA_API_KEY = os.getenv("BOCHA_API_KEY", "")
        # Serper（Google 搜索代理，适合海外/中英文混合）
        SERPER_API_KEY = os.getenv("SERPER_API_KEY", "")
        # Brave Search（独立索引，无广告）
        BRAVE_API_KEY = os.getenv("BRAVE_API_KEY", "")
        # Exa（语义向量搜索，深度技术调研）
        EXA_API_KEY = os.getenv("EXA_API_KEY", "")
        # GitHub Token（用于 GitHub 代码搜索，需要 public_repo 权限）
        GITHUB_TOKEN = os.getenv("GITHUB_TOKEN", "")

    # ================================================================
    # 小云雀视频生成 API 配置
    # ================================================================
    class Xiaoyunque:
        """小云雀（Xiaoyunque）视频生成服务的配置。"""
        # 访问密钥 ID
        ACCESS_KEY_ID = os.getenv("XIAOYUNQUE_AK", "")
        # 秘密访问密钥
        SECRET_ACCESS_KEY = os.getenv("XIAOYUNQUE_SK", "")

    # ================================================================
    # 阿里云百炼（DashScope）Embedding 配置
    # ================================================================
    class Embedding:
        """阿里云百炼平台的文本嵌入（Embedding）模型配置。"""
        # DashScope API 密钥
        API_KEY = os.getenv("DASHSCOPE_API_KEY", "")
        # Embedding 服务的基础 URL（留空则使用 DashScope 默认地址）
        BASE_URL = os.getenv("EMBEDDING_BASE_URL", "")
        # 使用的 Embedding 模型名称
        MODEL = os.getenv("EMBEDDING_MODEL", "qwen3.7-text-embedding")

    # ================================================================
    # Supabase 数据库配置
    # ================================================================
    class Database:
        """Supabase 数据库连接配置。"""
        # 数据库连接 URL（PostgreSQL 格式）
        URL = os.getenv("SUPABASE_DB_URL", "")

    # ================================================================
    # 高德地图 API 配置（逆地理编码 + 天气查询）
    # ================================================================
    class Amap:
        """高德地图 Web 服务 API 配置。"""
        # Web 服务 Key（用于后端调用逆地理编码、天气等 REST 接口）
        WEB_SERVICE_KEY = os.getenv("AMAP_WEB_SERVICE_KEY", "")

    class Pexels:
        """Pexels photo search used for optional presentation imagery."""
        API_KEY = os.getenv("PEXELS_API_KEY", "")

    class ImageSearch:
        """Credentials for optional image-search providers."""
        PIXABAY_API_KEY = os.getenv("PIXABAY_API_KEY", "")
        UNSPLASH_ACCESS_KEY = os.getenv("UNSPLASH_ACCESS_KEY", "")

    # ================================================================
    # ================================================================
    # Jamendo 音乐 API 配置（随机流行歌曲播放）
    # ================================================================
    class Jamendo:
        """Jamendo 音乐平台 API 配置。"""
        # 应用 client_id（拉取流行歌曲列表用）
        CLIENT_ID = os.getenv("JAMENDO_CLIENT_ID", "5ed00d97")
    # 服务运行配置
    # ================================================================
    class Server:
        """Web 服务运行时的相关配置。"""
        # 服务监听端口（默认 3001）
        PORT = int(os.getenv("PORT", "3001"))
        # 允许跨域访问的前端地址（CORS 白名单）
        CLIENT_ORIGIN = os.getenv("CLIENT_ORIGIN", "http://localhost:5173")

    # ================================================================
    # 代码沙箱配置
    # ================================================================
    class CodeSandbox:
        """Judge0 隔离代码执行服务。"""
        JUDGE0_URL = os.getenv("JUDGE0_URL", "http://localhost:2358")

    class ProjectWorkspace:
        """The Web source workspace exposed to the AI file tools."""
        ROOT = os.getenv("PROJECT_WORKSPACE_ROOT", str(Path(__file__).resolve().parent.parent / "Web"))

    class Storage:
        """Durable server-side storage for user uploads and generated files."""
        ROOT = os.getenv("GOR_STORAGE_DIR", str(Path(__file__).resolve().parent / "storage"))
        UPLOADS = os.path.join(ROOT, "uploads")
        GENERATED = os.path.join(ROOT, "generated")

    # ================================================================
    # Agent 运行参数配置
    # ================================================================
    class Agent:
        """AI Agent 运行时的行为参数配置。"""
        # Agent 最大迭代次数（防止无限循环）
        MAX_ITERATIONS = int(os.getenv("AGENT_MAX_ITERATIONS", "5"))
        # 流式输出时每次推送的字符块大小
        TYPING_CHUNK_SIZE = int(os.getenv("AGENT_TYPING_CHUNK_SIZE", "5"))
        # 流式输出时每个字符块之间的推送延迟（毫秒）
        TYPING_DELAY_MS = int(os.getenv("AGENT_TYPING_DELAY_MS", "20"))

    # ================================================================
    # 模型上下文窗口配置
    # ================================================================
    class Context:
        """大语言模型上下文窗口的限制配置。"""
        # 上下文窗口最大 Token 数（根据模型实际限制设置）
        MAX_CONTEXT = 479284
        # 当剩余上下文不足此阈值时触发告警
        WARNING_THRESHOLD = 10000

    # ================================================================
    # 额度告警阈值
    # ================================================================
    # 当 API 调用额度/计费剩余低于此值时触发告警
    QUOTA_WARNING_THRESHOLD = 20000


# 全局单例配置实例（其他模块通过 from config import config 使用）
config = Config()
