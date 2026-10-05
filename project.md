# Gor AI Agent 项目说明

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
| 数据与文件 | Supabase PostgreSQL、asyncpg、`GOR_STORAGE_DIR` | 保存会话消息、附件元数据、Preview 项目快照；文件内容保存到服务器持久目录 |
| 外部能力 | 火山方舟、搜索服务、高德、Jamendo、小云雀、Judge0、Embedding 服务 | 提供大模型、联网搜索、天气、音乐、视频、代码执行与向量检索 |

### 关键数据流

1. Web 将消息提交至 `POST /api/chat`，服务端读取历史上下文并调用模型；工具调用由 Agent 执行，Token、工具状态和最终回答通过 SSE 返回。
2. 会话和消息保存在 PostgreSQL。用户附件上传至服务器存储目录，消息保存附件 ID 和下载地址；助手生成文件由工具写入同一持久目录，消息保存其展示信息和下载 URL。
3. Preview Project 是与真实磁盘工作区隔离的虚拟文件系统。浏览器负责编辑、编译和沙箱运行；项目快照可保存至服务端数据库，浏览器 IndexedDB 另存上传内容缓存。上传 ZIP/文件夹的原始内容由服务端附件接口提供跨设备取回能力。
4. 移动端 Expo Go 扫描 Metro 二维码后启动 Native 容器；容器中的 WebView 加载开发机上的 Web 地址。手机与开发机需在同一 Wi-Fi，且 `Native/App.tsx` 的开发地址需与开发机当前局域网 IP 一致。
5. VS Code 扩展把同一聊天页面打包为 Webview 资源，注册到 Gor Activity Bar 侧边栏；扩展通过 HTTP/SSE 使用聊天 API，并用 WebSocket 向服务端登记当前工作区元数据。当前工作区登记只传工作区名称和 URI，不上传或读取本地源码。

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
- 插件聊天使用 Gor Server 的 HTTP/SSE API；扩展 WebSocket 目前只登记活动工作区 ID、名称和 URI 元数据，服务端连接状态用于显示“Connected”。该登记不传文件内容，也不意味着已支持让 Agent 直接读写 VS Code 工作区。
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
- **Three.js 3D 场景**：项目依赖 `three` 与 `@types/three`。Agent 可通过 Preview 项目文件工具生成或修改场景源码，将 Three.js 作为受控运行时依赖打包；构建产物在隔离 iframe 中运行，用户可在 Preview 查看 3D 场景、在 Code 浏览对应源码。该能力是程序化几何/场景代码生成，不等同于生成或编辑 GLB、GLTF、OBJ 等独立模型文件，也不提供完整的 3D 建模器。
- 项目快照保存在服务端 `session_preview_projects`；上传原始附件放在服务器存储，客户端 IndexedDB 用于本机快速恢复。生成文件也使用服务器持久目录。部署时须将 `GOR_STORAGE_DIR` 挂到持久卷；多实例应挂载共享存储。
- **源码与产物的持久化机制**：当前采用“数据库保存可恢复的项目快照 / 文件系统保存原始二进制文件”的分层方式，不是把所有文件都塞进同一张数据库表。
  - 助手生成或用户导入的可编辑虚拟项目，以会话为粒度保存到 PostgreSQL 的 `session_preview_projects`：`session_id` 唯一对应一份最新快照，`project` 使用 JSONB 保存项目名称、模板和 `{文件路径: 文件内容}` 文件集；同时记录来源 `origin`（`generated` / `uploaded-source`）、上传名称、递增版本 `revision` 和更新时间。前端在项目状态变化后调用 `PUT /api/chat/session/{session_id}/preview-project`；服务端校验文件路径与内容后 upsert。重新进入会话时通过同一路径的 GET 接口读取快照，恢复 Virtual FS，因此刷新或跨设备访问时不依赖浏览器内存中的源码状态。
  - 上传附件（包括 ZIP、普通文件及打包后的文件夹）先写入 `GOR_STORAGE_DIR` 下的上传目录；PostgreSQL `session_attachments` 只记录附件 ID、所属会话、名称、类型、相对路径、MIME 类型和大小。聊天消息保存附件引用，下载时服务端按会话与附件 ID 查元数据，再从存储目录读取文件。前端 IndexedDB 是本机快速恢复缓存，不是跨设备的权威数据源。
  - 助手生成的可下载文件（例如文档、表格、演示文稿）写入 `GOR_STORAGE_DIR` 下的生成文件目录，消息中保存展示信息和下载 URL；请求下载时由 `/api/download/{filename}` 从服务器文件目录返回。它与 Preview Project 的 JSONB 源码快照是两种不同的持久化对象：只有项目快照中实际存在的文件才可在 Code 中浏览，二进制附件或生成文件不会为了展示而自动转换/生成源码。
  - Preview 文件树的显示/隐藏属于会话界面状态；隐藏某个条目不等于删除服务端附件或源码快照。若用户从聊天消息再次打开该附件/产物，可重新加入当前 Preview 列表。删除会话时，服务端会清理关联的 `session_preview_projects` 快照；文件目录的持久性仍取决于 `GOR_STORAGE_DIR` 是否映射到持久卷。
  - **边界说明**：`session_preview_projects` 当前是“每个会话一份最新项目快照”，`revision` 用于版本递增但没有保存完整的历史快照序列，不能据此回滚到任意旧版本。生成文件通过文件目录和消息引用持久化，也不等同于独立的、不可变的 `artifact_snapshot` 版本库。若未来需要历史版本、产物级隐藏状态跨设备同步或可靠回滚，可新增 `artifact_snapshots` / `artifact_files`（或版本表）及会话产物关联表，并在数据库事务中维护快照元数据与文件存储键。
- Preview Project 与 `PROJECT_WORKSPACE_ROOT` 下的真实 Web 工作区是两套能力：默认 Agent 编辑的是虚拟项目；真实工作区工具仅在显式启用时提供，并执行路径校验。

#### 通用 Project API 与源码按需上下文

- Agent 文件工具通过 `ProjectAPI`、`ProjectProvider`、`ProjectRef` 和 Provider Registry 抽象项目操作；当前接入的 Provider 是 Preview Project，负责把通用操作适配到现有 Preview 项目服务。Provider 接口预留版本查询和能力声明，可供后续其他项目源实现；VS Code 工作区 Provider 尚未实现。
- 当前 Preview 源码链路提供文件清单、代码搜索、按行范围读取、精确补丁、批量补丁和文件写入。默认先返回搜索命中及少量上下文，仅在定位不足时扩展读取；工具结果受结果数、行数、字符和 Token 预算限制，并输出 revision/version，避免每轮把项目所有源码发送给模型。
- 文本文件采用通用 exact-text 匹配，不解析具体语言语法。补丁要求 `old_text` 唯一命中并校验预期 revision；目标不存在、不唯一或版本冲突时拒绝写入。批量补丁用于同一请求的多文件修改，随后沿用当前 Preview 的 diff、项目持久化与 UI 流程；二进制文件不走文本 patch。
- Project API 是后端项目访问抽象，不等于本地磁盘权限。当前 Preview Provider 只操作服务端会话对应的 Virtual FS；真实工作区读写需要单独的 Provider、安全授权及路径/沙箱策略，不能仅因为抽象接口已存在就认为已接通 VS Code 工作区。

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
| Server | `Server/` | `python main.py` | 默认 `http://localhost:3001`；环境配置见 `Server/.env.example` |
| VS Code 扩展 | `vscode-extension/` | `npm run vscode:prepublish`；开发调试在 VS Code 中按 F5 | 构建 VS Code Webview 与扩展；前端热构建可运行 `npm run watch:webview` |
| Native | `Native/` | `npm start -- --lan` | Expo Go 扫描二维码；手机和开发机需连接同一 Wi-Fi |

核心配置包括 `ARK_*`、`SUPABASE_DB_URL`、各搜索服务 Key、`AMAP_WEB_SERVICE_KEY`、`XIAOYUNQUE_*`、`JUDGE0_URL`、`PROJECT_WORKSPACE_ROOT` 与 `GOR_STORAGE_DIR`。真实密钥应保存在本地环境变量或未提交的 `.env` 文件中。
