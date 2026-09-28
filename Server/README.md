# 通用聊天 Agent - Python 后端

基于 FastAPI + LangChain + Python 3.10+ 的 AI 聊天 Agent 服务。

## 技术栈

- **Web 框架**: FastAPI + Uvicorn
- **AI 框架**: LangChain Python
- **大模型**: 火山方舟 OpenAI 兼容接口（DeepSeek-V4-Flash）
- **数据库**: Supabase PostgreSQL（asyncpg 异步驱动）
- **向量检索**: 阿里云百炼 Embedding + pgvector
- **工具**: 天气查询、联网搜索、文档生成、视频生成、知识库检索

## 项目结构

```
server_python/
├── main.py                 # 服务启动入口
├── app.py                  # FastAPI 应用实例
├── config.py               # 配置管理
├── requirements.txt        # Python 依赖
├── .env.example            # 环境变量示例
├── agent/
│   ├── __init__.py
│   ├── agent.py            # Agent 核心逻辑（工具调用循环 + 流式输出）
│   ├── prompts.py          # 系统提示词（plaintext）
│   └── token_callback.py   # Token 统计回调
├── models/
│   ├── __init__.py
│   ├── model.py            # 大模型初始化
│   ├── vision.py           # 图片解析服务
│   └── embedding_store.py  # RAG 向量存储（预留）
├── db/
│   ├── __init__.py
│   ├── supabase_chat.py    # 会话存储数据库操作
│   └── model_quota.py      # 模型额度管理
├── tools/
│   ├── __init__.py
│   ├── index.py            # 工具汇总导出
│   ├── weather.py          # 天气查询工具
│   ├── web_search.py       # 联网搜索工具
│   ├── document.py         # 文档生成工具（Word/Excel/PPT/PDF）
│   ├── presentation.py     # Design Schema 校验、图片解析、PPTX 与预览快照生成
│   ├── presentation_design.py # 页面结构、主题与内容布局规则
│   ├── presentation_renderer.py # 可编辑 PPTX 页面渲染
│   ├── pexels.py           # Pexels 搜图、下载与署名信息
│   ├── video.py            # 小云雀视频生成工具
│   └── vector_search.py    # RAG 向量检索工具
├── routes/
│   ├── __init__.py
│   ├── chat.py             # SSE 流式聊天路由
│   ├── chat_routes.py      # 会话管理路由
│   ├── video.py            # 视频任务查询+代理路由
│   └── download.py         # 文件下载路由
├── services/               # 服务层（预留扩展）
│   └── __init__.py
├── data/
│   └── video_tasks.json    # 视频任务持久化
└── generated/              # 生成的文档文件
```

## 快速开始

### 1. 安装依赖

```bash
cd server_python
pip install -r requirements.txt
```

### 2. 配置环境变量

复制 `.env.example` 为 `.env`，填入你的密钥：

```bash
cp .env.example .env
```

编辑 `.env` 文件，填入以下配置：

```env
# 火山引擎方舟
ARK_API_URL=https://ark.cn-beijing.volces.com/api/v3
ARK_API_KEY=your-ark-api-key
ARK_MODEL_ID=ep-20260902232204-6rhbl
ARK_VISION_MODEL_ID=ep-20260829115423-lphgj

# Tavily 搜索
TAVILY_API_KEY=your-tavily-api-key

# 可选：尽量为 PPT 每一页搜索并嵌入与内容相关的实景背景图
PEXELS_API_KEY=your-pexels-api-key

# 小云雀视频生成
XIAOYUNQUE_AK=your-xiaoyunque-ak
XIAOYUNQUE_SK=your-xiaoyunque-sk

# 阿里云百炼 Embedding
DASHSCOPE_API_KEY=your-dashscope-api-key
EMBEDDING_BASE_URL=https://ws-j6rynkso15yxx2da.cn-beijing.maas.aliyuncs.com/compatible-mode/v1
EMBEDDING_MODEL=qwen3.7-text-embedding

# Supabase 数据库
SUPABASE_DB_URL=postgresql://postgres:password@db.example.supabase.co:5432/postgres

# 服务配置
PORT=3001
CLIENT_ORIGIN=http://localhost:5173
```

### 3. 启动服务

```bash
python main.py
```

服务将在 `http://localhost:3001` 启动。

设计型 PPT 会尽量为每页从 Pexels 获取与内容相关的背景照片，并在幻灯片中署名链接摄影师、照片页和 Pexels。若未配置 `PEXELS_API_KEY`、图片服务不可用或某页没有匹配照片，对应页面使用主题默认背景，PPT 仍会生成。照片会按比例裁切铺满页面，并叠加主题色遮罩来保证文字可读；模型应为每页提供具体、与页面主题匹配的英文 `imageQuery`。

生成的 PPT 页面图片也会随该条助手消息的 Preview 快照提供给 Preview Worker。预览按主题色叠加半透明遮罩并使用 `cover` 裁切背景，在可用画布内等比缩放幻灯片，不拉伸比例。修改背景透明度时必须写入 PPTX DrawingML alpha 通道；仅设置 `python-pptx` 的 `FillFormat.transparency` 不会可靠地序列化到文件，可能导致主题色完全盖住照片。无 API Key、请求失败或无匹配照片时，PPT 和预览都应回退到主题渐变底色，不能因此中断生成。

### 4. 健康检查

```bash
curl http://localhost:3001/api/health
```

## API 接口

### SSE 流式聊天

```
POST /api/chat
Content-Type: application/json

{
  "sessionId": "uuid-session-id",
  "message": "你好"
}
```

**SSE 事件类型**:
- `thinking`: 模型思考中
- `tool_start`: 工具开始调用
- `tool_end`: 工具调用完成
- `token`: 文本片段（打字机效果）
- `file_ready`: 文件生成完成
- `video_ready`: 视频生成完成
- `token_usage`: 本轮 token 消耗
- `context_remain`: 上下文剩余
- `model_quota_info`: 模型额度信息
- `error`: 错误
- `done`: 结束

### 会话管理

```
POST /api/chat/session/create          # 创建会话
GET  /api/chat/session/:id/messages    # 查询会话消息
GET  /api/chat/sessions?userId=default # 查询会话列表
POST /api/chat/message/save            # 保存消息
DELETE /api/chat/session/:id           # 删除会话
```

### 视频

```
GET /api/video/tasks          # 所有视频任务
GET /api/video/task/:taskId   # 单个视频任务
GET /api/video/proxy?url=xxx  # 视频代理
```

### 文件下载

```
GET /api/download/:filename
```

## 功能特性

### 1. SSE 流式对话
- 打字机效果（每 5 字符一段，间隔 20ms）
- 心跳机制防止连接断开
- 连接断开检测

### 2. Agent 工具调用
- `get_weather`: 天气查询（wttr.in）
- `web_search`: 联网搜索（Tavily）
- `create_word`: 生成 Word 文档
- `create_excel`: 生成 Excel 表格
- `create_ppt`: 生成 PPT 演示文稿
- `create_pdf`: 生成 PDF 文档
- `generate_xiaoyunque_video`: 小云雀 AI 视频生成
- `vector_search`: RAG 知识库向量检索

### 3. 图片解析
- 支持 doubao-seed-2.0-lite 视觉模型
- 自动解析用户上传的图片

### 4. 会话持久化
- Supabase PostgreSQL 存储
- 多会话管理
- 自动生成会话标题

### 5. Token 统计
- LangChain CallbackHandler 捕获原生 usage
- 多轮工具调用自动累加
- 前端气泡展示消耗

### 6. 模型额度管理
- 独立模型额度记账
- 自动扣减 total_tokens
- 额度告警阈值

### 7. RAG 知识库
- 阿里云百炼 Embedding（1024 维）
- Supabase pgvector 相似度检索
- 阈值过滤（0.75）

## 与 Node.js 版本的差异

| 特性 | Node.js | Python |
|------|---------|--------|
| Web 框架 | Express | FastAPI |
| 异步处理 | async/await | asyncio |
| 数据库驱动 | pg | asyncpg |
| SSE 实现 | 原生 res.write | StreamingResponse + Queue |
| 工具调用 | LangChain JS | LangChain Python |

## 注意事项

1. **密钥安全**: 所有密钥存储在后端 `.env`，前端绝不接触
2. **SystemMessage**: content 必须是 plaintext 纯文本，禁止 markdown
3. **视频生成**: 异步任务，提交后需要轮询，连接断开不影响后台渲染
4. **向量维度**: 固定 1024 维，与 Embedding 模型输出匹配
5. **模型额度**: 本地记账，需定期与服务商后台核对

## 故障排查

### 数据库连接失败
- 检查 `SUPABASE_DB_URL` 是否正确
- 确认 Supabase 项目已启动
- 检查网络连接

### 大模型调用失败
- 检查 `ARK_API_KEY` 是否正确
- 确认模型接入点 ID 有效
- 检查账户余额

### SSE 连接断开
- 检查前端是否正确处理 SSE 事件
- 确认心跳间隔（15s）小于代理超时
- 检查 Nginx/反向代理配置

## 许可证

MIT
