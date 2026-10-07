# Gor AI Agent 项目说明

## 0. 开发约束与两端边界（2026-10-07）

修改前先完整阅读本文及涉及模块的 README。根目录 `AGENTS.md` 是开发入口，以下约定必须落实到代码、测试和交付说明；现有代码不是违反约定的理由。

### 先确定端，再选择适配器

| 范围 | 操作对象 | 项目结果入口 | 禁止行为 |
| --- | --- | --- | --- |
| Web（含浏览器窄屏） | 会话所属的虚拟项目文件集 | Preview Worker 的 Preview / Code / Diff | 操作 VS Code 文件、用后端当前目录冒充项目、自动导出落盘 |
| VS Code 插件 | 当前连接的 VS Code 工作区 | 实际工作区文件与共用 Diff | 初始化 Web 项目、调用 Preview 工具、自动开启 Preview Worker |
| 公共能力 | 会话、消息、自然语言变更说明、UI 原语与 Diff | 两端通过 props / callbacks 按需接入 | 将某一端文件权限、项目状态或副作用写进纯 UI |

- 请求明确某端时，只改该端能力；共享代码修改须检查两端调用者。可根据上下文判断范围；如果范围不明且会改变端特有行为，先提示用户确认。
- 请求使用明确的 `clientMode: web / vscode`。Web 不发送遗留 workspaceId；插件等待真实工作区握手，未连接应报告原因，不退回 Web 项目或后端磁盘。
- 创建请求建立新的 projectId 和独立文件集；编辑请求沿用目标项目，不能只切换 HTML/3D 标记，也不能把上一个项目的文件带入新项目。根据当前请求及必要对话上下文选择工具/skill，不能因过度节省 Token 让已授予的读写能力消失，也不能见到任何动词就无视否定、解释请求而执行写入。
- 插件优先当前工作区；目录树未知时读取，已知且版本未冲突不重复读取，实际目录变化/冲突时刷新。路径解析与权限校验由扩展负责，不能由服务端 `D:\Gor` 或展示名称猜测。超出当前工作区的读取/写入需遵循扩展实际授权，不把向上查找理解成任意磁盘访问权限。

### 虚拟导出与空间占用

“虚拟文件”表示不自动在用户工程或开发机生成文件，不表示没有内存、数据库或缓存占用。

| 数据 / 行为 | 当前存储方式 | 是否自动生成本地文件 |
| --- | --- | --- |
| Web React/HTML/3D 源码、编译输出、GLB 导出计算 | Virtual FS、Worker、内存 Blob / ArrayBuffer | 否 |
| Web 可恢复源码快照 | PostgreSQL JSONB 和消息快照 | 否；占数据库容量 |
| 新 Web GLB 虚拟产物 | PostgreSQL `session_generated_artifacts.artifact_bytes`（BYTEA），relative_path 为空 | 否；占数据库容量，若数据库部署本机仍有数据库磁盘占用 |
| 浏览器会话缓存及 UI 偏好 | IndexedDB / localStorage | 浏览器可能写自己的缓存空间，不是用户工程文件 |
| 用户主动点击下载/另存为 | 系统保存或浏览器下载 | 是，属于用户明确操作，不是自动导出 |
| 原始上传附件、现有 Office/PDF 等工具输出、历史磁盘 GLB | 既有 `GOR_STORAGE_DIR` 流程 | 可能占服务器磁盘，本地启动服务时即本机磁盘；本次未统一改造这些独立管线 |

- 默认 Web GLB 导出使用原始二进制 PUT 请求，避免 multipart 临时文件落盘；服务端在内存校验格式和 32 MB 上限，再与消息引用在同一数据库事务保存。预览响应 `Cache-Control: no-store`，不调用文件保存器。旧 multipart 接口仅兼容旧客户端，框架仍可能使用临时上传缓冲；它不再新建持久生成文件。
- 保留已有磁盘产物的只读访问，不自动删除或迁移历史数据。新产物不写 `Server/storage/generated`。原有上传和 Office 管线不能被误称为完全虚拟。

### 组件复用及必须保留的行为

- 稳定 UI 接口在 `Web/src/components/chat`：页面壳、输入框、消息、`ProjectChanges` 等按需引入。Diff 是纯展示组件，两端复用；自然语言完成说明由 `Server/agent/project_reply.py` 共用。Web 虚拟产物 API 独立在 `Web/src/api/webProjectArtifacts.ts` 并拒绝插件调用；真实文件 IO 留在 VS Code Provider/扩展桥接。
- 不强行把所有页面一次性重构。优先提取重复且边界明确的组件，保留现有样式；端特有行为通过能力或回调接入，禁止组件渲染时隐式读写文件或启动另一端 Worker。
- 新建 Web 项目在离屏状态生成。完整源码同步、生成任务完成且所需产物保存成功后，才发布并展开/切换 Preview Worker；部分文件、失败、取消不能抢先切换。发布后真实构建失败仍显示诊断，不能把错误永久隐藏。
- Preview 列表按首次创建顺序旧到新，新项目在最下面；编辑不改变创建位置。项目/产物按稳定 ID 去重；名称相同也可能是不同项目。
- Preview、Code、源码包、产物下载必须属于同一选中项目/消息快照；不能使用此前选中 GLB 或全局最新文件集冒充目标源码。3D 使用真实 GLB，React 使用网页产物，不互换类型；GLB 名称最多一个 `.glb` 后缀。
- 不恢复默认 React 模板，不发送不存在的默认项目快照。普通聊天不显示空 Worker；插件不挂载 Worker。旧消息可重新打开自己的产物，Worker 清除是软隐藏，不是物理删除。
- 聊天气泡简述实际完成了什么、内容主题及查看入口；源码、逐行修改只放 Diff，不在回答中重复代码。未成功写入、保存或构建不得宣称完成。

### 修改前后验收

1. 写清本次端范围、关联模块、沿用规则和预期副作用；先找现有实现，不复制一套逻辑。
2. 针对改动补测试：Web / 插件隔离、自动导出无文件 IO、项目创建/编辑/取消、快照源码配对、列表顺序、后缀和旧数据兼容。公共逻辑至少验证两个宿主。
3. Web 执行 `npm run test:preview`、`npx tsc --noEmit`、`npm run build`；公共 UI 或插件修改再在 `vscode-extension` 执行 `npm test`、`npm run vscode:prepublish`。
4. Server 使用虚拟环境 UTF-8 Python 执行涉及模块的 pytest。存储改动额外覆盖无目录创建/写入、虚拟二进制下载、大小/格式校验、消息事务关联及删除会话跳过空磁盘路径。
5. 交付说明用通俗语言说明变化和实际验证范围；记录限制，不以测试通过承诺永不回归。更新本文应修正旧段落，不能保留互相冲突的现状说明。

### 本次核对结果（2026-10-07）

发现旧 GLB 自动导出写入 `Server/storage/generated`，与虚拟产物约定冲突，已改为内存校验和数据库 BYTEA。通过运行中的 Web `/api` 代理完成临时会话的 GLB 保存、二进制取回和历史消息读取，生成目录文件数量前后均为 156；测试会话已删除，用户历史文件未清理。单元测试另验证导出不调用目录创建及文件写入、拒绝无效/超限模型、历史磁盘产物兼容与虚拟产物删除。此次未将既有 Office/附件管线迁移为虚拟存储，也未声称完成所有模型实战和逐像素 UI 验收。

## 1. 项目简介

Gor 是一个以对话为中心的个人 AI Agent 应用。用户可以用自然语言提问、查询实时信息、分析图片或上传文件，也可以让助手生成文档、视频或可交互的前端原型。与只返回文本的聊天机器人不同，Agent 能根据请求选择后端工具执行任务，并通过流式消息反馈进度和结果。

项目由 Web 应用、FastAPI Agent 服务、VS Code 扩展和 Expo / React Native 移动端容器组成。Web 是主要产品界面；Native 当前通过 WebView 加载 Web，并提供设备定位桥接；VS Code 扩展把同一聊天页面放入扩展侧边栏 Webview。

## 2. 技术架构

```text
┌──────────────────────────── Web / Native / VS Code Extension ──────────────────────┐
│ React + TypeScript + Vite                                                         │
│ 首页 / 聊天 / 天气 / 代码沙箱 / Preview Worker                                    │
│ Native: Expo + WebView + 定位桥接；VS Code: Activity Bar + Sidebar Webview       │
└───────────────────────────────┬─────────────────────────────────────────────────┘
                                │ HTTP / SSE
                                ▼
┌──────────────────────────────── FastAPI 服务 ─────────────────────────────────────┐
│ 聊天与 Agent 编排 │ 会话/附件/Preview API │ 天气/音乐/视频/代码执行 API            │
│ LangChain 工具：搜索、文档、图片理解、天气、视频、向量检索、虚拟项目文件操作       │
└───────────────┬───────────────────────┬──────────────────────┬────────────────────┘
                │                       │                      │
                ▼                       ▼                      ▼
       方舟模型与外部 API        Supabase PostgreSQL       GOR_STORAGE_DIR
       搜索/天气/视频等          会话、消息、项目快照       上传附件、生成文件
```

| 层 | 主要技术 | 责任 |
| --- | --- | --- |
| Web | React 18、TypeScript、Vite、React Router、Tailwind CSS、Less、Radix UI、Lucide | 页面、会话交互、SSE 消费、附件选择、Preview Worker UI |
| VS Code 扩展 | VS Code Extension API、WebviewViewProvider、Webview、Node HTTP/WebSocket | 在 Activity Bar 注册 Gor 容器与侧边栏聊天视图，复用 Web 聊天页面并连接 Gor Server |
| Preview Worker | Web Worker、esbuild-wasm、Virtual FS、受限 iframe、fflate、Three.js | 编译和运行虚拟项目、展示上传的 dist、文件树与源码浏览 |
| Native | Expo SDK 57、React Native、react-native-webview、expo-location | 将 Web 应用嵌入移动端，并通过消息协议把定位请求交给系统能力 |
| Server | Python、FastAPI、Pydantic、httpx、LangChain | Agent 循环、工具路由、SSE、文件/天气/会话等 API |
| 数据与文件 | Supabase PostgreSQL、asyncpg、`GOR_STORAGE_DIR` | 会话、Preview JSONB 快照及 GLB 虚拟二进制在数据库；原始附件和现有 Office 等输出仍在服务器持久目录 |
| 外部能力 | 火山方舟、搜索服务、高德、Jamendo、小云雀、Judge0、Embedding 服务 | 提供大模型、联网搜索、天气、音乐、视频、代码执行与向量检索 |

### 关键数据流

1. Web 将消息提交至 `POST /api/chat`，服务端读取历史上下文并调用模型；工具调用由 Agent 执行，Token、工具状态和最终回答通过 SSE 返回。
2. 会话和消息保存在 PostgreSQL。Web 项目源码和新 GLB 导出为虚拟快照/数据库二进制，不自动落入本地目录；用户上传附件及现有文档等工具仍使用服务器持久目录，消息保存 ID 和下载 URL。
3. Preview Project 是与真实磁盘工作区隔离的虚拟文件系统。浏览器负责编辑、编译和沙箱运行；项目快照可保存至服务端数据库，浏览器 IndexedDB 另存上传内容缓存。上传 ZIP/文件夹的原始内容由服务端附件接口提供跨设备取回能力。
4. 移动端 Expo Go 扫描 Metro 二维码后启动 Native 容器；容器中的 WebView 加载开发机上的 Web 地址。手机与开发机需在同一 Wi-Fi，且 `Native/App.tsx` 的开发地址需与开发机当前局域网 IP 一致。
5. VS Code 扩展把聊天页面打包为 Webview 资源；HTTP/SSE 负责对话，WebSocket 登记真实工作区并桥接 Project API 操作。模型按需读取目录/源码及执行 CRUD，扩展负责路径和工作区权限；不全量上传项目，不调用 Web Preview。

## 3. 页面与功能实现

### 首页 `#/`

- 展示问候语、快捷功能卡片、每日进度视觉卡片、天气入口和音乐播放器。
- 天气卡片通过 `useWeather` 获取定位/天气状态并支持重试；播放器向后端请求 Jamendo 曲目元数据和音频地址。
- 页面以 React 组件、Tailwind 类名和 Less 样式组合构建，并适配移动端安全区。部分快捷卡片和每日进度目前是展示型 UI，不应视为完整的任务管理功能。

### 聊天页 `#/chat`

- 支持多会话创建、切换、删除和历史消息恢复；会话、消息由前端 hooks 管理并通过 FastAPI / PostgreSQL 持久化。
- 支持文本、图片、ZIP、文件和文件夹附件。图片可送视觉模型分析；项目附件在点击发送后加入聊天，附件元数据与实际文件分离存储。文件夹保留目录结构打包，其他文件可单独下载。
- `useMessage` 发送请求并消费 SSE；消息气泡渲染 Markdown、工具状态、Token 用量、附件入口、生成文件及项目变更。
- Agent 能使用按意图路由的多源网页搜索、GitHub Code Search、多源图片搜索（Pexels、Pixabay、Unsplash、Openverse、Wikimedia Commons）、天气、Word/Excel/PPT/PDF 生成、视频生成、Python 执行、向量检索和 Preview 项目文件工具。网页搜索按意图并行选择 Provider、融合去重并保留来源；图片搜索并行调用可用 Provider，保留原始页面、作者和许可信息。明确的 `site:` 约束不扩展站外。需要的密钥、数据库或第三方服务需另行配置。
- 桌面侧栏可折叠；窄屏使用移动端布局。主题、上传状态和会话预览状态由前端状态层协调。

#### 对话上下文与 Agent 调用控制

- 普通聊天、搜索、天气、文档、演示文稿、Preview 编辑和真实工作区操作由规则路由到不同的提示词与最小相关工具集；闲聊不携带 Preview 或文件生成等无关工具。用户意图不明确时优先普通回答，不以工具调用代替解释。
- Preview 编辑使用专门的精简规则。常见修改先搜索目标并读取小范围源码；代码从当前项目搜索结果或范围读取结果中构造精确补丁。简单明确的旧文本替换走 `SIMPLE_EDIT` 快速路径，普通复杂修改采用批量搜索、必要时合并局部读取，再尽量一次提交多文件补丁；不把整份源码默认塞入提示，也不把工具返回的完整文件复制到最终聊天答复。
- Agent 对简单、普通和修复类编辑设有不同的软工具调用预算；补丁失败时按错误类型重新搜索/读取或回退到常规编辑流程。预算是控制重复工具循环的保护，不代表任何请求都保证一次完成。
- 长会话使用独立的 `ContextEngine` 按 session 增量摘要：摘要与待处理历史估算达到约 30,000 tokens 后，压缩较旧消息并尽量保留约 10,000 tokens 的最近原文；后续压缩基于旧摘要和新增旧消息，不重复概括整个会话。摘要保存在 PostgreSQL `conversation_context`，原始聊天消息不删除；摘要模型失败时回退普通历史，不中断 SSE 对话。

#### 窄屏聊天与会话侧栏

- 手机与 VS Code Webview 复用聊天页面的窄屏布局，桌面宽屏保留原有 PC 排列。窄屏顶部标题居中并按左右控件空间截断，避免和品牌 Logo、导航按钮相互遮挡。
- 移动端会话列表以覆盖层展开并带进出场过渡；点击遮罩关闭。点击“新章”会立即切换到新会话并收起列表。窄屏会话项始终露出删除入口，不依赖 hover。
- 消息列表提供悬浮的“滚动到底部”控件；已在底部时隐藏。移动端聊天输入框保持紧凑，避免占用过多可视高度。
- Web 模式仅在确实存在可预览产物或可预览源码项目时展示 Preview Worker 入口；插件模式不显示 Preview Worker 入口。页面初始加载/普通聊天不凭空恢复默认快照；历史项目只能由真实会话产物或用户操作恢复。
- Logo 在窄屏随侧栏、Preview Worker 和会话状态采用相应位置与过渡；插件 Webview 与 Web 手机模式有独立的窄屏布局条件。PC 端不套用移动端 Logo 平移动画。

#### VS Code 扩展与 Gor 侧边栏

- `vscode-extension` 通过 `contributes.viewsContainers.activitybar` 注册 Gor 活动栏容器，通过 `contributes.views` 与 `WebviewViewProvider` 在侧边栏显示 `Gor Chat`；`Gor: Open Chat` 命令聚焦 Gor 侧边栏。内容复用 `Web/src` 的聊天页构建结果，不另写一套聊天 UI。
- 插件 Webview 启用受限的本地资源根目录和 Content Security Policy；运行时将聊天 API、页面资源和图片地址映射到扩展 Webview 可访问的 URI。前端通过 VS Code 模式标识区分插件布局，插件会话使用 `default:vscode` 用户命名空间，与网页会话列表隔离。
- 插件聊天使用 Gor Server 的 HTTP/SSE API；扩展 WebSocket 登记工作区并承接 `VSCodeProjectProvider` 读写请求。已接入目录/文件清单、搜索、读取、创建、覆盖、补丁、删除及目录操作，结果通过公共 Diff 展示；“Connected”本身不证明某次写入成功，需真实工具回执。会话 ID 可在用户询问时通过对话回复，无需专用 UI。
- `npm run build:webview` / `npm run vscode:prepublish` 构建聊天页资源和扩展 TypeScript；开发态 `npm run watch:webview` 监听 Web 源码、重建扩展 Webview 资源，并通过构建信号刷新已打开的聊天视图。构建资源更新后，扩展宿主仍需运行或重载才能载入新的扩展代码。

#### 联网检索与图像来源

- `web_search` 以规则分类问题并并行查询该类已配置的 Provider。当前意图和实际调用计划如下：

| 搜索意图/范围 | 实际 Provider 顺序（同时并行请求已配置项） | 优先检索范围示例 |
| --- | --- | --- |
| 普通咨询、用户体验、旅游/美食推荐 | Tavily → Brave → Serper → 豆包 | 小红书、知乎、马蜂窝、携程、大众点评、去哪儿；旅游/美食关键词会追加携程、去哪儿、点评、小红书等域名 |
| 官方事实（政策、票价、开放时间等） | Tavily → Brave → Serper → 豆包 | gov.cn、文旅部门、UNESCO、携程等 |
| 技术文档与教程 | Tavily → Brave → Serper → 豆包 | MDN、Python、React、Vue、Node、Vite、Webpack、esbuild、Chrome/Google Developers；React、esbuild 等词会追加官方站和 GitHub |
| 代码示例/开源实现 | GitHub Code Search → Tavily → Brave → Serper → 豆包 | GitHub 代码结果优先，其他来源补充网页资料 |
| 新闻/最新动态 | Tavily → Brave → Serper → 豆包 | 新华网、人民网、news.cn、政府网站、澎湃、36氪、IT之家等 |
| 深度调研/论文 | Exa → Tavily → Brave → Serper → 豆包 | arXiv、Semantic Scholar、ACM、IEEE、JMLR、ACL 等 |
| 视觉灵感、PPT/设计参考 | Tavily → Brave → Serper → 豆包 | 小红书公开索引页及 Pitch、Canva、Envato、Slidesgo、SlidesCarnival、Microsoft、OfficePLUS、优品PPT、Behance、Dribbble 等；没有专用小红书 API |

  每个 Provider 缺少密钥会跳过；结果会规范化、跨源去重、融合排名并保留来源。优先域名结果不足时，普通搜索可对部分稀疏 Provider 扩大到全网；用户明确给出 `site:` 时则只保留指定域名结果，禁止扩大范围。域名限制方面，Tavily 由编排器传入 `include_domains`，豆包使用 `Filter.Sites`，Serper/Brave 使用 `site:` 查询语法，Exa 使用 `includeDomains`；GitHub Code Search 本身没有站点参数，结果仍经统一 URL 过滤。虽然 Tavily 适配器实现了排除域名参数、豆包 API 也接受 `BlockHosts`，当前 `web_search` 编排流程未提供显式“排除域名”选项。默认每个 Provider 最多取 5 条，合并后最多返回 8 条。
- `search_images` 默认并行搜索可用的 Pexels、Pixabay、Unsplash、Openverse、Wikimedia Commons，也可指定单一 Provider。支持横图、竖图、方图筛选，每个来源最多取 6 个候选；返回图片直链、来源页、作者和可用许可信息，不由搜索工具下载图片。PPT 直接复用同一搜索实现，再做内容匹配、下载、画质筛选、嵌入与署名，不重复实现 Provider/API。Pixabay 候选 URL 仅短时用于取图，不永久热链；Unsplash 触发下载记录并保留署名。
- PPT Design Reference 在领域权重选出的公开网站（中文场景额外包含小红书）上进行带域限制的多源页面检索，只记录页面标题、摘要和来源链接，并以有上限的检索命中因子修正档案排序；不抓取 PPT 文件、模板预览图，也不做模板视觉分析。搜索不可用时回退静态设计档案。

### Preview Worker（聊天页内的产物与源码工作区）

- `Preview` 展示助手生成的 HTML、Office/PDF/3D 文件、导入的 dist 页面或虚拟项目运行结果；`Code` 浏览虚拟项目源码。没有源码的附件不显示源码操作。
- Preview 文件树把上传附件和助手生成产物按会话展示；选择产物用于预览。Worker 的清除操作按现有清除语义软隐藏当前项目关联的产物和源码，不做不可恢复的物理删除；聊天消息仍可重新加入。
- **项目与产物按稳定 ID 隔离**：同一个可编辑 Preview Project 连续修改沿用同一个 `projectId` 并递增 `revision`；Worker 按项目 ID 合并更新，只展示该项目的一条最新入口，不因每轮局部 patch 另建项目。聊天消息保留本轮更新文件和 diff；彼此独立的项目或 Presentation 产物仍按各自 ID/消息快照隔离。隐藏 Worker 条目不销毁聊天消息中的重新打开入口。当前没有独立的项目版本时间线或任意历史版本回滚。
- **预览产物格式提示**：Preview 文件树条目悬停时展示最终交付产物的扩展名，而非内部实现文件的扩展名。例如 React 应用预览标注 `.html`，由 SceneSpec 渲染并导出为模型的 3D 产物标注 `.glb`；普通文件则根据实际文件名/类型展示。新增产物类型时，应由快照元数据显式提供最终输出扩展名，避免从临时编译文件或源码文件名误推断。
- ZIP/文件夹导入时识别源码项目或静态 dist。源码导入至 Virtual FS，可由 Web Worker 调用 esbuild-wasm 构建；构建结果在不授予 `allow-same-origin` 的 iframe 中运行。依赖受限于内置白名单，不支持用户安装任意 npm 包。
- **Three.js 3D 场景**：通过受限 `SceneSpec` 生成 `/src/scene.json`，浏览器固定渲染/导出器生成真实 GLB v2 二进制并保存为数据库虚拟产物。Preview 使用 GLB 模型查看器，Code 显示对应场景快照；内部 HTML 渲染支架不是最终模型文件。当前支持程序化几何，不是任意格式模型编辑器或完整建模软件。
- 项目快照保存在 `session_preview_projects` 和消息快照；新 GLB 保存在数据库二进制列，不自动写服务器文件。原始附件和现有文档输出仍在服务器存储；IndexedDB 用于本机快速恢复。需要持久卷的是这些仍使用磁盘的管线，不是 Web 虚拟源码/GLB。
- **源码与产物的持久化机制**：Web 源码使用 JSONB，Web GLB 使用 BYTEA；原始附件及现有文档等仍用文件系统。对象按所属会话和消息关联，不能混用存储方式或声称所有输出已完全虚拟化。
  - 助手生成或用户导入的可编辑虚拟项目，以会话为粒度保存到 PostgreSQL 的 `session_preview_projects`：`session_id` 唯一对应一份最新快照，`project` 使用 JSONB 保存项目名称、模板和 `{文件路径: 文件内容}` 文件集；同时记录来源 `origin`（`generated` / `uploaded-source`）、上传名称、递增版本 `revision` 和更新时间。前端在项目状态变化后调用 `PUT /api/chat/session/{session_id}/preview-project`；服务端校验文件路径与内容后 upsert。重新进入会话时通过同一路径的 GET 接口读取快照，恢复 Virtual FS，因此刷新或跨设备访问时不依赖浏览器内存中的源码状态。
  - 上传附件（包括 ZIP、普通文件及打包后的文件夹）先写入 `GOR_STORAGE_DIR` 下的上传目录；PostgreSQL `session_attachments` 只记录附件 ID、所属会话、名称、类型、相对路径、MIME 类型和大小。聊天消息保存附件引用，下载时服务端按会话与附件 ID 查元数据，再从存储目录读取文件。前端 IndexedDB 是本机快速恢复缓存，不是跨设备的权威数据源。
  - 助手生成的可下载文件（例如文档、表格、演示文稿）写入 `GOR_STORAGE_DIR` 下的生成文件目录，消息中保存展示信息和下载 URL；请求下载时由 `/api/download/{filename}` 从服务器文件目录返回。它与 Preview Project 的 JSONB 源码快照是两种不同的持久化对象：只有项目快照中实际存在的文件才可在 Code 中浏览，二进制附件或生成文件不会为了展示而自动转换/生成源码。
  - Preview 文件树的显示/隐藏属于会话界面状态；隐藏某个条目不等于删除服务端附件或源码快照。若用户从聊天消息再次打开该附件/产物，可重新加入当前 Preview 列表。删除会话时，服务端会清理关联的 `session_preview_projects` 快照；文件目录的持久性仍取决于 `GOR_STORAGE_DIR` 是否映射到持久卷。
  - Web GLB 导出由 `/api/chat/session/{session_id}/generated-artifacts` 原始二进制 PUT 接口校验，数据库记录产物 ID、名称、MIME、大小、`artifact_bytes`；同一事务将引用关联到目标 assistant message。GET 从数据库返回二进制，旧 `relative_path` 记录仅兼容读取。删除会话清理数据库产物，空路径不得参与磁盘清理。
  - **边界说明**：`session_preview_projects` 仍是每会话最新项目，历史消息另保留各自源码快照；不等同任意版本回滚系统。新 GLB 是独立 ID 的数据库产物，现有 Office 输出仍由文件目录和消息引用持久化；不能混称统一的版本库。
- Preview Project 与真实磁盘工作区隔离。Web 请求只编辑虚拟项目，不能因配置 `PROJECT_WORKSPACE_ROOT` 就获得磁盘写权限；VS Code 请求操作扩展连接的当前工作区，不使用服务端进程根目录代替。

#### 通用 Project API 与源码按需上下文

- Agent 文件工具通过 `ProjectAPI`、`ProjectProvider`、`ProjectRef` 和 Provider Registry 抽象项目操作；Preview Provider 处理 Web 虚拟项目，`VSCodeProjectProvider` 通过扩展桥接处理实际工作区。Provider 由显式客户端模式选择，不能互为隐式降级。
- 当前 Preview 源码链路提供文件清单、代码搜索、按行范围读取、精确补丁、批量补丁和文件写入。默认先返回搜索命中及少量上下文，仅在定位不足时扩展读取；工具结果受结果数、行数、字符和 Token 预算限制，并输出 revision/version，避免每轮把项目所有源码发送给模型。
- 文本文件采用通用 exact-text 匹配，不解析具体语言语法。补丁要求 `old_text` 唯一命中并校验预期 revision；目标不存在、不唯一或版本冲突时拒绝写入。批量补丁用于同一请求的多文件修改，随后沿用当前 Preview 的 diff、项目持久化与 UI 流程；二进制文件不走文本 patch。
- Project API 是访问抽象，不等于任意磁盘权限。Preview Provider 只操作会话 Virtual FS；VS Code Provider 必须有在线工作区桥接、有效版本和扩展端路径校验。未知目录先读取，版本冲突后刷新；实际读写失败须报告原因，不能在气泡编造完成。

#### 新增项目类型 / 产物预览接入规范

新增技术栈、模板或交付格式时，先把“可编辑源码项目”和“用户拿到的最终产物”分开建模，再接入通用 Preview Worker。不要把某个栈的判断散落复制到气泡、文件树、下载、清除等 UI 分支里；格式差异应集中在项目/产物描述元数据或对应适配器中。

**每个项目快照的最小描述与归属**

- 可编辑项目在整个连续修改过程中沿用稳定的 `projectId`，并通过 `revision` 标识源码更新；独立交付产物各有唯一产物 ID。项目/产物关联 `sessionId`、来源消息及必要快照标识。渲染键、去重、恢复和清除以这些 ID 为准，不能仅按展示名称去重（同名文件可能是不同项目），也不能用扩展名代替项目身份。
- 快照同时描述源码文件集（若有）、预览入口/运行方式、最终交付文件名与格式、下载所需的文件或 URL。最终格式、名称必须显式记录；禁止从临时 bundle、源码入口或模板名猜最终扩展名。
- 一个最终交付物只注册一次。项目包含 `index.html`、CSS、TS 等内部运行文件，不代表应把这些文件和同一个项目再作为多份“最终产物”重复列出；确有多个独立交付物时，每个交付物各有稳定 ID，并明确关联到所属项目快照。
- 展示名按 `《内容标题.扩展名》` 规则生成，例如 `《红色运动轿车.glb》`、`《今日广州天气.html》`。标题描述交付内容，扩展名描述真实交付格式；不在名称中加入“React 输出格式”“React Preview”等技术栈标签。源码文件名仍按其真实路径显示。

**标准接入与交互流程**

1. 将新类型注册为一个适配器/描述项，明确源码是否存在、预览渲染器（HTML 沙箱、3D 查看器、文档查看器或其他）、构建入口、最终产物元数据和下载实现。相同能力走 Worker 通用流程，只有实际格式差异留在适配器。
2. 生成后保存一份与该 assistant message 绑定的完整快照；构建出的可预览文件和最终下载文件关联到同一快照。不要只写入“会话当前项目”后让历史消息引用全局最新 Virtual FS，否则切换项目、刷新或从旧气泡打开时会串源码/串预览。
3. 聊天气泡的“预览项目”和“查看项目源码”必须携带同一 `projectId` / 快照 ID。预览打开该项目实际最终产物；源码打开该快照的源码树并定位到其入口/对应文件。无源码项目隐藏源码入口，不显示“没有源码”占位提示。
4. Worker 文件树以稳定 ID 合并消息产物、恢复数据和导入文件：重复到达的同一 ID 只渲染一次；不同 ID 即使同名也不得错误合并。页面刷新后从持久化的同一快照恢复，不得把消息历史重新追加成第二个同 ID 条目。
5. Worker 顶部下载始终下载当前选择的项目/文件：预览态下载当前最终产物，源码态下载当前项目源码包（如支持）；不得固定下载第一个文件或会话中的另一个项目。条目悬浮提示展示最终扩展名。
6. Worker 顶部清除遵循软隐藏/现有清除逻辑：一次隐藏当前项目关联的预览产物及源码树入口，并保留聊天气泡重新打开/恢复它们的能力；不能误调用物理删除或仅隐藏一侧。目录树里的文件删除则按目录树既有的单文件删除语义处理，两种操作不能混淆。
7. 当前没有可预览文件时自动关闭 Worker，并隐藏右上角折叠/下载/清除等只对 Worker 有意义的控件；状态应根据当前真实可用的产物和文件树内容计算，不能只依赖“曾保存过项目”之类的陈旧标记。
8. 可构建项目在 Preview 顶栏展示 Build 状态与 Build & Run；不可构建的独立文件按格式直接预览，不显示无意义的构建控件。构建失败时保留诊断和源码可访问性，不伪报成功。

**渲染、样式与安全边界**

- 明确选择独立文件查看器或沙箱应用预览路径。GLB 等二进制产物应交给对应模型查看器；React/网页类项目才走构建后 HTML iframe。不能因新增格式而复用错误的默认 renderer。
- Preview 画布及其内部容器必须有明确的尺寸链（父级可收缩、子级 `min-width/min-height: 0`，必要时 `height: 100%`），并使用与应用皮肤协调的背景色。网页 iframe 的 `html/body/#root` 默认清除 margin、占满视口并使用透明/主题背景；不得用外层白色默认背景包住深色画布。主题背景不应覆盖用户页面自身有意设置的背景。
- 构建和运行仍在受控 Worker / sandbox 中完成；新增运行时依赖须经过白名单审查，iframe 不得为了方便擅自开放 `allow-same-origin`。注意卸载时清理 Worker、URL、事件监听和渲染器资源。

**合并前验收清单（新类型与既有类型都跑）**

- 同一会话连续生成至少两种类型、多个项目；逐个从气泡打开，确认预览和源码属于同一个消息快照，没有串项目。
- 反复点击同一气泡、刷新页面、切换会话再返回：同一 ID 只有一个列表条目，文件名仍符合 `标题.扩展名`，选中项和实际渲染内容正确。
- 分别从气泡和 Worker 文件树切换预览/源码；检查无源码项目不会出现 Code 操作，有源码项目定位正确。
- 预览态、源码态分别点击下载，检查下载的是当前选择的产物或源码包；悬浮提示显示真实最终扩展名。
- 使用 Worker 清除后，关联源码和产物一同从列表软隐藏；从原聊天气泡重开可恢复。另测目录树删除和空文件树状态，确认 Worker/顶部按钮正确隐藏且不会误删持久数据。
- 对网页、Three.js/GLB、至少一个新增文件格式分别验证构建/直接预览、主题背景、滚动与容器尺寸、构建失败提示和资源清理。
- 运行 `npx tsc --noEmit`、`npm run test:preview` 和 `npm run build`；新增去重、配对、恢复、下载、清除逻辑应补入 `Web/scripts/preview-core.test.ts` 或对应测试，不以“本机点起来了”替代自动化回归。

#### AI PPT Design Engine（当前实现）

- `create_ppt` 接收严格校验的 `PresentationDesign v1.0`，包含 5 个主题、16:9/4:3 画幅与 15 种页面类型。设计 Schema 现包含全局 `artDirection`（情绪、视觉/排版/色彩/图片方向）和独立的 `designDNA`（密度、留白、字体比例、图像处理、装饰、构图、图表等），每页则可声明目标、故事角色、信息密度、视觉强度、转场角色、布局家族/变体和图片角色。Agent 指令要求先定义叙事与视觉节奏，再生成页面；修改历史最近一份 PPT 会创建新的 UUID 快照，不覆盖旧消息。
- 确定性设计编排会按页面语义安排 hero、论点、证据、数据、停顿、总结等故事角色，分配 1–5 视觉强度和布局家族，并打断明显的连续重复节奏；布局变体依旧由既有 15 种类型和 Python renderer 渲染，不改变原生可编辑 PPTX 格式。Anti-AI Pattern Report 检查布局/布局家族重复、连续卡片墙、统一密度、每页副标题、背景图过用和照片复用；它是可解释的启发式报告，不是 AI 检测器。
- `Server/tools/presentation_renderer.py` 用 `python-pptx` 生成可编辑 `.pptx`，文本、形状、原生图表与表格仍为 PowerPoint 对象。分页保护长正文、表格和流程内容；几何 QA 检查安全边界。可选 `PresentationRenderProvider` 在环境具备 LibreOffice 与 Poppler 时将 PPTX 转为逐页 PNG；配置视觉模型时，可对首/中/尾代表页运行最多两轮的结构化评审与白名单安全补丁。没有渲染器时回退到现有 Schema Preview Worker，而不会伪称做过像素级检查。当前开发机没有 LibreOffice，故本机尚未验证真实 PowerPoint/LibreOffice 像素换行；现有几何 QA 也不等同完整的 Office 溢出检测。
- 图片由可替换的 `PresentationAssetProvider` 接口接入；当前 `SharedImageSearchProvider` 直接调用 `search_images` 共用的 Provider 搜索实现。每页查询由 `imageRole` 和叙事类型选择，不会为了“每页都有图”塞无关背景：封面/明确满版图可做视觉主图，image-text 使用编辑型配图，产品/数据页按需要选择，其他页面可以留白。查询词须结合实际内容，不再对每页用通用词；查无图/来源不可用时只在有明确视觉角色的页面使用主题兜底。选中的图下载后会按页嵌入，并留下来源、作者及许可链接；图像在 PPTX 和 Preview 快照中按同一页关联，保持等比裁剪。
- Preview Worker 仍以消息快照为边界；PPT 逐页导航、源码 `/presentation.json`、下载 `.pptx`、artifact/project/snapshot IDs 维持原有配对和唯一性。可用真实渲染时预览直接显示该页 PNG；否则继续使用 Schema 页面渲染，并按图片角色放置已有页面图片。附件列表仍以 artifact ID 去重；此功能不读取 React/Three 共享虚拟文件系统。
- 新增验收夹具覆盖：10 页 EV 投资材料、8 页 AI 手机发布、12 页企业 AI 咨询路线图；数据明确标为示意/待核验，避免把夹具误当行业研究结论。另测自然语言修改生成新的不可变消息快照。夹具用于检查节奏、语义角色、图层边界和 PPTX 可打开性，不代表已完成真实客户内容/事实审核或逐像素人工设计验收。
- 项目级运行状态：仍是单文件 PPTX 产物和 JSON 源码快照，没有专用 artifact 数据表或源文件夹打包；真实 PNG/视觉评审取决于可选系统组件，本机未安装 LibreOffice 时相应状态为 unavailable。后续可新增图像 provider 或页面类型，但须沿用每页显式图片角色、消息快照隔离、确定性设计字段、可解释 QA 和既有文件 ID/download 流程。

#### PPT 主题背景、动态效果与 BGM

- **主题视觉与背景图**：新增 deck 级主题视觉配置，并为每页结合主题、页面标题和内容生成图片查询词；默认尽可能为每页寻找相关图片，但根据页面密度选择满版背景、局部配图或低干扰裁切，避免图片压住文字或与内容无关。查询失败时使用与主题一致的渐变、纹理或色块兜底。背景图需保留可读性遮罩和前景/背景层级，使用等比裁切，不拉伸图片。当前 Pexels 仍按既有 `imageRole` 选择页面，不保证每页配图；此处是目标行为，不是现状。
- **动态效果（当前实现）**：`PresentationDesign v1.0` 的同一份 `/presentation.json` 包含 deck 级 `motionLanguage` 和页级 `transition`、`animations`、`animationGroups`、`animationTimeline`、`persistentElements`。`Server/tools/presentation_motion.py` 按设计 DNA、页面角色和内容层级确定性编排；除明确关闭或指定点击外，默认采用 `withPrevious` / `afterPrevious`，并对卡片、步骤等分组做节奏错开。时长、间隔和距离使用受限 token；每页一般最多 5 组，密集页最多 4 组，停顿页 1 组。背景、页脚、页码和装饰保持静态。旧快照仍按旧版淡化/少量点击方案渲染，不会被强制改写。
- **原生 PPTX 与 Web 共用时间轴**：`Server/tools/presentation_motion_renderer.py` 将目标绑定到仍可编辑的 PowerPoint 文字、图片、形状组、原生图表/表格；通过结构化 Open XML 写入 fade/push/wipe 转场以及 appear/fade/rise/wipe/fly/zoom/grow/pulse/colorEmphasis/fadeOut。`Web/src/preview/core/presentationMotion.ts` 消费相同的 target、顺序、trigger、start、duration、delay、clickIndex，以 Web Animations API 模拟、重播和清理。Web 的语义排版与真实 Office 像素布局可能不同，预览明确区分动画模拟与静态实页；减弱动态效果偏好时直接显示终态。图表只支持整体揭示，不宣称 series/category 原生分步；Morph 仅判断候选与记录 `persistentElementId`，实际导出回退 fade，Web 为近似淡化，不宣称原生 Morph。
- **Motion QA 与安全降级**：检查目标、预算、重复顺序、节奏、方向、过长时间轴、连续重复编排、淡化滥用、Morph 条件等；可确定性裁剪、限幅或静态化低优先级组，结构化写入失败时仅该页退回无动画，`visualQA.motionQA.nativeFallbacks` 记录原因，避免损坏整份 PPTX。自然语言修改提示词让模型基于最新 schema 修改受影响页的 motion 字段，再走同一校验/编排/渲染流程，生成新的 artifact/project/snapshot ID，不覆盖旧快照；模型对全部示例指令的实战遵从率尚未独立验收。
- **性能与能力边界**：PPT 图片分配在进程内以与 motion 无关的内容/图片查询键缓存整套图片，限 8 套/128 MB/5 分钟；共用 `search_images` 对候选元数据按 Provider/关键词/方向做缓存，避免重复请求。仅改动画时尽可能复用图片，进程重启或缓存过期后仍可能重新请求。已由本机 PowerPoint 实际打开和逐页放映 10 页发布会、12 页咨询报告、10 页点击版和 10 页效果诊断版；WPS 未验证。测试夹具位于 `.runlogs/motion-acceptance/`，逐项结果见 `PPT_MOTION_REPORT.md`。完整 Preview Worker 的独立验收页覆盖两份 PPT 与 React/Three 的切换、源码及软隐藏恢复；Office/PDF 下载/预览接口有自动化回归，但浏览器系统保存对话框的最终落盘及真实用户会话跨设备刷新仍未完成 UI 验收。
- **主题 BGM**：按演示主题推荐一条可选的纯音乐，用户可在预览中试听、静音和调节音量；导出时将获授权的音频嵌入 PPTX，并配置跨页播放/停止行为。音乐必须有明确来源、署名及演示/分发许可记录；第三方曲库的随机结果不能默认视为可再分发。当前 Jamendo 播放器是独立首页功能，随机曲目尚未与 PPT 主题匹配，也未接入 PPTX 导出。
- **兼容与验收**：图片、动画和 BGM 任一能力失败都要有明确状态与可用降级，不阻断 PPTX 下载。验收需覆盖 PPTX 包内图片/音频/OOXML、PowerPoint 或 LibreOffice 实际播放、预览中的图片等比与文字可读性、无音频/无图片时的主题兜底及旧快照兼容。静态 PNG 截图只能检查布局，不能作为动画或音频验收依据。

#### PPT Design Reference System（当前实现）

- `Server/tools/presentation_reference.py` 保存 8 个**元数据级**设计来源档案：Pitch、Envato Elements、Canva、Slidesgo、SlidesCarnival、Microsoft PowerPoint、OfficePLUS、优品PPT。基础权重依次为 `0.95 / 0.93 / 0.88 / 0.82 / 0.75 / 0.75 / 0.72 / 0.62`。这些档案描述各站擅长的场景、风格、语言、行业、受众、交付类型和抽象视觉特征；不是已获取或授权的模板目录，不包含第三方素材。生成时另对按主题匹配的高权重站点及中文小红书公开索引页执行有域名限制的多源检索。
- 系统从主题、用途、受众和页面概要提取有限的 `PresentationBrief`，按 `baseWeight × scenarioRelevance × styleRelevance × languageRelevance × industryRelevance × audienceRelevance × formatRelevance` 计算确定性得分，并以最高原始分归一化为 `finalWeight`。同分按来源 ID 稳定排序。选前两名主参考、随后两名辅助参考；中文稿另记录 OfficePLUS/优品PPT 作为排版校准来源，即使它们不是主视觉来源也不取代主参考。
- `ReferencePlan` 随 `/presentation.json` 快照保存 brief、八站得分与因子、主辅来源、中文校准、参考意图、抽象 `blendedDNA`、实际填入的 `appliedDNA`、布局语法、动画方向和决策说明。新稿及自然语言修改都重新计算；用户显式指定的设计 DNA 保留，用户上传/指定参考的有界语义参数优先于公共档案，绝不复制参考图片或页面几何。
- 接入顺序为：Schema 验证 → Design Reference → 既有确定性 Art Direction/Design DNA/Layout/Motion → 可编辑 PPTX 与 Preview Worker。参考系统只补未决定的设计字段；既有页面类型、布局算法、图片 provider、Motion 时间轴、下载与快照 ID 机制继续独立工作。中文排版在原生渲染和 Web 预览采用相同字体方向；离线封面无图时自动放宽标题栏，避免中文末字孤行。
- 内置 `PublicIndexedReferenceProvider` 仅保留公开搜索得到的页面标题、摘要和来源链接，用有限检索信号轻量调整来源排序；没有抓取模板文件、预览图片或几何结构，也不声称完成模板视觉分析。搜索无结果、缺少密钥或 Provider 故障均回退原来的静态档案，不阻断 PPT 生成。默认只提取抽象设计规律，不能下载、克隆或重新分发模板/品牌元素。
- A–E 五类离线验收分别覆盖 SaaS 融资、中文企业年报、新能源汽车发布、政府汇报和时尚品牌发布。服务端测试验证确定性排序、因子、中文校准、显式覆盖、更新隔离、provider 降级、PPTX 字体及快照；前端回归验证旧 Preview Worker/产物去重/快照流程。验收样片与 manifest 在 `.runlogs/reference-acceptance/`（本地忽略目录），结果与未实现项见 `PPT_REFERENCE_REPORT.md`。样片只用于离线结构和 PowerPoint 可打开性检查，没有从站点抓取模板，也不能证明外部模板的视觉还原质量。

### 天气页 `#/weather`

- 展示当前天气样式卡片及未来三天表格，具备返回导航和移动端样式。
- 当前页面中的实况与预报数据在 `Web/src/pages/weather/index.tsx` 中是静态演示值；它不同于首页使用的实时天气 Hook 和后端高德接口。页面接入动态预报仍是可扩展方向。

### 代码沙箱页 `#/code`

- 提供 Python 示例选择、代码编辑、运行和 stdout/stderr/状态展示。
- 前端请求 `/api/judge/execute`，FastAPI 再代理到 Judge0，并轮询执行结果；代码实际运行在外部 Judge0 沙箱，不在浏览器或 Gor 服务进程中执行。Judge0 需独立部署，页面当前适合作为演示工具。
- 当前页面把后端地址写成 `http://localhost:3001`；桌面本地开发可用，但 Native 真机中的 `localhost` 指向手机自身，移动端访问该页前应改为相对 `/api` 或统一 API 配置。

### Native 移动端

- Expo / React Native 提供全屏 WebView 外壳，Web 内容仍由 Web 工程实现；`bridges/geolocation` 使用 `expo-location` 处理网页发出的定位消息。
- 当前 `Native/App.tsx` 的开发 Web 地址是 `http://192.168.1.4:5173/`。该地址仅适用于开发机当前 Wi-Fi 网络；IP 变化后需更新。正式跨网络使用时应改为部署后的 HTTPS 域名，而不是开发机局域网 IP。

## 4. 对 AI Agent 的点评

### 做得比较好的地方

- Agent 不是单轮问答封装：它能基于上下文决定是否调用工具，并将工具开始、进度、结果和文件产物以流式方式反馈。
- 工具覆盖面较实用，兼顾信息检索、内容生成、图片理解、代码执行和前端原型生成；虚拟项目工具让模型可以围绕一份可预览的文件集迭代。
- Web、移动容器和后端职责边界基本清晰；附件内容、聊天记录和生成文件已有持久化路径，Preview 虚拟文件工具与真实源码编辑也做了隔离。

### 当前边界

- Agent 的可靠性、响应时间和费用受模型、提示词、工具参数、第三方 API 可用性和最大工具轮数影响；目前项目中尚未体现系统化的离线评测与质量追踪。
- 搜索、天气、音乐、视频、Embedding 和 Judge0 都依赖外部服务或凭据。不同服务配置不齐时，对应功能会降级或不可用。
- Preview iframe 限制了对主应用 DOM/存储的访问，但不是 CPU、内存或网络资源配额沙箱；未知项目仍应谨慎运行。
- 当前尚未形成完整的账号、授权、附件配额和生命周期治理方案。`GOR_STORAGE_DIR` 若未映射到持久卷，容器重建时文件可能丢失；多实例需共享文件存储。
- 首页有展示型卡片，天气页预报仍为静态数据，代码沙箱页是 Judge0 演示入口；这些界面不代表对应完整产品能力已完成。

## 5. 可延伸方向

以下是后续产品和工程可以选择的方向，并非当前已经实现的功能：

1. **账户与权限**：建立登录、用户级会话隔离、附件鉴权和分享权限，避免仅凭会话标识访问资源。
2. **云文件存储**：将单机/挂载卷存储升级为 S3 兼容对象存储或 Supabase Storage，补充容量配额、过期清理、校验和及上传断点续传。
3. **Agent 质量体系**：为工具调用建立结构化日志、错误分类、延迟/成本统计、回归样例和自动评测；提高引用来源、失败恢复和用户确认机制。
4. **更完整的移动体验**：将局域网开发地址改为环境配置；上线时使用 HTTPS 域名，并逐步加入原生导航、文件选择/分享、推送和离线提示。
5. **Preview 能力增强**：支持更多模板与依赖、运行时资源限制、项目版本快照/回滚、协作分享，以及导出和重新导入体验。
6. **补齐页面产品化**：让天气页接入真实预报 API；将首页进度与快捷卡片连接到持久化数据，或明确保持为 UI 演示区。
7. **运维与可靠性**：增加健康指标、结构化日志、数据库迁移流程、后台任务队列、限流、附件病毒/内容检查和备份恢复策略。

## 6. 本地运行入口

| 工程 | 目录 | 命令 | 默认地址/备注 |
| --- | --- | --- | --- |
| Web | `Web/` | `npm run dev` | `http://localhost:5173`；`/api` 代理到 `127.0.0.1:3001` |
| Server | `Server/` | `.\venv\Scripts\python.exe -X utf8 main.py` | 默认 `http://localhost:3001`；沿用 Python UTF-8 后台启动，环境配置见 `Server/.env.example` |
| VS Code 扩展 | `vscode-extension/` | `npm run vscode:prepublish`；开发调试在 VS Code 中按 F5 | 构建 VS Code Webview 与扩展；前端热构建可运行 `npm run watch:webview` |
| Native | `Native/` | `npm start -- --lan` | Expo Go 扫描二维码；手机和开发机需连接同一 Wi-Fi |

核心配置包括 `ARK_*`、`SUPABASE_DB_URL`、各搜索服务 Key、`AMAP_WEB_SERVICE_KEY`、`XIAOYUNQUE_*`、`JUDGE0_URL`、`PROJECT_WORKSPACE_ROOT` 与 `GOR_STORAGE_DIR`。真实密钥应保存在本地环境变量或未提交的 `.env` 文件中。

后台启动使用 PowerShell `Start-Process`，工作目录设为 `Server`，运行上述虚拟环境 Python 并传 `-X utf8 main.py`，窗口隐藏，输出重定向日志；不要改用系统 Python。数据库字段兼容迁移由服务启动的 `init_db()` 执行，存储协议改动后需确认后端已重载并完成初始化；旧插件包需重建/重载后才能使用新公共组件。
