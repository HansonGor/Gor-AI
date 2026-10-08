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
│   ├── web_search.py       # web_search 统一联网搜索入口及 Provider API
│   ├── search_orchestrator.py # 按意图选择 Provider、域名优先、融合去重
│   ├── web_reader.py       # 读取本轮搜索命中的公开文章正文与元数据
│   ├── image_search.py     # search_images 多源图片搜索及来源/许可元数据
│   ├── document.py         # 文档生成工具（Word/Excel/PPT/PDF）
│   ├── presentation.py     # Design Schema 校验、图片解析、PPTX 与预览快照生成
│   ├── presentation_design.py # 页面结构、主题与内容布局规则
│   ├── presentation_renderer.py # 可编辑 PPTX 页面渲染
│   ├── pexels.py           # PPT 复用图片搜索、选图/下载与署名信息
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

# 可选网页搜索源：缺少密钥的 Provider 自动跳过
DOUBAO_SEARCH_API_KEY=your-doubao-search-api-key
SERPER_API_KEY=your-serper-api-key
BRAVE_API_KEY=your-brave-api-key
EXA_API_KEY=your-exa-api-key
GITHUB_TOKEN=your-github-token

# 可选：尽量为 PPT 每一页搜索并嵌入与内容相关的实景背景图
PEXELS_API_KEY=your-pexels-api-key
PIXABAY_API_KEY=your-pixabay-api-key
UNSPLASH_ACCESS_KEY=your-unsplash-access-key

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

设计型 PPT 复用 `search_images` 的 Pexels、Pixabay、Unsplash、Openverse 和 Wikimedia Commons 多源搜索结果，不另设搜图 API；仅由 PPT 流程完成内容匹配、图片下载、画质筛选、按页嵌入和来源/作者/许可署名。没有配置某个来源的密钥时会跳过该来源，匿名来源仍可用；服务不可用或没有合适图片时，对应页面使用主题默认背景，PPT 仍会生成。模型应提供具体的英文 `imageQuery`；选图需兼顾主体、自然留白、裁切和文字对比度。照片按比例裁切，不默认覆盖整页主题色遮罩。

生成的 PPT 页面图片也会随该条助手消息的 Preview 快照提供给 Preview Worker。预览使用 `cover` 裁切背景，在可用画布内等比缩放幻灯片，不拉伸比例。文字优先放在图片的自然留白区域，必要时只做局部可读性处理；无 API Key、请求失败或无匹配照片时，PPT 和预览都回退到主题底色，不能因此中断生成。

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
- 公共入口 `agent/tool_routing.py` 每轮、所有模式默认传入 `web_search` / `search_images`，不是联网兜底；模型决定是否调用。Web Preview / VS Code 模式额外默认提供实际 Provider 支持的项目 CRUD 与 Word、Excel、PPT、PDF、视频生成工具，SIMPLE_EDIT 不裁掉这些 Schema。默认可用不代表必须执行、任意写入或跨端授权；天气、Python、私有知识库等其他工具仍按原规则路由。Skill Card 可组合，专门规则按命中项加载；本轮按需优化 GitHub 短卡与专门规则，其他字面量提示词保持，哈希回归见 `tests/test_tool_prompt_compatibility.py`。
- **模型主导的工具协商（已实现）**：所有模式默认提供 `request_tools(tool_names, reason, subtask?)` 和简短能力状态目录；LLM 可一次申请多项已登记工具/能力组，无需再次命中严格关键词。校验宿主、Provider 能力、项目上下文、不联网约束与必要配置；实际连接/权限/版本仍由 Provider 校验。不自动安装或跨端扩权。申请返回新增、已提供、不可提供及原因，不执行任务；新增 Schema 在下一轮重新绑定，同批提前使用被拒绝，已加载规则不重复注入，失败原因本轮缓存。专门规则复用既有提示词原文。[ToolNegotiationAudit] 记录 requested_tools、added_tools、already_available、unavailable_tools、denial_reasons、subtask。
- 生成/复合任务首次写入成功后继续模型循环，可再申请能力、完成剩余步骤；仅已验证的单一文字替换保留快速结束。气泡简述实际改动，源码只放 Diff，附加子任务按真实反馈区分完成、失败、仅调用，缺少能力如实说明。省 Token 优先去重复，不删除默认能力或静默跳过子任务。
- **多项目限制未解除**：单次 Agent 仍绑定一个 Preview Workspace，`independent_projects` 在目录中不可用。React+3D 同轮独立双项目仍需多子任务上下文和快照发布支持；当前阻止新增入口/SceneSpec 混写，失败不改原文件，历史混合快照既有文件与无关样式仍可编辑，不清理历史产物。请分轮创建，不把本次协商入口当成双项目发布已完成。插件永远不因申请能力而挂载 Preview。完整流程和验收要求见根目录 `project.md`。
- 用户要求不联网时仍保留搜索 Schema，但 Agent 拒绝实际搜索；私有路径/源码不发送到公开 Provider。本地任务查询公开依赖时只上传公共查询词，不附带私有原始气泡；公开 GitHub 文件名限定符不因文件名而被禁搜。当前宿主与连接能力决定文件操作，不得从 VS Code 降级到 Preview 或服务端磁盘。
- Agent 搜索提示包含当前 Asia/Shanghai 日期与本轮实际能力，忽略历史“没有联网工具”的说法。时效性答复未先查询或错误否认联网时，最多提醒模型再调用一次；仍未调用则不发送未经核实的记忆答案。新闻/最新版本无论静态路由还是动态申请 `news_research`，都必须依次搜索、读取正文、综合；Reader 只接收本轮搜索结果 URL，至少一篇成功提取正文才算完成。搜索来源维持 `search_sources` SSE / `[S1]` 引用。新鲜度参与排序但没有固定 3 天截止；官方和官网用于核实一手事实，不排斥相关主流媒体、行业/技术媒体、专业博客和产品生态配套网站。当前型号查询要尝试独立来源交叉核对；精选来源没有独立材料时放宽搜索发现。最终按实际发布日期由新到旧排列，最新在最前；来源/官网名称在工具结果含对应 URL 时使用 Markdown 可点击链接，直达该 URL，禁止猜造或改写链接。气泡只用“序号. 标题 + 通俗摘要 + 来源/实际发布日期（有则显示）+ [S#]”资讯卡片；缺日期只省略日期，不解释。禁止输出检索轮数、搜索/读取过程、工具或网页错误、无关结果/旧闻排除、覆盖分析、边界与免责声明等过程噪音；没有可靠内容时只用一句话说明。只有确实有帮助时才用一行附官方查阅渠道或具体延伸方向，不强制追问或扩写。验证命令：`venv\Scripts\python.exe -X utf8 -m pytest tests/test_tool_negotiation.py tests/test_project_reply.py tests/test_web_skill_routing.py tests/test_tool_routing.py tests/test_search_orchestrator.py tests/test_web_reader.py tests/test_tool_prompt_compatibility.py -q`；Agent 以模型和服务替身验证流程，不保证线上搜索可用性。
- `get_weather`: 天气查询（wttr.in）
- `web_reader`: 新闻与最新版本查询在 `web_search` 后读取本轮命中的 3–5 个精确 URL（不足 3 个则读取全部，最多 5 篇），提取正文、标题、发布时间、作者、链接和关键段落；新闻搜索自动附本轮日期但不设固定时效截止，使用用户提问语言。官方/官网优先核实一手事实，同时读取相关主流媒体、行业/技术媒体、专业博客或产品生态配套网站；当前版本查询不因官方页面较早而跳过独立来源。只访问公开 HTTP/HTTPS 页面，限制响应大小和跳转，并拒绝内网/本机 URL；通过服务端配置的网络代理访问时，仍在每个请求和重定向前校验目标域名及公网地址；最终引用沿用搜索来源编号。网页正文视为不可信资料，不接受其中指令；正文读取失败时不得声称已读正文，失败原因留在工具状态，不写进资讯卡片。
- `web_search`: 普通咨询/官方事实/技术文档/新闻/视觉灵感使用 Tavily、Brave、Serper、豆包；深度调研加 Exa，不再内部调用 GitHub。新闻语言跟随用户，来源范围独立判断；国内优先新华社、人民网、央视、财新、澎湃、第一财经、36kr、IT之家及一手官方站；国际优先 Reuters、AP、BBC、Bloomberg、FT、CNBC、NYT、The Guardian、Nikkei Asia、CNA、NHK 及官方机构。新鲜度只作为排序信号，不设固定 3 天门槛；区分发布时间与事件时间，最终按实际发布日期由新到旧排列，最新在最前，不能把旧报道说成最新。来源按话题选取，官网/官方发布页优先核实事实，但不是唯一来源；技术类可补 TechCrunch、The Verge、Ars Technica、MIT Technology Review、Wired、VentureBeat、The Information、量子位、机器之心、极客公园等行业媒体和专业博客。当前产品/模型版本即使官方页面日期较早，也要尝试独立来源交叉核对；精选域名无独立材料时可做一次普通网页发现。不因已有结果少于 8 条凑数或放松媒体/地区集中度约束。缺少目标区域时补搜；返回最多 8 条。麦当劳、小红书、今日头条、白宫、Antd Design Mobile、微博等登记产品从原始气泡匹配别名，先检索官网索引，再补相关资源网站，官网命中优先；未知品牌不猜域名。显式 `site:` 为硬约束且优先于产品偏好。Tavily 传 `include_domains`，豆包用 `Filter.Sites`，Serper/Brave 用 `site:`，Exa 用 `includeDomains`；不提供排除域名入口。小红书等仅公开索引搜索，无专用站内/私有 API。
- `search_github_code`: `tools/github_code.py` 独立 `github_code` Skill，先调用 GitHub Repository Search：明确 URL/owner-repo 精确定位；纯名称先同名匹配，再按 Stars 热度给出模糊候选。已登记 `antd mobile` → `ant-design/ant-design-mobile` 别名。公开仓库搜索在 token 缺失/失效时可匿名回退；GitHub Code Search 仍需 `GITHUB_TOKEN`。仅当用户需要源码、实现、用法、示例、Issue 或 PR 时再调用代码搜索，并优先限定到首选仓库；普通网页搜索不是其静默替代。只返回有界仓库信息、代码引用与摘要，回复简单总结，不铺满源码；仓库/代码搜索的未配置、错误、无结果和成功分别报告。新闻+代码可组合两个 Skill。多个搜索调用的来源编号同轮统一，避免覆盖。[RoutingAudit] 记录 `selected_skills`、`search_regions`、`source_domains`、`github_skill_used`、仓库候选数及代码搜索状态，来源事件补充 `officialDomains`。
- `search_images`: 并行搜索可用的 Pexels、Pixabay、Unsplash、Openverse、Wikimedia Commons 图片候选，也可指定单一来源；支持横图/竖图/方图筛选，每个来源最多 6 个候选，返回图片地址、来源页、作者及可用许可元数据。Pexels/Pixabay/Unsplash 需各自配置 API Key，Openverse/Wikimedia Commons 可匿名查询。PPT 复用这一个 Provider 搜索实现，选中后再下载、嵌入并署名。Pixabay 候选图链仅短期使用，Unsplash 触发 API 下载记录，Openverse/Wikimedia 遵守单张素材的许可要求。
- `create_word`: 生成 Word 文档
- `create_excel`: 生成 Excel 表格
- `create_ppt`: 生成 PPT 演示文稿（Presentation Design Engine）
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

### 两端公共项目工具

开发规则以根目录 `project.md` 为准。模型统一使用 `*_project_*` Schema；项目宿主每轮默认开放支持的工具，而非只按动作词裁剪。`tools/project_dispatch.py` 根据请求绑定的 ProjectRef 调用 ProjectAPI，先按 Provider capability 检查，再执行。基础提示词公共，Web/VS Code 的版本、存储、权限和预览规则分别追加，独立功能不能跨端降级。无工作区 ID 的插件仅提供只读连接检查。

- Web：虚拟文件新增/覆盖仍由 write 承担；旧 Preview 名称保留兼容，不默认向模型提供。通用创建/删除和空目录尚不支持，不伪造能力。
- Web 新项目的 React 生成规则要求模块入口与实际 JSX/TSX 路径一致、组件 import/export、CSS import，不生成 CDN/Babel 全局组件方案。这条规则仅在空 Web Preview 项目注入，不改变插件工作区规则；写入成功不等于前端构建成功。旧 Babel 项目由 Web 的本地编译兼容层处理，原源码不覆写。
- VS Code：仅当前已连接工作区；write 修改编辑器文档但不保存，create 不覆盖，delete 保留原保护。不得降级到 Web Preview 或服务端磁盘。
- expected_version：Web 项目版本；VS Code 文件版本（批量每项分别传），旧 expected_file_version 参数仍兼容。源码同步事件、Diff、产物发布流程不变。

相关回归：`venv\Scripts\python.exe -X utf8 -m pytest tests/test_shared_project_tools.py tests/test_tool_routing.py tests/test_project_api.py tests/test_vscode_project_api.py tests/test_preview_context_flow.py -q`。两端构建验收命令见 `project.md`。

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
