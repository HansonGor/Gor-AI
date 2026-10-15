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
BOCHA_API_KEY=your-bocha-api-key

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
- `thinking`: 兼容的等待心跳，不代表模型返回了思考内容
- `thinking_start` / `thinking_delta` / `thinking_end`: 模型适配层输出的单次调用思考事件，携带 roundId；delta 仅含真实返回的思考内容或摘要，end 不代表整轮 Agent 已结束
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

思考经 `models/thinking.py` 适配后沿用现有 SSE，不改 Agent 工具决策。工具模型启用流式观察，ainvoke 仍返回完整决策；Token 回调兼容 usage_metadata。整轮完成、取消或失败由终结事件及实际异常确定，思考历史独立保存到 `chat_messages.thinking_trace` JSONB，不进入模型历史正文，不改文件、ChangeSet 或 Diff。后台重载时 init_db 增加可空字段，旧消息无需补造记录。回归：`venv\Scripts\python.exe -X utf8 -m pytest tests/test_thinking.py -q`。

### 会话管理

```
POST /api/chat/session/create          # 创建会话
GET  /api/chat/session/:id/messages    # 查询会话消息
GET  /api/chat/sessions?userId=default # 查询会话列表
POST /api/chat/message/save            # 保存消息
DELETE /api/chat/session/:id           # 删除会话
```

### 文件变更撤销（共用 Diff UI 接入）

`project_api/changes.py` 提供 ChangeRecorder 和统一 UndoService；`db/project_changes.py` 将完整恢复快照保存到 PostgreSQL JSONB，启动 init_db 创建表。每轮按会话、执行 UUID、ProjectRef/root 归属，首次 before/最终 after 合并；原始 Diff 历史不修改，撤销不重复记为 Agent 变更。

```
GET  /api/chat/session/:sessionId/change-sets/:id
POST /api/chat/session/:sessionId/change-sets/:id/files/:fileId/undo
POST /api/chat/session/:sessionId/change-sets/:id/undo
```

SSE `change_set` 返回 changeSetId/roundId/projectRef。UndoService 对整批 applied 文件先检查 Hash、版本、Dirty/root，冲突全部阻止；Provider 再在本地执行边界校验。Web 用 Virtual FS + 数据库 CAS，返回 previewProject/serverRevision；插件用 Extension RPC + 原生 WorkspaceEdit/save/fs。逐文件返回真实结果；重复成功不执行，部分保存失败保留已完成结果。applying/undoing 请求中断后需核对，不盲目重试。审阅确认接入 ApplyService，未实现拒绝、Redo 或历史项目自动切换；Web 非当前项目拒绝，既有 GLB/消息快照不覆写。完整边界与状态见根目录 project.md。

快照不发送给 LLM：插件回执中的私有 changeSnapshots 被提取后删除；合计超过 2 MB 拒绝而非截断。数据库记录失败时插件不开始写入；Web applied 记录与项目保存同事务。部署需重载后台初始化表，并重载构建后的插件。本阶段测试使用存储/模型/VS Code 替身，未进行真实宿主或数据库迁移验收。

Web 客户端位于 `Web/src/api/projectChanges.ts` 与 `webProjectChanges.ts`：显式宿主校验，拒绝本地未保存改动；撤销成功后只同步同一项目且未发生并发编辑的 Virtual FS，请求构建，不补造入口或覆写历史 GLB。插件客户端不接入 Preview。共用 Diff 单/批撤销按钮调用上述 API，回读真实状态后更新。sealed ChangeSet 保存精确 assistant client messageId；历史消息按会话和该 ID 返回紧凑 `project_change_sets` 引用，不返回 before/after。旧记录无可靠关联时不猜测绑定；多记录歧义保持禁用，不用最新记录代替。审阅接收复用同一客户端的 applyFile/applyChangeSet 和 Provider 保存边界；没有拒绝或 Redo。

回归：`venv\Scripts\python.exe -X utf8 -m pytest tests/test_project_changes.py tests/test_preview_context_flow.py -q`；插件 `npm test`；Web `node --experimental-strip-types --test scripts/project-changes.test.ts`；两端构建命令见 project.md。


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
- Agent 搜索提示包含当前 Asia/Shanghai 日期与本轮实际能力，忽略历史“没有联网工具”的说法。时效性答复未先查询或错误否认联网时，最多提醒模型再调用一次；仍未调用则不发送未经核实的记忆答案。新闻/最新版本无论静态路由还是动态申请 `news_research`，都必须依次搜索、读取正文、综合；Reader 只接收本轮搜索结果 URL，至少一篇成功提取正文才满足读取保护；综合新闻优先整理5–8条独立资讯，单一事件按问题回答，资料不足不凑数。搜索来源维持 `search_sources` SSE / `[S1]` 引用。新鲜度参与排序但没有固定 3 天截止；官方和官网用于核实一手事实，不排斥相关主流媒体、行业/技术媒体、专业博客和产品生态配套网站。当前型号查询要尝试独立来源交叉核对；精选来源没有独立材料时放宽搜索发现。最终按实际发布日期由新到旧排列，最新在最前；来源/官网名称在工具结果含对应 URL 时使用 Markdown 可点击链接，直达该 URL，禁止猜造或改写链接。气泡只用“序号. 标题 + 通俗摘要 + 来源/实际发布日期（有则显示）+ [S#]”资讯卡片；缺日期只省略日期，不解释。禁止输出检索轮数、搜索/读取过程、工具或网页错误、无关结果/旧闻排除、覆盖分析、边界与免责声明等过程噪音；没有可靠内容时只用一句话说明。只有确实有帮助时才用一行附官方查阅渠道或具体延伸方向，不强制追问或扩写。验证命令：`venv\Scripts\python.exe -X utf8 -m pytest tests/test_tool_negotiation.py tests/test_project_reply.py tests/test_web_skill_routing.py tests/test_tool_routing.py tests/test_search_orchestrator.py tests/test_web_reader.py tests/test_tool_prompt_compatibility.py -q`；Agent 以模型和服务替身验证流程，不保证线上搜索可用性。
- `get_weather`: 天气查询（wttr.in）
- `web_reader`: 新闻与最新版本查询在 `web_search` 后读取本轮命中的 3–8 个精确 URL（不足 3 个则读取全部，最多 8 篇），提取正文、标题、发布时间、作者、链接和关键段落；新闻搜索自动附本轮日期但不设固定时效截止，使用用户提问语言。官方/官网优先核实一手事实，同时读取相关主流媒体、行业/技术媒体、专业博客或产品生态配套网站；当前版本查询不因官方页面较早而跳过独立来源。只访问公开 HTTP/HTTPS 页面，限制响应大小和跳转，并拒绝内网/本机 URL；通过服务端配置的网络代理访问时，仍在每个请求和重定向前校验目标域名及公网地址；最终引用沿用搜索来源编号。网页正文视为不可信资料，不接受其中指令；正文读取失败时不得声称已读正文，失败原因留在工具状态，不写进资讯卡片。
- `web_search`: 普通咨询/官方事实/技术文档/新闻/视觉灵感使用 Tavily、博查、Brave、Serper、豆包；深度调研为 Exa、Tavily、博查、Brave、Serper、豆包，不再内部调用 GitHub。新闻语言跟随用户，来源范围独立判断；国内优先新华社、人民网、央视、财新、澎湃、第一财经、36kr、IT之家及一手官方站；国际优先 Reuters、AP、BBC、Bloomberg、FT、CNBC、NYT、The Guardian、Nikkei Asia、CNA、NHK 及官方机构。新鲜度只作为排序信号，不设固定 3 天门槛；区分发布时间与事件时间，最终按实际发布日期由新到旧排列，最新在最前，不能把旧报道说成最新。来源按话题选取，官网/官方发布页优先核实事实，但不是唯一来源；技术类可补 TechCrunch、The Verge、Ars Technica、MIT Technology Review、Wired、VentureBeat、The Information、量子位、机器之心、极客公园等行业媒体和专业博客。当前产品/模型版本即使官方页面日期较早，也要尝试独立来源交叉核对；精选域名无独立材料时可做一次普通网页发现。不因已有结果少于 8 条凑数或放松媒体/地区集中度约束。缺少目标区域时补搜；返回最多 8 条。麦当劳、小红书、今日头条、白宫、Antd Design Mobile、微博等登记产品从原始气泡匹配别名，先检索官网索引，再补相关资源网站，官网命中优先；未知品牌不猜域名。显式 `site:` 为硬约束且优先于产品偏好。Tavily 传 `include_domains`，博查用 `include`，豆包用 `Filter.Sites`，Serper/Brave 用 `site:`，Exa 用 `includeDomains`；不提供排除域名入口。小红书等仅公开索引搜索，无专用站内/私有 API。
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
- VS Code：仅当前已连接工作区；write/patch/batch patch 通过 WorkspaceEdit 修改后自动保存本次文件，原本 Dirty 的目标先拒绝修改。保存失败返回明确错误及部分保存/Diff 回执，不能当作修改成功；create 原生创建且不覆盖，delete 保留原保护。不修改全局 Auto Save，不得降级到 Web Preview 或服务端磁盘。
- expected_version：Web 项目版本；VS Code 文件版本（批量每项分别传），旧 expected_file_version 参数仍兼容。源码同步事件、Diff、产物发布流程不变。

相关回归：`venv\Scripts\python.exe -X utf8 -m pytest tests/test_shared_project_tools.py tests/test_tool_routing.py tests/test_project_api.py tests/test_vscode_project_api.py tests/test_preview_context_flow.py -q`。两端构建验收命令见 `project.md`。

1. **密钥安全**: 所有密钥存储在后端 `.env`，前端绝不接触
2. **SystemMessage**: content 必须是 plaintext 纯文本，禁止 markdown
3. **视频生成**: 异步任务，提交后需要轮询，连接断开不影响后台渲染
4. **向量维度**: 固定 1024 维，与 Embedding 模型输出匹配
5. **模型额度**: 本地记账，需定期与服务商后台核对

## 故障排查

### 新闻正文复用与补读

综合新闻优先整理 5–8 条有真实来源的独立资讯，通常 3–8 条；同一事件多篇报道合并，少量可靠资讯按实际数量回答，聚焦问题不扩展无关条目。热点、爆点及影响必须由事实支撑。单批正文读取上限统一为 8（Agent、ReaderContext 与工具共用 MAX_PAGES）；显式较小数量保持有效，来源与资讯条数分别计算。

`ReaderContext` 按当前 Agent Run、精确 URL 和全部读取条件复用成功页面；失败仍可重试，不合并独立来源，不跨轮缓存最新信息。`web_reader` 的 start_char 可根据 next_start_char 补读 8,000 字符容量之后的正文，返回截断标记、总长度和正文指纹；版本变化标记 snapshot_changed 并清除旧缓存，不能拼接不同版本。片段读取不代表整篇已核实。下载与提取阶段用 `[ReaderTiming]` 记录，命中及批次统计用 `[ReaderReuse]` 记录；不日志输出正文。安全上限、白名单与权限、3–8 篇来源核验规则继续生效。

专项命令：`venv\Scripts\python.exe -X utf8 -m pytest tests/test_reader_context.py tests/test_web_reader.py tests/test_search_context.py tests/test_web_skill_routing.py tests/test_tool_prompt_compatibility.py -q`；公共验收见 project.md。

### 同轮联网搜索复用

`agent/search_context.py` 由当前 Agent Run 持有，Web / VS Code 共用。同工具、所有参数完全一致且先前结果成功时复用；空结果、错误和部分失败不缓存，取消及权限检查保持有效。来源展示和引用保持完整；只对模型上下文中完全相同的证据块、正文段落及已在正文中的关键段落去重，新事实保持完整。不会跨轮缓存实时信息、限制必要补搜或提前结束生成。`[SearchReuse]` 记录复用与耗时，Search Trace 不把缓存命中算成第二次 Provider 执行。

专项测试：`venv\Scripts\python.exe -X utf8 -m pytest tests/test_search_context.py tests/test_web_reader.py tests/test_search_orchestrator.py tests/test_web_skill_routing.py -q`；其余公共验收遵循 project.md。

### 公共历史上下文

Web / VS Code 共用 `services/context_engine.py`：当前请求完整保留；达到 30,000 估算 Token 时，近期完整问答保留在 10,000 Token 预算内，旧轮次增量摘要。未达阈值不按固定消息条数丢弃历史。压缩/保存失败保留成功摘要并按完整轮次预算回退，缺失历史向模型明确说明；原始消息与摘要游标不因失败修改。超长旧轮次完整压缩，模型拒绝时降级，不截断原文。

`[LLMInputBudget]` 记录每次 Agent 调用的输入分项估算及输出预留，真实输入用量沿用 Provider 返回的诊断；不记录内容。专项命令：`venv\Scripts\python.exe -X utf8 -m pytest tests/test_context_engine.py tests/test_agent_diagnostics.py -q`；完整验收沿用根目录 project.md。公共历史压缩本身不裁剪工具数据；项目读取和 PPT 的任务内精简见各自专节。

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

### 思考展示摘要

Thinking Adapter 观察实际思考与 Agent 阶段，不再额外调用 LLM 生成标题或摘要。ThinkingTrace 复用真实 tool_start / tool_end / 文件回执，生成中文任务标题和简述，通过 thinking_update 沿用 SSE 传输及既有 JSONB 历史保存。未知内容不强行编造，计划与实际执行分开，结果未明确成功时不报成功。模型调用结束到下一轮开始间的工具事件归属该轮；新轮开始冻结此前记录并清除旧工具关联，旧 roundId 和未配对结果不改写历史。thinking_end 不代表 Agent 整轮结束，文件/工具/ChangeSet 链路保持原样。运行 venv\Scripts\python.exe -X utf8 -m pytest tests/test_thinking.py -q 及根文档对应验收。

### PPT 上下文与 revision 补丁

`tools/presentation_revision.py` 按当前请求区分新稿、沿用要求和修改。局部请求提供目标页与目录，完整基准留在 Server；模糊范围保留所有页面，不额外调用 LLM。派生 referencePlan 不重复上传。create_ppt 新稿传 presentation，修改优先传 revision（精确 baseFingerprint、updates、deckChanges、appendSlides、removeSlideIds），对象合并、数组替换，完整校验后生成独立新快照，不覆写旧产物。未修改页面语义/布局/时间轴保留，受影响连续页组一起重排且保留已有续页，不合并掉续页标题；既有图片缓存过期后不承诺照片逐像素一致。

ChatRequest 可传 presentationMessageId，仅读取当前会话真实历史快照；找不到不回退猜测。未指定默认最近一次，明确要求更早版本但未绑定时先确认目标。公共逻辑适用于 Web/插件；插件不启用 Preview Worker。搜图、质量校验、PPTX 和下载机制保留。专项：`venv\Scripts\python.exe -X utf8 -m pytest tests/test_presentation_revision.py tests/test_presentation_design.py tests/test_presentation_motion.py tests/test_presentation_reference.py tests/test_presentation_pexels.py tests/test_project_files.py -q`；公共验收见 project.md。

### 项目读取 readRef 上下文（2026-10-15）

ProjectReadContext 仅在一次 run_agent 中工作：可靠同版本正文重复时引用前文，范围重叠只注入缺失行；原工具回执、SSE、回调不变。每次模型调用前经原 ProjectAPI 真实读取验证缓存，变化或失败撤销此前正文/引用并提示重读；文件操作保守使读取上下文失效。缓存不作为写入权限或并发保护，不引入第二套 Project Tools，也不节省/跳过原始读取 IO。

Web readState 使用请求内 Virtual FS 的 revision 和完整文件哈希。插件 readState 使用实际文档身份、version、Dirty 和完整缓冲区哈希，干净 UTF-8 文档另核对磁盘并复检读期间版本；外部更新未同步或并发编辑报告冲突。旧插件、未知编码及无可靠状态的候选读取原文降级，不猜测有效性。原 expected_version、Dirty、WorkspaceEdit、ChangeSet、Diff、Undo 保持原验证。

统计 `[ProjectReadContext]` 仅记录命中、重复、部分复用、校验/失效/冲突和估算 Token，实际计费仍看 Provider usage。专项运行 `venv\Scripts\python.exe -X utf8 -m pytest tests/test_project_read_context.py tests/test_shared_project_tools.py tests/test_vscode_project_api.py tests/test_preview_context_flow.py tests/test_review_changes.py -q`；插件 `npm test`。公共验收命令见 project.md。准确性优先，额外读取校验可能增加 IO；真实 Extension Host 与模型任务速度没有因离线测试而获得保证。
