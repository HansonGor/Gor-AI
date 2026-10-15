# Gor AI Agent 项目说明

## 0. 开发约束与两端边界（2026-10-07）

修改前先完整阅读本文及涉及模块的 README。根目录 `AGENTS.md` 是开发入口，以下约定必须落实到代码、测试和交付说明；现有代码不是违反约定的理由。

### 实现阅读与最小修改要求

修改代码前，先阅读相关实现，确认现有调用链、调用方、适配器边界和实际副作用，再修改代码。严格遵守本文和适用的 `AGENTS.md`。

1. 优先复用现有组件、接口及业务逻辑，不重复造轮子。
2. 只修改本次需求涉及的文件，禁止无关重构。
3. 不得破坏现有 Web / VS Code 的功能及隔离规则；公共逻辑改动必须检查两端调用链。
4. 修改后运行相关类型检查和针对性测试；代码修改补充相关回归测试，并执行下文对应模块的验收命令。
5. 发现问题必须修复并重新验证后再交付，不能只以编译通过作为成功标准。
6. 不确定现有逻辑时，先说明风险并继续查证，不要猜测实现。
7. 最终简要列出本次修改文件、实际测试结果和未验证风险，不把未运行的检查说成通过。

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
- Diff 窄屏规则（Web 移动端和 VS Code 插件窄侧栏均适用）：沿用现有 1024px PC 断点，小于此宽度时固定 Unified，不显示 Unified / Split 开关；从宽屏 Split 缩窄也必须立即使用 Unified。宽屏保留统一模式切换。布局能力由消息宿主传入 `allowSplit`，纯 Diff 不自行判断端，不改变原始数据、项目权限或折叠状态。
- 共用 Diff 使用 `react-diff-view`，默认 Unified（包括移动端），右上角可切换 Unified / Split；Split 显示原文件/新文件双列，新建或删除的空侧不补造源码。行号靠左并留左边距，行号、增删标记与代码分区排列。Web 与插件共用深色上下文行底色 `#252d47`；新增行保留深绿 `#2c493d`、删除行保留低饱和红底 `#463140`；真实行号及 `+ / −` 标记继续表达各自快照差异。每处修改前后保留最多 3 行已提供的上下文，连续未修改代码超过 6 行折叠中间部分为 `··· 省略 N 行`，邻近修改共用上下文，连续 hunk 自动合并。已接收源码可点击展开/收起；原始 Diff 和消息数据保持不变，但不提供“查看原始 Diff”按钮或折叠入口。旧回执未提供的行明确标记不可展开，不查询当前文件来冒充历史快照；截断/解析失败保留原文。两种模式长行换行，移动 Web/VS Code 窄侧栏不撑宽页面；展示组件不调用文件或 Preview API。
  - 控件位置：Unified / Split 只在本组“本次变更”标题右侧显示一次，并仅在展开 Diff 时显示，由 `ProjectChanges` 统一控制该消息的所有文件，不同消息独立。每个文件的图标、文件名与状态位于折叠标题栏，原路径保留 tooltip，新增/删除行数保留无障碍标签，不在 Diff 内重复展示；文件折叠状态与上下文展开状态不因模式切换重置。此前集中控制验收验证过 6 个文件同步切换及窄屏不横向溢出；截图：`.runlogs/diff-ui-group-toolbar.jpg`，并非当前汇总皮肤截图。
  - 文件变更汇总 UI（方案 C，2026-10-10）：深蓝圆角容器、状态计数和并排批量接收/撤销胶囊保留；文件列表采用轻边框紧凑圆角行。左侧依次为 180ms 旋转箭头、低饱和扩展名徽章、文件名及状态；点击左侧均展开/折叠，默认全部折叠、允许多个展开。右侧撤销是独立点击目标，不触发展开。窄屏文件名/状态可分行，长名换行，按钮不挤占或重叠；移动端仍 Unified-only。待接收柔黄、已变更浅绿、已撤销灰蓝并仅显示完成图标。宿主注入已有 ChangeSet client，组件不直接访问文件系统；仅 sealed/applied 可撤销，批量数统计 applied，操作串行防重复，结果后回读状态而非模拟成功。失败/冲突/部分失败及预览因并发修改未同步通过现有通知反馈。一并落笔仅对 sealed/pending 候选调用统一确认 API；无底部提示、不改原始 Diff、其他聊天布局或背景。两端共用 UI，Web Virtual FS 与 VS Code RPC Provider 不交叉调用。
    - 方案 C 验收：Diff/交互 19 项、Web 撤销客户端/历史关联 5 项、Preview 67 项、插件 27 项通过；Server 相关回归 81 项（1 跳过、5 子测试）及历史关联专项 2 项通过，真实 SSE 连续两轮各自绑定 messageId 的回归通过。Web TypeScript 和两端构建通过。实际浏览器在 1440px、360px 检查默认折叠与展开的文件行，无页面横向溢出或操作重叠；360px 不展示 Split。真实数据库只读验证历史引用投影查询可执行。旧消息没有可靠关联，不能强行启用撤销；新产生的 sealed 记录在后台重载后保存精确关联并恢复。未人工在真实 VS Code Extension Host/用户磁盘执行撤销，未通过浏览器对真实项目执行撤销；双端恢复、冲突、保存失败及部分结果由 Provider/RPC 替身回归验证。既有大 chunk/插件图片路径提示保留。
  - 2026-10-09 Diff 验收：`Web/npm run test:diff` 11 项通过（数据投影、真实 React 组件展开/收起、Unified/Split 切换与两侧行号、新建/删除空侧、修订切换、旧回执缺上下文、原文回退及样式）；预览回归 67 项、类型检查、Web 构建通过；插件测试 17 项、插件构建通过。此前聊天样式/品牌回归 5 项通过。此次真实 Web 会话验证 Split 在请求宽度 1440/480/360/320 下不溢出，浏览器缩放下实际 CSS 视口约 1309/436/327/291，并在最窄视口切回 Unified 验证；效果图保存于本机忽略目录 `.runlogs/diff-ui-modes.jpg`。未在真实 VS Code 宿主中人工操作新 Diff；插件通过共用组件测试与打包验证。
- 新建 Web 项目在离屏状态生成。完整源码同步、生成任务完成且所需产物保存成功后，才发布并展开/切换 Preview Worker；部分文件、失败、取消不能抢先切换。发布后真实构建失败仍显示诊断，不能把错误永久隐藏。
- Preview 列表按首次创建顺序旧到新，新项目在最下面；编辑不改变创建位置。项目/产物按稳定 ID 去重；名称相同也可能是不同项目。
- Preview、Code、源码包、产物下载必须属于同一选中项目/消息快照；不能使用此前选中 GLB 或全局最新文件集冒充目标源码。Worker 列表可去重或隐藏当前项目的重复快照，但消息入口必须从完整消息集合按 messageId 解析快照，不从去重列表查找，也不按 projectId 替换成最新消息。3D 使用真实 GLB，React 使用网页产物，不互换类型；GLB 名称最多一个 `.glb` 后缀。
- 不恢复默认 React 模板，不发送不存在的默认项目快照。普通聊天不显示空 Worker；插件不挂载 Worker。旧消息可重新打开自己的产物，Worker 清除是软隐藏，不是物理删除。
- 聊天气泡简述实际完成了什么、内容主题及查看入口；源码、逐行修改只放 Diff，不在回答中重复代码。未成功写入、保存或构建不得宣称完成。

### 修改前后验收

复原确认弹窗（2026-10-11）：Web/插件共用 `UndoConfirmModal`，只负责 single/batch 确认展示。单文件标题“是否复原此番改动？”，显示工具回执完整路径，说明“将此番复原至落笔前的版本。”；批量标题“此番笔墨，是否悉数收回？”，描述“共涉 N 卷，皆将复归落笔前的模样。”，N 为当前 ChangeSet applied 数量，不列路径。深蓝紫半透明玻璃、柔紫边框、复原/叠层图标、关闭按钮及“暂且保留 / 复归如初”双按钮；无底部辅助提示。列表按钮只打开确认，确认才调用既有 undoFile/undoChangeSet；取消、关闭、Esc/遮罩不执行；执行期间禁用按钮及关闭/Esc，沿用现有请求锁、状态回读和错误提示。不修改 Diff、Provider、文件保存或撤销底层逻辑。

公共展示文案（2026-10-11）：上述方案 C 的历史设计用语在当前界面统一为“此番落笔 · 九卷留痕”（数量随实际文件数转中文数字），pending/applied/reverted/rejected/applying/undoing/failed/conflict 分别显示“待落笔 / 已落笔 / 已复原 / 未落笔 / 正落笔 / 正复原 / 未落成 / 内容有异”。按钮用“一并落笔 / 一并复原 / 复原”；两个顶部批量按钮按原生 disabled 区分颜色：可用背景 #29344F、边框 #526080、图文 #D9D2F2，禁用背景 #202A42、边框 #34405A、图文 #7986A0；仅可用时 Hover 轻微提亮背景，150ms 过渡，不加发光/渐变/缩放或明显阴影。顶部批量按钮高 44px，字号 PC 15px / 窄屏 14px，行高 22px；图标、文案、数量及原有操作 Loading 不变，右侧单文件按钮保留原样式；接收通过统一确认 API 处理审阅候选。成功通知的图标和文字作为一组居中显示，图文间距紧凑，关闭按钮独立靠右。源码入口“阅览源码”，副文案 `展卷寻其源  墨韵见初心`，预览副文案 `推窗见新景  笔墨生诗意`；中间为两个半角空格，无逗号或句号，样式保留空格并维持单行省略。只改展示，不更名持久化状态和 API，也不改旧消息正文。

会话初始化（2026-10-11）：不按日期自动新建。优先打开有效 sessionId 链接，其次恢复本端最近选用的有效会话，再回退到 updated_at 最新会话；Web 与插件分别使用其已有 user_id 命名空间记录最近会话。仅成功读取的列表为空时初始化新会话，读取失败不得当作空列表；用户主动点击新章仍可创建。验收命令：Web 下 `npm run test:session`（真实 useSession Hook 的跨天、命名空间、链接优先、失效引用和请求失败测试）。

弹窗验收：Web `npm run test:diff` 21 项、`npm run test:preview` 67 项及类型检查/构建通过；插件 `npm test` 27 项、`npm run vscode:prepublish` 通过。浏览器隔离预览核对 single/batch 视觉与 360/480/1440px 无横向溢出；组件回归覆盖确认前不调用、取消/关闭/Esc、执行期禁用及部分失败回读。未在真实 VS Code Extension Host 中重新实测撤销文件；本次不改变底层撤销与保存逻辑。

关闭命中修复（2026-10-10）：顶部装饰区曾覆盖关闭按钮下部，浏览器命中检查可复现。关闭按钮增加独立层级，纯装饰区禁用 pointer-events，保留执行期间禁用关闭规则。桌面与 360px 实际点击原遮挡位置均关闭成功；相关 21/67/27 项回归及两端构建重新通过，未操作真实文件或重测 VS Code 宿主。

1. 写清本次端范围、关联模块、沿用规则和预期副作用；先找现有实现，不复制一套逻辑。
2. 针对改动补测试：Web / 插件隔离、自动导出无文件 IO、项目创建/编辑/取消、快照源码配对、列表顺序、后缀和旧数据兼容。公共逻辑至少验证两个宿主。
3. Web 执行 `npm run test:preview`、`npx tsc --noEmit`、`npm run build`；公共 UI 或插件修改再在 `vscode-extension` 执行 `npm test`、`npm run vscode:prepublish`。
4. Server 使用虚拟环境 UTF-8 Python 执行涉及模块的 pytest。存储改动额外覆盖无目录创建/写入、虚拟二进制下载、大小/格式校验、消息事务关联及删除会话跳过空磁盘路径。
5. 交付说明用通俗语言说明变化和实际验证范围；记录限制，不以测试通过承诺永不回归。更新本文应修正旧段落，不能保留互相冲突的现状说明。

### 提交前核对与验收（2026-10-09）

- 本批包含公共工具协商、独立 GitHub 搜索、资讯正文与来源整理、聊天字号/品牌展示，以及 Web React 入口和预览背景兼容修复；Web Virtual FS 与 VS Code 当前工作区边界保持不变，具体规则见下文对应模块。
- Server 离线验收：`venv\Scripts\python.exe -X utf8 -m pytest tests --ignore=tests/test_project_generation_db.py --ignore=tests/test_context_engine_db.py -q --tb=short`，350 项通过、1 项跳过、36 子测试通过。两个真实数据库集成测试文件未执行。
- Web：`npm run test:preview` 67 项通过；`node --test scripts/markdown-styles.test.mjs scripts/message-bubble-brand.test.mjs` 5 项通过；TypeScript 检查和 Web 构建通过。VS Code：`npm test` 17 项通过，`npm run vscode:prepublish` 通过。构建仍有既有大 chunk 和插件图片路径提示。
- 离线测试与构建不代表所有真实模型、外部搜索服务、数据库集成及 VS Code 宿主均已人工验收。Git 提交包含当前全部非忽略代码、文档、测试及已跟踪插件资源；不强行纳入 `.env`、依赖、运行日志或用户存储产物。

### 历史核对结果（2026-10-07）

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

#### Markdown 代码高亮（2026-10-13）

- 普通聊天、历史回复和分享图片复用 ReactMarkdown 的 pre 覆盖组件 MarkdownCodeBlock；行内 code 保留原样。Shiki 3 的 Dark+ 配色配合既有深蓝紫圆角背景，标题栏显示声明语言和复制按钮，成功状态保留约 1.8 秒；复制异常显示失败，不假报成功。分享模板只显示语言标签，不导出复制交互。
- Web 独立模块 Worker 使用 Shiki core 与 JavaScript RegExp engine，在本地按需导入主题和 TS/JS/TSX/JSX/Python/HTML/CSS/JSON/SQL/Bash/Vue 语法。VS Code Webview 通过入口注入专用 Blob Worker：核心、引擎和 Dark+ 打包为单文件，所需语法由 Webview 按需加载后传入，Worker 内不执行动态导入。同一 Worker 每种语法只传输一次。无语言、未知语言、Worker/加载失败和超限代码降级为完整普通文本。高亮 token 通过 React 文本节点与受控颜色渲染，不插入原始 HTML，不上传源码或调用 LLM；不放宽插件 CSP，不改变 Diff、工作区 API 或 Web Preview Worker 边界。
- SSE 流式阶段先显示最新原文，在 250ms 静默窗口后高亮；停止流式时立即请求高亮，取消过期组件更新，旧结果不覆盖新内容。相同语言/源码共享任务，LRU 限制为 32 项及约 500,000 字符键预算；单块超 100,000 字符或 2,500 行保留原文但不执行高亮。Worker 15 秒超时/异常时回退，之后可重试。普通聊天长行横向滚动；分享图片按同样 token 配色换行，保证长行内容不被图像裁切。导出在字体/图片加载之外等待每块高亮或回退状态提交完成。
- 首版 Markdown 高亮验收：Web npm run test:code；代码高亮 6、分享 18、Preview 70、Markdown/品牌 6、插件 29 项通过，共 129 项。Web TypeScript 和 Web/插件构建通过，保留既有大 chunk 及插件图片路径提示。真实浏览器示例验证颜色、复制成功、未闭合流式、600 行代码，以及 360px 页面宽度未溢出；真实分享 PNG 1500×2370 已目视检查高亮和完整正文。测试夹具 Web/scripts/code-highlight.fixture.html 使用示例内容，不发送真实 Agent 请求；未在实体手机与真实 Extension Host 人工验收。截图 .runlogs/shiki-code-blocks-desktop.png 与 .runlogs/shiki-code-blocks-mobile.png。

- 扩展到 Diff 与 Preview（用户确认，2026-10-13）：CodeDiff 沿用 react-diff-view 的 tokens/renderToken，仅为提供的 before/after 行添加 Dark+ 前景色；按原始行号映射，缺失上下文分开处理，不读取当前项目源码或补造缺失行。Unified/Split、增删背景、行号、折叠、Diff 原文及撤销回调保留。未知扩展名及超限片段按普通文字显示。
- PreviewSourceViewer 实际使用 Textarea，不是 Monaco。保留原有值、onChange、拼写检查设置及原生选择/编辑，以 aria-hidden、pointer-events:none 的 pre 颜色层叠加文字；字号、行高、padding、tab-size、white-space 与原输入相同，只改变可见文字的前景色。按实际路径识别语言，250ms 静默后复用现有 Worker，高亮到达前显示当前原文，过期文件结果忽略；横纵滚动同步颜色层和原行号。尾部零宽字符仅用于颜色层保证空行高度，不进入源码或编辑回调。代码编辑继续使用原 Web Virtual FS 写入链路，插件不接入 Preview。
- 本次扩展验收：高亮 9、Diff 25、Preview 70、分享 18、插件 29 项通过，共 151 项；Web 类型检查和两端构建通过。浏览器示例实测 Diff 两种视图高亮、Preview 中文输入和垂直滚动同步，颜色层字体/字号/行高/padding/tab-size 与 Textarea computed style 一致。未在实体手机或真实 VS Code Extension Host 人工操作；既有构建提示保留。效果图 .runlogs/shiki-diff-preview-desktop.png。真实历史会话只读打开 Code、选择 App.jsx 和展开 HTML Diff，两处均显示高亮，未编辑文件或执行撤销；截图 .runlogs/shiki-diff-preview-real-chat.png。示例编辑器横向滚动实测输入及颜色层 scrollLeft 均为 816.67px。

- 插件高亮适配验收（2026-10-14）：test:code 13、Diff 25、Preview 70、分享 18、插件 29，共 155 项通过；Web 类型检查、Web build 与插件 vscode:prepublish 通过。回归覆盖全部 11 种语法、结构化克隆、语法只传输一次、关闭期间启动与加载失败降级。生产构建的严格 CSP 浏览器夹具确认聊天 TSX/Python/JSON、Diff 颜色、复制及视图切换正常，无控制台警告/错误；截图 .runlogs/shiki-vscode-strict-csp.png。插件仅复用聊天 Markdown 与 Diff，不挂载 Web Preview 或开放分享。真实 VS Code Extension Host 尚未人工验收，也未安装新的 VSIX；已更新本地插件构建产物，需重启扩展开发宿主或重新加载使用该构建的窗口。既有大 chunk 和图片路径构建提示保留。

#### 对话上下文与 Agent 调用控制

##### 共用 ThinkingPanel（2026-10-12）

- 思考展示沿用 `Thinking Adapter → Thinking Event → 现有 SSE → ThinkingPanel`。`Server/models/thinking.py` 保留兼容模型返回的 reasoning_content 和结构化思考/摘要字段；低温度工具模型以流式传输观察思考，Agent 仍通过 ainvoke 取得完整回答和工具决策，不另建工具循环。不再额外调用模型生成标题/摘要。Adapter 复用模型的实际阶段、保守意图提取和 Provider 可展示摘要；真实工具开始、结果及文件回执由 ThinkingTrace 投影为 thinking_update，沿用 SSE 与 JSONB 历史。优先级为真实工具 > Agent 阶段 > 模型可展示内容。无法确定时显示“思考中”，无摘要不显示正文或占位，不展示原始内部推理。Token 回调兼容流式 usage_metadata，沿用原有额度统计。
- 每次实际模型调用发送 thinking_start / thinking_delta / thinking_end，roundId 在本条助手消息内标识调用。thinking_end 只结束单次模型调用；整轮 Agent、源码保存与 ChangeSet 封存流程结束后的 done 才将面板折叠为“思考已完成 / 共 N 轮思考”。失败、取消和中断保留收到的内容并显示实际状态，不以单轮结束或网络 EOF 推断成功。
- 运行中自动展开最新一轮；此前轮次合并为“此前思考 · N 条”并默认折叠。新 roundId 自动收起上一轮、展开新一轮；同轮增量与 thinking_end 不重置用户折叠状态、不触发消息列表滚动。模型调用结束后、下一轮开始前的实际工具事件归属本轮；新轮开始会冻结此前记录并清除旧工具关联，迟到的带旧 roundId 事件或未配对工具结果不改写历史。完成卡片沿用 Gor 品牌栏与深蓝紫玻璃风格，包含 Lucide BookOpenCheck、标题、副标题和右侧箭头；点击展开全部历史标题，每轮历史细节默认折叠、可分别展开，再次点击收起。每轮标题栏只显示标题，不显示副标题；展开后的摘要区首先显示本轮当前真实任务摘要，再保留此前收到的真实工具观察，去除与当前摘要相同的记录。无可靠摘要不编造说明。每轮标题使用实际内容概括的动作，不显示轮次或固定完成副标题。没有执行状态手动切换按钮或独立思考气泡。旧记录没有摘要时保留原始记录但不展示原文、不自动额外请求补译。
- 思考记录独立存入 chat_messages.thinking_trace JSONB，不混入正文、后续模型上下文、ChangeSet 或 Diff。历史恢复默认折叠，未终结记录显示中断，旧消息没有记录时不补造思考。ThinkingPanel 仅接收 props，在 Web、VS Code Webview 和移动端共用，不访问 Provider、文件系统或 Preview Worker。文件操作、工具结果、确认及复原继续走原有链路。
- 验收增加 Server `venv\Scripts\python.exe -X utf8 -m pytest tests/test_thinking.py -q` 和 Web `npm run test:thinking`，并运行现有 Preview、Diff、会话、ChangeSet、类型检查、两端构建及插件测试。五轮模型调用、SSE 顺序、同轮折叠保持、失败/取消内容保留、历史恢复和滚动隔离均由回归覆盖；实际模型增量接收另行核对。独立浏览器夹具仅验证共用组件布局，不冒充真实用户会话端到端验收。
- 首版历史验收（以下为首版记录，不代表本次优化重跑）：Server 相关回归 142 项、7 子测试通过，1 项 Vite 联机用例跳过；Web 思考 5、Preview 69、Diff 25、会话 5、ChangeSet adapter 6、模式选择 8、品牌/入口文案 2 项通过，TypeScript 与 Web 构建通过；插件 27 项与 prepublish 通过。当前真实模型收到 14 次思考增量且 Token 统计正常；数据库独立事务验证五轮历史读回及正文/Diff 保留后已回滚。桌面和 360px 共用组件夹具无横向溢出，完成卡片截图位于 `.runlogs/thinking-panel-completed.jpg`。未在真实用户会话执行线上模型五轮工具链，未手动验收真实 VS Code Extension Host、手机设备或其他 Provider 全流程；既有构建提示保留。进程突然退出前尚未持久化的增量不保证恢复。

- **思考标题与摘要按真实参数和回执生成（2026-10-15，公共能力）**：`Server/models/thinking.py` 不额外调用模型、不展示原始推理，只用工具参数与真实回执说明每一步。标题带参数以区分同类调用：读取带行号（“读取 project.md 第 236–245 行”）、代码搜索/联网检索带查询词（“搜索「2026-10-15」”）、`git_status` 带差异时为“读取改动差异”、提交列出文件或“提交全部改动”、读网页带篇数。摘要按工具解读回执：Git 状态（分支、领先数、各类文件数、未保存文件、差异是否截断）、提交（文件数、分支、提交号）、推送（提交数、目标、是否设置上游）、读取（行范围与总行数）、搜索（匹配数与文件数）、文件清单数、联网来源数、网页读取成功/失败篇数。`USER_CANCELLED` 显示为用户取消、未做改动；失败附回执错误原因；无法识别的工具仍显示“已返回结果，尚未确认是否成功”，审阅模式待确认修改仍显示尚未写入。提交/推送进行中显示“正在等待你在 VS Code 确认框中确认”。
  - 最后的 `final_response` 阶段：`ThinkingTrace` 记录本次运行已完成工具的结果，按推送 > 提交 > 修改 > 生成 > 检索 > 查看选择标题（如“汇总提交结果”），摘要为“结合 N 项工具结果向你说明（其中 M 项未成功）：<关键结果>”。改写发生在同一事件对象上，SSE 与持久化记录一致；没有工具结果时保留“整理答复”。其他阶段文案不变。共用图标映射为 `git_status` / `git_commit` / `git_push` 及“汇总提交/推送结果”使用 GitBranch。
  - 验收：Server `tests/test_thinking_presentation.py`（复现会话 1db36e00 的 7 轮调用序列、Git 取消/失败/推送、搜索/清单/网页/联网摘要、最后阶段命名与回退）、`test_thinking.py` 及完整离线 pytest；Web `npm run test:thinking`（含 Git 图标）、Preview、TypeScript 与构建；插件 `npm test` 与 prepublish。仍不能说明模型“为什么”做某一步（需模型自行提供目的，属后续第二步）；旧会话的历史记录不会被重新生成。
- 动画使用现有 Less/CSS Grid：高度与透明度 250ms ease-out，箭头轻转，摘要首次出现 180ms 淡入；收起期间保留节点 260ms，隐藏区设置 inert 与 aria-hidden，不新增动画依赖。prefers-reduced-motion 下关闭动画及过渡。与思考卡片重复的工具状态只隐藏展示，不改工具事件回调。
- 思考图标集中维护于 Web/src/utils/thinkingIcons.ts：真实工具名称优先，再匹配已确定的阶段/任务标题，思考中、整理答复等通用阶段及无可靠匹配时用 PencilLine。支持 Search、FileSearch、FolderSearch、ListTodo、FilePenLine、GitBranch、Terminal、Bug、ListChecks、Hammer；计划修改仍用 ListTodo，真实编辑工具才优先 FilePenLine。单轮图标 18px / 1.7px 淡紫色；完成为 BookOpenCheck 20px / 1.7px、#C5B3FF，失败/取消/中断仍用 Brain。图标和标题只在身份变化时 180ms 淡入，摘要更新不重启，不新增模型调用或依赖。
- 铅笔图标与摘要位置调整验收（2026-10-12）：仅调整共用 UI，不改变 Adapter、SSE 或 Agent 逻辑。标题栏不再显示任务说明，当前摘要移入展开正文首段，历史观察保留且不重复当前摘要。Web 思考 13 项、Preview 69 项、TypeScript 和 Web 构建通过；插件 27 项与 prepublish 通过，git diff --check 通过。回归验证 PencilLine 默认/整理答复图标、真实工具图标优先、当前摘要不重复、延迟摘要出现、快速更新保持手动折叠，以及历史默认折叠。未重新执行线上模型、浏览器人工视觉、真实 Extension Host 或实体手机验收；既有大 chunk 与插件图片路径提示保留。
- 本次动态展示与图标优化验收（2026-10-12）：Server 思考、Preview 上下文、场景提交、项目变更与审核相关回归共 50 项、7 子测试通过；Web 思考 13、Preview 69、Diff 25、品牌展示 2 项，共 109 项通过，TypeScript 与 Web 构建通过；插件 27 项与 prepublish 通过。回归覆盖五轮自动折叠、标题延迟、摘要缺失及快速更新、图标映射、失败/取消、迟到事件和 SSE 两端传输。共用组件浏览器夹具在桌面和 360px 窄屏无横向溢出，确认单轮图标 18px、完成图标 20px、线宽 1.7px、完成色 #C5B3FF；截图为 `.runlogs/thinking-icons-history.jpg`。未执行真实线上模型五轮工具链，未实测 VS Code Extension Host、手机设备和全部 Provider；既有构建大 chunk 与图片路径提示保留。详细修改与命令记录位于 `.runlogs/thinking-progress-icons-report.md`。

##### 对话工具与上下文策略

- **公共历史上下文（2026-10-14）**：Web 与 VS Code 共用 Server `ContextEngine`，当前请求单独完整保留，不进入摘要。历史正文、已有摘要及当前请求估算达到 30,000 Token 后，近期历史按完整用户问答轮次保留在 10,000 Token 预算内，其余旧轮次增量压缩；未达到阈值时保留所有尚未压缩的历史，不按 29 条静默截掉。超长旧轮次单独完整送入压缩，不能截取原文冒充完整历史；极长轮次仍可能超过模型容量，失败按下面规则降级。摘要优先保留预算、日期、数量、用户要求、已确认决定及未完成事项；摘要与游标仅在整批压缩成功且保存成功后更新。原始聊天消息不修改，锁仅保障同一 Server 进程内的同会话串行压缩。
  - 压缩或保存失败保留上次成功摘要、按预算选择完整近期问答，不回退到固定最近 29 条；摘要加载失败则没有可用旧摘要。未附带且未被摘要覆盖的历史会向模型明确标记缺失，依赖该细节时应询问，不猜测或伪称记得。降级不推进摘要游标，下次可重新尝试。
  - 每次 Agent 模型调用通过 `[LLMInputBudget]` 统计系统提示、历史摘要、近期正文、当前请求、任务数据、工具结果、Agent 响应及已绑定工具定义的估算 Token，并记录输出预留和当前配置的上下文容量。文本估算不等于 Provider 精确计费，也不包含图片的实际视觉 Token；只记录数量，不记录正文、参数或推理。公共历史压缩本身不裁剪工具调用、源码、网页或 PPT Schema；项目读取/PPT 等任务内精简按各自专节执行，不改变工具能力和端间隔离。
  - 验收：Server `venv\Scripts\python.exe -X utf8 -m pytest tests --ignore=tests/test_project_generation_db.py --ignore=tests/test_context_engine_db.py -q --tb=short`；公共变更同时运行 Web TypeScript、Preview 测试和构建、插件 `npm test` / `npm run vscode:prepublish`。专项测试见 `test_context_engine.py` 和 `test_agent_diagnostics.py`；真实摘要语义质量、跨 Server 进程并发及 Provider 实际容量需另行验证。

- **项目文件任务内上下文精简（2026-10-15，Web / VS Code 共用）**：`agent/project_read_context.py` 接在现有工具结果进入模型消息的位置，按 Provider、项目 ID、实际 root、规范化路径、完整文件状态和实际行范围建立任务内 readRef。初次读取保留正文；同版本重复范围引用此前正文，重叠范围只向模型补缺失行；很短的内容若引用反而更长则保留原文。原始回执、SSE、回调、文件、Diff 和 ChangeSet 不被裁剪，不跨任务/会话保存缓存，不额外调用 LLM。搜索后程序自动合并的 Web 范围读取也走同一规则。
  - 只复用适配器提供可靠 readState 的完整、未截断范围。范围不会当作全文；空文件和最后空行按实际行号处理。每次模型调用前按文件通过原 Provider 的真实读取重新核对状态，状态变化/验证失败时撤销旧正文及所有旧引用，明确提示重新读取；发生本轮文件操作时保守失效当前项目读取上下文。缓存只代表模型正文复用，不跳过工具真实读取、权限校验或写入的 expected_version。旧插件、审阅候选或非 UTF-8 编码等无法确定状态的结果保留原文，不启用复用。
  - Web readState 来自当前请求的 Virtual FS：项目 revision 加完整文件 SHA-256。项目版本、文件内容变化以及删除/重建会使旧引用失效；不读取开发机文件，也不使用插件 Dirty 规则。读取和状态计算间没有 await；其他请求仍受现有持久化版本提交保护。
  - 插件 readState 来自实际 TextDocument：文件身份摘要、version、isDirty 和完整缓冲区 SHA-256。Dirty 文档依据内存正文；干净 UTF-8 文档额外读取磁盘核对，Git/终端改动尚未同步、读取过程中发生用户编辑时返回 VERSION_CONFLICT，旧引用失效后可重读；编码无法可靠核对则保留原有编辑器读取但禁用上下文缓存。沿用原工作区隔离、路径保护、Dirty 写入拒绝、WorkspaceEdit、变更监听与并发保护；不把缓存命中当成写入许可。
  - `[ProjectReadContext]` 记录读取/重复读取、引用命中、部分命中、校验、失效、冲突，以及原始/精简后的估算 Token。首次 readRef 元数据可能增加少量 Token；节省量是文本估算，真实计费用量继续看现有 LLM 诊断。安全优先的真实读取与磁盘核对会增加部分 IO，不能据此承诺耗时下降。源码、宿主路径和工具参数不写入这条统计日志。
  - 验收增加 `tests/test_project_read_context.py` 与插件 workspace-files 测试，覆盖重复/重叠/范围升级、版本/全文指纹变化、旧引用撤销、任务/项目/root 隔离、旧适配器降级、两端 Agent 原始回执保留、Dirty 缓冲区、外部磁盘变化及读取并发。公共验收继续运行完整 Server 离线 pytest、Web Preview/TypeScript/build、插件 npm test/prepublish。真实模型任务质量、Extension Host 和大工程 IO 延迟需另行实测。

- **工具可发现性与按需调用（2026-10-08，公共能力）**：所有聊天模式每轮默认传入 `web_search` 与 `search_images`，包括闲聊、简短追问、文档和项目编辑；它们不是兜底工具。Web Preview / VS Code 模式同时默认提供当前 Provider 支持的公共项目工具，以及 Word、Excel、PPT、PDF、视频内容生成工具；是否调用由模型根据本轮需求及上下文决定，不再因动作词未命中或 SIMPLE_EDIT 快速路径裁掉这些工具。工具可用不等于必须执行或取得任意写入授权；Provider 能力、连接状态、版本校验与用户要求仍须遵守。天气、Python 执行、私有知识库等其他工具继续按原意图规则开放。
- **模型主导的工具协商（2026-10-08，已接入公共 Agent）**：用户发消息 → 提供当前宿主默认工具和简短能力目录 → LLM 按上下文拆分复合任务并选择工具 → 默认工具不足时调用 `request_tools` 申请补充已有能力 → 系统校验后补充下一轮模型绑定的工具，再由 LLM 继续执行 → 根据实际结果简述完成项、限制和查看入口。补充能力不依赖再次命中一组严格关键词，不以节省 Token 为由直接拒绝；完整已登记任务能力可发现，完整 Schema / 专门规则按需加载。此实现不修改已有提示词卡片原文，也不改变其他工具的默认触发规则。
  - `request_tools(tool_names, reason, subtask?)` 默认提供给所有模式；可一次申请多个工具名或能力组。返回新增、已提供、不可提供的工具及具体原因；已提供 Schema 和相同专门规则不重复加载，同轮缓存失败原因。每次最多申请 24 项，原因与子任务限制长度，不携带源码或凭据；无效/取消申请不扩充工具。同一个模型调用批次不能使用刚申请的新工具，必须收到申请结果后在下一轮调用。工具申请不代替任务执行，返回 `task_executed=false`，不能声称任务已经完成。
  - 系统只从已登记工具中补充，校验当前宿主、Provider 能力、项目上下文和用户“不联网”等约束；实际连接、权限与版本仍由 Provider 执行时校验。不自动安装新工具、申请新权限或跨端降级。缺少 GitHub/视频/知识库配置时返回具体原因；凭据有效性和外部服务故障由实际调用结果确认，不能把配置存在说成服务一定可用。补充的专门规则复用已有卡片，旧“GitHub 由 web_search 内部执行”的卡片仍不注入。
  - 工具无法提供时沿用默认处理：用现有允许工具继续完成可完成的部分；目标缺少必要信息时只询问缺失信息，缺少关键能力时如实说明未完成项及可行下一步。不能编造成功、把网页实现冒充 GLB、把源码贴满气泡，或要求用户重复开通实际已连接的能力。整理结果时区分完成、部分完成、失败与取消，按工具回执简述，并指向 Preview / Code / Diff 或实际附件。
  - 复合搜索可以组合新闻、GitHub 和普通搜索工具，前一轮结果表明还需其他检索能力时可申请补充；不是只允许一次选一个 Skill。生成或复合请求不因第一次写文件成功就提前结束，模型继续消费工具结果、完成剩余步骤；只有程序已验证的单一文本替换保留无需最终模型调用的快速路径。“把旧文案改成新文案，再查询/生成……”等复合句不走单一替换路径，避免把后半句写进文件或漏掉后续任务；引号中的连接词仍可作为文字替换。气泡保持无源码摘要，额外子任务区分实际确认完成、失败和仅调用，未提供能力追加具体限制；结果或附件查看入口保留。
  - `“创建简单 react-demo 和 3D 模型”` 的目标仍是两个独立项目 ID 和文件集，分别绑定源码、产物和状态，只有准备完整的项目才可发布。但当前单次 Agent 仍只绑定一个 Preview Workspace：能力目录明确标记 `independent_projects` 不可用，申请返回分轮创建说明；执行层阻止向 React 项目新增独立 SceneSpec、向 SceneSpec 项目新增 React 入口或同批混写。失败不改原文件；历史混合快照的既有文件和无关样式仍可编辑，不清理旧产物。插件仅在授权工作区处理源码，不能为完成复合任务加载 Web Preview 或自动 GLB 导出。单次工具成功不能代表所有子任务成功。
  - 节省 Token 的顺序是复用能力目录与已加载 Schema、按需加载专门规则、复用有效目录树/搜索结果、读取必要源码范围及避免重复调用；不能删掉默认工具、跳过复合子任务或在能力不足时默默结束。保留取消、循环上限和重复失败保护，但它们用于防失控而非一刀切缩减用户能力。
  - `[ToolNegotiationAudit]` 已记录 `requested_tools`、`added_tools`、`already_available`、`unavailable_tools`、`denial_reasons` 与 `subtask`；真实调用仍由工具事件及 Routing Audit 表示，不把工具已加载记成已经使用。回归见 `Server/tests/test_tool_negotiation.py`：两端补充后真实重新绑定、多工具执行、缺少凭据、重复申请、取消、跨端拒绝、同批未绑定调用拒绝、生成写入后继续申请、混写拒绝和旧快照兼容。
  - **剩余限制**：通用工具协商已实现；同轮独立创建多个 Web 项目尚未实现。后者还需多子任务项目上下文、消息快照与发布流程，不能仅靠增加工具 Schema 宣称完成。本次明确拒绝混写，不代表多项目发布功能已验收。
- **联网 skill 与能力保底（2026-10-08，Web / 插件共用）**：发布新模型、新版本、近期动态等时效性问法与短句追问按当前用户内容及最近用户主题识别，注入联网规则和真实 `web_search` 工具，并传入当日 Asia/Shanghai 日期。历史助手声称“没有联网工具”不能影响本轮能力。时效性路由先搜索再回答；模型未调用工具却返回记忆答案或错误否认联网时，阻止该答复，最多提醒重试一次，仍不执行则明确报告未完成查询。来源由实际工具结果通过 `search_sources` 返回，搜索失败/无结果不得说成“没有新发布”。
- **Skill Router 与 Search Planner（Web / VS Code 共用）**：搜索和回答语言跟随用户；新闻地域独立判断为国内、国际、全球或指定地区，默认未限定地域的新闻采用国内+国际来源池。新鲜度参与检索排序，不设固定 3 天截止，也不因超过 3 天就排除仍能回答问题的材料；查询词按用户语言加入当前日期锚点，但不附加固定时间窗。最终按实际发布日期由新到旧呈现，最新在最前；区分发布时间与事件时间，没有可核实发布日期的内容不标为今日/最新。来源按话题选择：官网、官方发布页、政府/监管/央行/国际组织等一手来源优先用于核实事实，但不是唯一来源；还应检索相关主流媒体、行业/技术媒体、专业博客或产品生态配套网站。尤其查询当前产品/模型版本时，即使官方发布页较早，也要尝试相关独立来源交叉核对；若精选来源池没有独立报道，可放宽到普通搜索发现来源。全球/多地区结果按区域、媒体类别和发布方去重限流，缺少目标区域时自动定向补搜。最多 8 条是返回上限，不是目标数量；明确的 `site:` 仍是硬限制，不扩展域名。
- **新闻/最新版本正文核验与成稿格式（Web / VS Code 共用）**：新闻及“当前/最新版本、近期发布”检索按 `web_search → web_reader → 综合回答` 完成；`web_search` 按用户语言补本地日期，不限定固定新闻时效窗口；优先话题官网、官方发布页、政府/监管/央行/国际组织等一手来源核实事实，并从相关主流媒体、行业/技术媒体、专业博客或产品生态配套网站中选择独立材料补充。新近发布只作为排序信号；当前型号/有效公告即使发布时间较早仍可作为证据，准确区分发布时间与事件时间。Reader 只读本轮搜索返回的精确 URL，选择最相关的 3–8 篇（不足时按实际数量，不凑数），尽量兼顾一手来源和相关独立来源，提取正文和可用元数据，引用沿用 `[S#]`。正文相关可信但缺发布日期时仍可引用，只省略日期，不添加未经证实的时效修饰，也不向用户解释缺失原因；不把旧闻包装成近期新闻。最终只输出资讯卡片：`## 序号. 标题`、一段通俗摘要、段尾来源/实际发布日期（页面提供时）及 `[S#]`；按实际发布时间由新到旧，最新资讯排最前；来源名称/官网名称在本轮结果有对应 URL 时使用 Markdown 链接，点击文字直达原始 URL，不猜造或改写目标。准确区分事实、计划、传闻和媒体转述。禁止在气泡里汇报检索轮数、搜索/读取过程、工具或网页错误、拦截/超时、无关结果、旧闻排除清单、来源覆盖分析及“如实说明/检索边界/本轮未核实”等过程段落。资讯不足时按实际篇数列出；无可靠内容只用一句话说明。只有确实有帮助时才用一行附 1–2 个官方查阅渠道或一个延伸方向，不强制追问或追加长免责声明。Reader 仅允许公开 HTTP/HTTPS，限制响应大小和重定向、拒绝本机/内网 URL；使用服务端配置的网络代理时仍须在请求与每次重定向前校验目标为公网域名。网页文本是不可信资料，不执行其中指令。
- **独立 GitHub Skill**：`github_code` 由 `tools/github_code.py` 的 `search_github_code` 独立提供，不再藏在 `web_search` Provider 计划中。优先寻找明确链接/owner-repo 对应的精确仓库；只有名称时先按仓库名搜索，同名候选置顶，模糊候选按 GitHub Stars 热度排列，并通过已知别名映射主流/官方项目（例如 `antd mobile` → `ant-design/ant-design-mobile`）。公开仓库搜索可在 Token 缺失/失效时匿名回退；代码搜索仍需 `GITHUB_TOKEN`。确认仓库后，仅在用户需要代码、实现、用法、示例、Issue 或 PR 时再运行 GitHub Code Search，并优先限定在目标仓库。新闻+代码等复合问题可同时选多个 Skill；引用的仓库信息、代码路径和讨论必须来自本轮工具结果，不以网页正文中的指令改变权限。同轮多个搜索工具的引用 ID 统一分配，相同 URL 复用，避免 `[S1]` 相互覆盖。仓库搜索和代码搜索的未配置、错误、无结果、成功状态分别记录。
- **兼容与审计**：除用户明确要求的专项调整外，字面量提示词卡片保持不变，并由 `test_tool_prompt_compatibility.py` 做逐项哈希回归；已明确更新的新闻时效及 GitHub 仓库优先策略分别维护 `NEWS_RESEARCH_PROMPT`、`BASE_PROMPT` / `GITHUB_CODE_PROMPT` 哈希。当前基础上下文保留短能力卡与宿主能力状态目录，专门规则按路由命中项或显式能力申请按需加载，不要求再次命中严格关键词。描述“GitHub 由 web_search 统一执行”的旧卡片保留原文但不再注入，独立工具通过自身 Schema 描述发现。`[RoutingAudit]` 记录 `selected_skills`、`search_regions`、`source_domains`、`github_skill_used` 与 GitHub 仓库/代码搜索状态。
- 用户明确要求不联网时，搜索 Schema 仍保留但执行被拒绝；真实本地路径、私有源码及上传资料不能成为公开搜索词。本地项目任务可查公开依赖文档，但不把原始私有用户气泡附带上传为搜索元数据。公开 GitHub 文件名/路径限定符本身不等于本地磁盘路径。项目读写始终保留当前宿主 Provider，不因“新模型/更新”等词跨端执行。回归见 `Server/tests/test_web_skill_routing.py`、`test_search_orchestrator.py`、`test_web_reader.py`，覆盖两端工具路由、时效查询日期提示、权威来源/过期补搜、正文提取与 URL 防护；使用模型、搜索服务替身，不等于线上模型必定遵从或所有服务已实测。
- 搜索流程回归：`Server/tests/test_web_reader.py` 覆盖正文与元数据抽取、URL 限制和最多 8 页；`Server/tests/test_search_orchestrator.py` 覆盖当前版本日期提示、权威来源优先、超过时效阈值后才补充来源和不凑条数；`Server/tests/test_web_skill_routing.py` 覆盖 Web/VS Code 两端均强制新闻/最新版本正文读取。测试用 Provider/模型替身，不等于实时网页服务或线上模型已验收。
- 本次验收（2026-10-08）：Server 离线测试 335 通过、1 跳过、36 子测试通过，命令为 `venv\Scripts\python.exe -X utf8 -m pytest tests --ignore=tests/test_project_generation_db.py --ignore=tests/test_context_engine_db.py -q --tb=short`（排除两个依赖真实数据库的集成测试文件）；Web 预览测试 63 通过、`npx tsc --noEmit` 和 `npm run build` 通过；VS Code 扩展测试 17 通过、`npm run vscode:prepublish` 通过。搜索单测使用 Provider/模型替身，未在线读取真实新闻页面或验证实时搜索服务；未人工重测线上模型与所有外部 Provider。Web/扩展构建有既有大 chunk 提示，扩展构建还有既有图片路径提示。
- Preview 编辑使用专门的精简规则。常见修改先搜索目标并读取小范围源码；代码从当前项目搜索结果或范围读取结果中构造精确补丁。简单明确的旧文本替换走 `SIMPLE_EDIT` 快速路径，普通复杂修改采用批量搜索、必要时合并局部读取，再尽量一次提交多文件补丁；不把整份源码默认塞入提示，也不把工具返回的完整文件复制到最终聊天答复。
- Agent 对简单、普通和修复类编辑设有不同的软工具调用预算；补丁失败时按错误类型重新搜索/读取或回退到常规编辑流程。预算是控制重复工具循环的保护，不代表任何请求都保证一次完成。
- 长会话使用独立的 `ContextEngine` 按 session 增量摘要：摘要与待处理历史估算达到约 30,000 tokens 后，压缩较旧消息并尽量保留约 10,000 tokens 的最近原文；后续压缩基于旧摘要和新增旧消息，不重复概括整个会话。摘要保存在 PostgreSQL `conversation_context`，原始聊天消息不删除；摘要模型失败时回退普通历史，不中断 SSE 对话。

#### 窄屏聊天与会话侧栏

- 聊天图片分享（2026-10-12）：复用右上角 SquareArrowOutUpRight 按钮及原有响应式尺寸/淡紫色样式，接入完整的勾选、PNG 预览和下载。会话准备且历史加载结束后，有非流式 user/assistant 正文或正文图片才显示；内部项目/工具/附件卡片不单独作为可分享正文。支持跨轮次按消息 ID 勾选，始终按原始顺序导出，未选择时禁止生成；返回调整保留勾选，取消/完成/切换会话退出并释放临时资源。输入及 Agent 工具逻辑不变，分享模式切换保留消息组件和原有折叠状态。
- 分享图只从消息数据投影正式 content/images，独立 ShareImageTemplate 渲染 Markdown 标题、列表、引用、表格、代码和正文图片，不截图聊天气泡或隐藏原页面元素。Thinking、工具、当前项目、Preview 入口、参考来源卡片、Token、ChangeSet、Diff、撤销均不传给模板。仅在助手正文中把既有 `[S编号]` 转为可理解的来源名称；缺失来源时去掉孤立运行时编号，用户原文、代码和显式链接不改写。复用既有江南夜景素材及 Gor 品牌，不替换聊天背景，不调用 LLM、不上传正文或创建公开链接。
- 分享图片为单张聊天长图：750px 逻辑宽度，高度由完整 ShareImageTemplate 在字体和图片加载后计算，全部勾选正文连续排列，顶部夜景/品牌栏及底部落款各一次。不固定高度、不限制 9:16、不分页；预览仅限制窗口并允许滚动，不限制图片本身。通常 2 倍 PNG，较长内容可在安全内存范围内降低像素倍率，但不低于逻辑尺寸。保守 Canvas 预算为物理边长 16384px / 16M 像素；超限或浏览器分配失败明确提示无法单张完整导出，不裁切、不输出空白、不擅自生成多图。预览与单张下载使用同一 PNG Blob；图片跨域/失败、字体超时及导出异常允许重试，不静默漏图。分享仅在 Web/移动端启用，复用 saveBlob；VS Code 聊天隐藏分享入口，且不接入勾选、分享栏或预览。原有插件 PNG 保存适配器保留，但聊天页面不再调用。
- 聊天底部留白收紧（2026-10-13）：聊天消息滚动区域明确设置 position: relative / z-index: 1；普通与分享模式共用消息列表底部 padding 4px 和含消息滚动区底部 margin 4px，滚动到底部时最后消息气泡距输入框约 8px。分享栏悬浮覆盖下部消息区域，不参与布局、不增加尾部占位；顶部 padding、气泡间 gap、横向排版及空会话布局保持原样。
- 分享模式 UI（2026-10-13）：Web 顶部分享在左、Preview 在右；插件隐藏分享入口，并且不传入勾选状态、分享栏或分享预览，仍不挂载 Preview。桌面复选框位于原有左侧空隙；移动端仅在分享模式预留 44px 左侧勾选列，用户和助手气泡均位于其右侧，普通移动端布局不变。方框视觉 23px，原生键盘/触控区域 44×44px，Lucide Check 为 14px / 1.8px。选中背景复用 Preview 高亮变量，颜色过渡、取消按钮和预览滚动条保持既有主题实现。分享模板、单张长图生成与下载逻辑不修改。
- 前一版分享 UI 历史验收（2026-10-13，以下布局数据不代表当前实现）：Web 分享 17 项、Preview 70 项、思考 13 项、插件 29 项通过；Web TypeScript、Web 构建及插件 prepublish 通过。实际浏览器夹具验证 1440px、360/375/390/430px 分享前后气泡 x/宽/高与间距一致，用户/助手勾选可点击、44px 热区命中正确、键盘空格可切换；360px Webview 样式夹具保持相同布局且无 Preview。选中背景渐变与 Preview computed style 完全一致，取消颜色符合要求。20 条示例正文生成一张 1500×6336 PNG，390px 预览可从顶部滚动至底部，关闭后保留勾选；图片生成与保存模块未修改。截图 `.runlogs/share-mode-mobile-360.png` / `.runlogs/share-preview-scrollbar-390.png`。未在实体手机触屏或真实 VS Code Extension Host 手动验收，未重测真实 Agent/服务端会话；构建保留既有大 chunk 与插件背景图片路径提示。
- 分享栏浮层与紧凑间距（2026-10-13）：按最新要求，分享栏恢复为输入区上方 12px 的浮层，保持既有宽度和外观，不增加消息尾部 padding 或占位。分享栏与滚动按钮共用 --chat-bottom-control-layer（5），含分享栏的底部容器同步为 5；按钮仍在分享栏上方 12px（手机 10px），可见性阈值与回调不变。ResizeObserver 仅测量栏高定位按钮，不改变消息列表间距；退出后清理观察器及局部变量。两种模式贴底消息均距输入框约 8px，因此分享栏会覆盖部分下部消息区域；需要阅读被浮层覆盖的内容时可退出分享模式。分享选择、模板、PNG 生成及保存逻辑不变。回归验收仍执行下列命令；真实 Extension Host 与实体手机未手动验证。
- 分享验收命令：Web `npm run test:share`、`npm run test:preview`、`npm run test:thinking`、`npx tsc --noEmit`、`npm run build`；插件 `npm test`、`npm run vscode:prepublish`。浏览器夹具为 `Web/scripts/share-browser.fixture.html`，使用示例内容验证 1/5/20 条正文的单张 PNG、正文过滤、长图滚动和超限/图片失败状态；夹具不冒充真实 Agent/宿主实测。首版按钮 UI 的历史验收仍见 `.runlogs/chat-share-header.png`，不代表完整分享功能验收。

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
- **Git 提交与推送（2026-10-15，仅 VS Code 插件）**：`git_status` / `git_commit` / `git_push` 登记在 `PROJECT_TOOL_CAPABILITIES`，映射 Provider 能力 `git`。只有 `VSCodeProjectProvider` 声明 `git=True`，Web Preview 声明 `git=False`，路由与分发自动过滤，Web 端不可见、不可调用；未完成工作区登记的插件请求同样没有。扩展通过 VS Code 内置 Git 扩展 API（`vscode.git` v1）在当前连接工作区的真实仓库执行（`src/workspace/git.ts`，RPC 方法 `git.status` / `git.commit` / `git.push`），push 沿用用户在 VS Code 中已有的凭据，不经服务端磁盘、Runner 或 Web Preview。
  - 提交：模型应先 `git_status`（可带受限 diff，排除敏感文件与未跟踪文件）再起草说明。扩展弹出原生模态确认，展示分支、提交说明和完整文件清单，可改写说明；确认后重新核对仓库状态，一致才暂存并 commit，变化返回 `GIT_STATE_CHANGED`。拒绝：未保存文件、合并冲突、游离 HEAD、`.env`/密钥类文件、当前工作区文件夹之外的改动、指定 paths 时暂存区还有其他文件。取消返回 `USER_CANCELLED`，不暂存、不提交。
  - 推送：模态确认展示远端、分支、待推送提交和已去除用户名/令牌的远端地址；无上游时推送到 origin（或指定 remote）并设置上游。永不强制推送；本地落后远端、无远端、多远端未指定时不执行并说明原因；确认期间 HEAD 变化不推送。回执和错误信息中的远端 URL 凭据被移除。
  - 桥接默认 10 秒超时不变；提交/推送单独使用 600 秒以等待用户确认，状态读取 30 秒。扩展请求仍串行执行，确认框打开期间其他工作区请求排队。思考面板按调用参数和回执显示（见“思考标题与摘要按真实参数和回执生成”），Git 步骤使用 GitBranch 图标。
  - 验收：Server `tests/test_vscode_git_tools.py`（转发参数、长超时、默认超时不变、取消、Web 不可调用、路由仅插件可见）及完整离线 pytest；插件 `tests/git-workflow.test.cjs`（状态、确认、改写说明、取消、各类拒绝、确认期间状态变化、推送不强制、设置上游、凭据脱敏、请求路由），`npm test`、`npm run vscode:prepublish`；Web TypeScript、Preview 测试与构建。测试使用 vscode/Git API 替身，**未在真实 VS Code Extension Host 中对真实远端执行提交/推送**；Git 扩展 API 各版本行为差异与网络/认证失败的真实提示需人工验证。

#### 联网检索与图像来源

- **综合资讯数量（2026-10-14）**：综合新闻、热点汇总通常整理 3–8 条独立资讯，可靠资料充分时优先 5–8 条；用户指定数量时遵从，聚焦单一事件或当前型号时只回答所问，不增加无关消息。同一事件的多篇报道合并，来源篇数不等于资讯条数；选择近期重大进展、明显变化、争议焦点及与用户相关的内容，热度/爆点和影响须有真实来源支撑，不编造热搜排名或夸大标题。每条按既有标题、通俗摘要、来源/发布日期和引用格式展示，并说明为何值得关注；资料不足按实际数量列出。
  - Reader 单批上限由共享 MAX_PAGES 控制为 8，Agent 白名单过滤、能力回退和同轮缓存同步遵循；显式 max_pages 较小时仍尊重较小数量，长文补读不受资讯条数限制。8 篇独立来源分别保留正文、日期及 sourceId，不合并相似报道的证据。此调整不提高 Agent 总轮次或页面响应安全上限，也不强制凑数、改变时效核验和按日期排序。
  - 回归见 `test_reader_context.py`、`test_web_reader.py`、`test_web_skill_routing.py`、`test_tool_prompt_compatibility.py`，覆盖两端八篇白名单读取/引用、缓存与较小参数、独立事件和不足不凑数规则。更新的 BASE_PROMPT / NEWS_RESEARCH_PROMPT / WEB_READER_PROMPT 哈希对应本次明确授权，其余字面量卡片保持原样。

- **新闻正文读取（2026-10-14，Web / VS Code 共用）**：`ReaderContext` 仅在当前 Agent Run 内按精确 URL、query、max_pages、start_char 及其他实际读取条件复用成功页面，批次重排或重叠只下载缺失页面；独立来源不因正文相似而合并。短小/空正文、错误不缓存，部分批次失败只复用成功页面并重试失败页面，公开 URL 白名单、取消和工具权限检查保持在 Agent 执行边界。下一轮请求重新读取，不使用全局缓存。
  - 正文单次容量沿用 8,000 字符，新增 total_body_chars、body_start_char、body_truncated、has_more、next_start_char 和 body_fingerprint，片段不得当成完整核实的全文。必要时以目标 URL 和 next_start_char 调用 web_reader 的 start_char 补读，保留完整连续字符和原来源编号；尾段不足 80 字符但属于有效长文时仍计为可用证据。补读重新获取页面，正文指纹变化会使旧缓存失效并标记 snapshot_changed，模型应从起始段重新核实，不拼接不同版本。单批最多 8 页；2 MB 网络响应安全上限及现有 Agent 轮次上限保持既有值；超长或不可读页面仍可能无法完整核实，必须依据实际可用证据回答。
  - `[ReaderTiming]` 记录单页下载/正文提取/整体耗时、截断与补读位置；`[ReaderReuse]` 记录缓存命中、实际获取和失败页数、整体耗时；ReaderAudit 记录命中及截断页数。只记录计数、状态和时间，不输出正文。缓存返回保留标题、作者、日期、URL 与 sourceId，缓存命中不报告再次下载。既有完全重复段落精简仅作用于模型上下文，不另行缩短独有证据。
  - 专项验收：`Server/venv\Scripts\python.exe -X utf8 -m pytest tests/test_reader_context.py tests/test_web_reader.py tests/test_search_context.py tests/test_web_skill_routing.py tests/test_tool_prompt_compatibility.py -q`，覆盖两端同轮复用、条件差异、失败重试、独立来源、跨轮隔离、长文连续补读及尾部事实、指纹变化、耗时字段和引用编号；完整验收沿用公共 Server 离线测试及 Web/插件构建。真实网页内容可能变化，测试不能保证模型必定按需补读或所有网站均可读取。

- **同轮搜索去重（2026-10-14，Web / VS Code 共用）**：Agent 的 `SearchContext` 仅在当前执行轮次内复用 `web_search` / `search_github_code` 的成功结果。键包含工具名与所有实际参数（查询词、原始问题、语言、域名/仓库等条件），不做近似匹配，不跨轮、会话或端缓存；空结果、错误、部分 Provider 失败保持可重试，取消和公开搜索权限检查仍先于复用。原始来源、日期、链接、引用编号与来源卡片保持完整，缓存命中的 Search Trace 标记 cacheHit 且不重复报告 Provider 执行。`[SearchReuse]` 记录是否复用及执行耗时，不额外调用模型。
  - 仅精简给模型的重复副本：本轮已经提供的完全相同来源文本块用原编号指向前文完整证据；同 URL 出现新增内容、不同日期或不同措辞时仍完整保留。网页正文只删除完全相同的段落，关键段落若已完整包含在正文中则不重复发送，正文之外的关键证据继续保留。原始工具结果与 SSE 展示不裁剪，不降低来源数量或正文长度，不新增搜索次数硬限制，不提前结束办公文件或项目生成流程。
  - 专项验收 `Server/venv\Scripts\python.exe -X utf8 -m pytest tests/test_search_context.py tests/test_web_reader.py tests/test_search_orchestrator.py tests/test_web_skill_routing.py -q`，覆盖两端复用、条件差异、失败重试、取消、跨轮隔离、引用/来源事件、新增证据及检索后生成。完整公共验收沿用离线 Server 测试、Web TypeScript/Preview/构建及插件测试/构建；真实搜索速度和模型回答质量仍需真实样本比较。

- `web_search` 以规则分类问题并并行查询该类已配置的 Provider。当前意图和实际调用计划如下：

| 搜索意图/范围 | 实际 Provider 顺序（同时并行请求已配置项） | 优先检索范围示例 |
| --- | --- | --- |
| 普通咨询、用户体验、旅游/美食推荐 | Tavily → 博查 → Brave → Serper → 豆包 | 小红书、知乎、马蜂窝、携程、大众点评、去哪儿；旅游/美食关键词会追加携程、去哪儿、点评、小红书等域名 |
| 官方事实（政策、票价、开放时间等） | Tavily → 博查 → Brave → Serper → 豆包 | gov.cn、文旅部门、UNESCO、携程等 |
| 技术文档与教程 | Tavily → 博查 → Brave → Serper → 豆包 | MDN、Python、React、Vue、Node、Vite、Webpack、esbuild、Chrome/Google Developers；React、esbuild 等词会追加官方站和 GitHub |
| GitHub 仓库/开源实现（独立 `search_github_code`） | GitHub Repository Search → 按需 GitHub Code Search | 同名仓库优先，模糊匹配按 Stars 热度；确认目标仓库后再按需搜源码 |
| 新闻/最新动态 | Tavily → 博查 → Brave → Serper → 豆包 | 依地域和主题混合来源：国内含新华社、人民网、央视、财新、澎湃、第一财经、36氪、IT之家及政府/监管站；国际含 Reuters、AP、BBC、Bloomberg、FT、CNBC、NYT、The Guardian、Nikkei Asia、CNA、NHK 及国际组织/政府/企业一手站。技术主题还可查 TechCrunch、The Verge、Ars Technica、MIT Technology Review、Wired、VentureBeat、The Information、量子位、机器之心、极客公园等；官方来源优先核实事实但不排斥行业媒体、技术博客和配套站点。新鲜度只参与排序，不设固定时间门槛；全球新闻兼顾国内与国际，缺一侧自动补搜，结果控制单一媒体、国家和类别的集中度 |
| 深度调研/论文 | Exa → Tavily → 博查 → Brave → Serper → 豆包 | arXiv、Semantic Scholar、ACM、IEEE、JMLR、ACL 等 |
| 视觉灵感、PPT/设计参考 | Tavily → 博查 → Brave → Serper → 豆包 | 小红书公开索引页及 Pitch、Canva、Envato、Slidesgo、SlidesCarnival、Microsoft、OfficePLUS、优品PPT、Behance、Dribbble 等；没有专用小红书 API |

  每个 Provider 缺少密钥会跳过；结果规范化、跨源去重、融合排名并保留来源。普通检索零有效结果时可扩大到全网，但不会为凑到 8 条扩搜；全球新闻缺少地区来源时另行定向补搜。用户明确给出 `site:` 时只保留指定域名结果，禁止扩大范围。Tavily 传 `include_domains`，博查用 `include`，豆包用 `Filter.Sites`，Serper/Brave 用 `site:`，Exa 用 `includeDomains`；GitHub Code Search 无原生站点参数，结果经统一 URL 过滤。当前 `web_search` 无显式排除域名选项。首轮每个 Provider 默认取 5 条，最终最多返回 8 条。
- **产品官网优先**：从原始用户气泡识别已登记产品别名，而不是只信模型缩短后的 Query；先检索产品官网索引页，再用相关资源网站补充，官网结果优先排列。麦当劳、小红书、今日头条、白宫、Antd Design Mobile（兼容 `desgin` 拼写）、新浪微博等示例已登记；未知品牌不凭空猜域名，官网无索引/请求失败不伪造命中。显式 `site:` 优先于产品偏好。当前是站点约束的公开搜索，不承诺登录官网站内检索或读取私有内容；`official_domains` 与来源事件用于检查实际计划。
- `search_images` 默认并行搜索可用的 Pexels、Pixabay、Unsplash、Openverse、Wikimedia Commons，也可指定单一 Provider。支持横图、竖图、方图筛选，每个来源最多取 6 个候选；返回图片直链、来源页、作者和可用许可信息，不由搜索工具下载图片。PPT 直接复用同一搜索实现，再做内容匹配、下载、画质筛选、嵌入与署名，不重复实现 Provider/API。Pixabay 候选 URL 仅短时用于取图，不永久热链；Unsplash 触发下载记录并保留署名。
- PPT Design Reference 在领域权重选出的公开网站（中文场景额外包含小红书）上进行带域限制的多源页面检索，只记录页面标题、摘要和来源链接，并以有上限的检索命中因子修正档案排序；不抓取 PPT 文件、模板预览图，也不做模板视觉分析。搜索不可用时回退静态设计档案。

#### 评测基线（阶段 0，2026-10-15）

- 目的：只测量、不改业务行为，量化回答“准不准”。代码位于 `Server/tests/eval/`：`cases/<domain>.jsonl` 题库（当前 news 24 题，国内/国际/科技/财经各 6），`run_eval.py` 通用运行脚本，`checkers/` 按 task_type 注册检查器（已实现 `fact_qa`；`code_run`、`file_produced` 仅留 TODO 接口），`metrics.py` 纯函数指标。
- 运行（Server 目录，先启动后端）：`venv\Scripts\python.exe -X utf8 tests\eval\run_eval.py --domain news`；可选 `--only <id>`、`--base-url`（默认 `http://localhost:3001`）、`--out-dir`（默认仓库根 `.runlogs/eval`）、`--baseline <旧结果.json>`、`--timeout`、`--freshness-days`（默认 3）、`--rescore <结果.json>`（不调用后端，用已保存的原始回答按当前题库与指标重算）。每题用 `POST /api/chat/session/create`（userId=`gor-eval`）建独立会话，`POST /api/chat`（clientMode=web）取 SSE，结束后 `DELETE /api/chat/session/{id}`；只删除自己创建的会话，删除失败的 ID 写入报告，不直接改数据库。输出 `<domain>-<时间戳>.json/.md`，首次全量运行复制为 `<domain>-baseline.json`。脚本不读取或打印 `.env`。
- 指标（均为启发式，定义详见 `metrics.py` 注释）：引用覆盖率 = 带有效 `[S#]`（编号存在于本题 search_sources）的事实句 ÷ 事实句（逐句为准；另报辅助“段落级覆盖率”，段内任一句带有效引用即算，反映段末统一标注的写法）；日期正确率 = 与所引来源 publishedDate/dateHint/页面 published_at 一致或出现在 snippet/web_reader 正文中的日期 ÷ 带引用日期，无引用日期单独计为无法核对；无来源陈述数分“无引用”和“无效编号”两类；事实正确率只对已填 gold_facts 且 `needs_review=false` 的题计算，规则匹配不能判定的标记待人工复核而不判错；新鲜度违规 = 称“最新/今天/昨天”等但所引来源均早于阈值；编造率只对 `expect_no_answer` 虚构前提题计算。
- 限制：切句、事实句识别、日期和事实匹配均为规则，可能漏判/误判；只能检查日期与引用是否对得上，不能判断句子内容是否被来源支持。新闻随时间变化，标记 needs_review 的 gold_facts 需人工按运行日期确认后再计分。结果受当时模型、搜索 Provider 与网页可读性影响，同题多次运行可能不同。日期指标不区分发布日期与事件日期，选举日、任期截止日等事件日期即使正确也可能因不在来源元数据/摘要中被记为不符。回归 `tests/test_eval_metrics.py`（假数据，不联网）。
- 首次基线（2026-10-15，`.runlogs/eval/news-baseline.json`，由同一次全量运行修复标题切句后 `--rescore` 得到）：24 题全部完成、无失败，测试会话全部删除。引用覆盖率 52.7%（117/222，段落级 82.4%），日期正确率 93.0%（107/115，另 40 个日期无引用无法核对），无来源陈述 105（全为无引用，无效编号 0），新鲜度违规 0，事实正确率 7/7（仅 4 道已确认题计分），编造率 0/4；15 道题标记 needs_review 待人工确认。稳定事实题（如 HTTP/3）可能完全不触发搜索，回答无来源。

### Preview Worker（聊天页内的产物与源码工作区）

- `Preview` 展示助手生成的 HTML、Office/PDF/3D 文件、导入的 dist 页面或虚拟项目运行结果；`Code` 浏览虚拟项目源码。没有源码的附件不显示源码操作。
- Preview 文件树把上传附件和助手生成产物按会话展示；选择产物用于预览。Worker 的清除操作按现有清除语义软隐藏当前项目关联的产物和源码，不做不可恢复的物理删除；聊天消息仍可重新加入。
- **项目与产物按稳定 ID 隔离**：同一个可编辑 Preview Project 连续修改沿用同一个 `projectId` 并递增 `revision`；Worker 按项目 ID 合并更新，只展示该项目的一条最新入口，不因每轮局部 patch 另建项目。聊天消息保留本轮更新文件和 diff；彼此独立的项目或 Presentation 产物仍按各自 ID/消息快照隔离。隐藏 Worker 条目不销毁聊天消息中的重新打开入口。当前没有独立的项目版本时间线或任意历史版本回滚。
- **预览产物格式提示**：Preview 文件树条目悬停时展示最终交付产物的扩展名，而非内部实现文件的扩展名。例如 React 应用预览标注 `.html`，由 SceneSpec 渲染并导出为模型的 3D 产物标注 `.glb`；普通文件则根据实际文件名/类型展示。新增产物类型时，应由快照元数据显式提供最终输出扩展名，避免从临时编译文件或源码文件名误推断。
- ZIP/文件夹导入时识别源码项目或静态 dist。源码导入至 Virtual FS，可由 Web Worker 调用 esbuild-wasm 构建；构建结果在不授予 `allow-same-origin` 的 iframe 中运行。依赖受限于内置白名单，不支持用户安装任意 npm 包。
- Web 新建 React 项目使用 ES modules：HTML 的 `type="module"` 指向实际存在的 JSX/TSX 入口，组件使用 import/export，CSS 通过代码 import。不能因用户没指定 TypeScript 就生成 CDN + Babel 无构建方案，也不能把文件写入成功当作构建成功。旧 Babel HTML 通过 Web 编译适配器兼容：按本地 JSX 脚本顺序编译、隔离重复词法声明、注入沙箱已有 React、编译 HTML 链接的本地 CSS；不下载 CDN/Babel，不改写用户源码，合成入口仅存在编译内存中。模块入口优先；未声明模块时优先已有入口而非硬猜 main.tsx。快照不得把 CDN 脚本替换为入口；真实缺失文件/不支持依赖仍报告错误，不用空模板掩盖。
- React 入口兼容验收（2026-10-09）：Web `npm run test:preview` 67 项通过，`npx tsc --noEmit`、`npm run build` 通过；Server 工具协商和提示词兼容测试 39 项通过，覆盖 Web/VS Code 策略隔离。实际出错会话恢复 Build success，页面样式和计数器点击通过浏览器检查。未实测新一轮模型生成或 VS Code 宿主；新生成策略需后台重载，旧项目兼容修复刷新 Web 即可生效。
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
- 两端模型共用 `tools/project_api_tools.py` 的工具 Schema、`agent/tool_routing.py` 的基础规则和 `tools/project_dispatch.py` 的执行入口。默认绑定当前 Provider 真正支持的 `list_project_files`、`search_project_code`、`read_project_file`、`patch_project_file`、`batch_patch_project_files`、`write_project_file` 及 `create/delete_project_*`，不再以动作词命中作为工具可用性的前提；按 `get_capabilities()` 过滤，执行时再次检查能力和版本。模型只能按用户实际要求操作，不能把默认暴露 Schema 当作对任意目标的写入授权；只读指令仍须遵守。未注册插件只开放读/查验证能力，不能用服务端目录冒充工作区。旧 `*_preview_*` 名称仅为 Web 兼容别名，不默认绑定给模型。
- 当前 Preview 源码链路提供文件清单、代码搜索、按行范围读取、精确补丁、批量补丁和文件写入。默认先返回搜索命中及少量上下文，仅在定位不足时扩展读取；工具结果受结果数、行数、字符和 Token 预算限制，并输出 revision/version，避免每轮把项目所有源码发送给模型。
- 统一版本参数为 `expected_version`，同时保留旧 `expected_file_version` / Preview 别名的 `expected_revision` 兼容；多个参数值冲突即拒绝执行。Web 使用整个虚拟项目的 version，批量补丁在批次顶层传入；插件使用目标 TextDocument 的 fileVersion，批量补丁每项分别传入，不能用连接代次代替文件版本。通用对象结果补充 projectId/provider/version，同时保留原 fileVersion 等 Provider 字段；搜索仍保留有界命中列表，旧 Preview 回执仍兼容 revision。内部 Preview SSE 继续使用原 revision/源码同步协议，不因改名破坏提交、Diff 或产物快照。
- **刻意保留的能力差异**：Web `write_project_file` 维持 Virtual FS 的新增/覆盖语义，尚未开放 Agent 通用 `createFile/deleteFile/createDirectory/deleteDirectory`，不把前端 VFS 的删除能力冒充完整服务端调用链。插件 write 仅替换已有文档，write/patch/batch patch 在修改后自动保存本次文件，原本 Dirty 的目标拒绝修改；create 不覆盖已有文件，delete 保留脏文档保护、系统回收站和非递归空目录限制。Web 目录仍由文件路径隐式推导，不支持独立空目录。`set_3d_scene` 及自动 GLB 导出仍是 Web 专属；插件不得调用 Preview 别名、3D Scene 工具或服务端磁盘工具。请求级 Web Registry 仅注册 preview，插件仅注册 vscode。
- 文本文件采用通用 exact-text 匹配，不解析具体语言语法。补丁要求 `old_text` 唯一命中并校验预期 revision；目标不存在、不唯一或版本冲突时拒绝写入。批量补丁用于同一请求的多文件修改，随后沿用当前 Preview 的 diff、项目持久化与 UI 流程；二进制文件不走文本 patch。
- Project API 是访问抽象，不等于任意磁盘权限。Preview Provider 只操作会话 Virtual FS；VS Code Provider 必须有在线工作区桥接、有效版本和扩展端路径校验。未知目录先读取，版本冲突后刷新；实际读写失败须报告原因，不能在气泡编造完成。
- 公共入口兼容改造不改项目创建 ID、离屏发布条件、GLB 导出/数据库存储、Preview 列表排序、源码快照绑定或 UI 样式。`Server/tests/test_shared_project_tools.py` 对新旧名称结果一致、版本/能力/端隔离、取消、真实 Preview SSE/Diff/计数及简述回复进行回归；插件测试覆盖自动保存、Dirty/版本保护、保存失败和路径权限。尚未重新逐项人工验收真实模型在 VS Code Extension Host 中的所有自然语言请求，不承诺测试消灭所有回归风险。

#### VS Code Agent 修改自动保存

- 沿用 VSCodeProjectProvider → RPC → WorkspaceEdit，修改前检查每个目标的 TextDocument 版本和 Dirty 状态；原有未保存编辑先提示保存或撤销，不替用户保存手动编辑。批量先校验全部目标，再用一个 WorkspaceEdit 应用，随后每个实际改变的文件仅调用一次 `TextDocument.save()`；无变化不触发保存。
- 保存前重新核对文档身份、内容和批量保存期间的版本变化；发现并发修改不保存该文件、不回滚。原生保存参与者（如 format-on-save）仍遵循用户设置，成功时 Diff 包含保存后的实际文本。保存期间的用户编辑和磁盘冲突由 VS Code 原生保存机制处理，不绕过保护强制写盘。
- `save()` 返回 false、抛错或保存后仍 Dirty 均返回 `FILE_SAVE_FAILED`，RPC/Project API 保留 `savedFiles`、`failedFiles`、`changedFiles` 及版本回执。批量保存不是磁盘事务，可能部分成功；失败也保留已应用修改的 Diff，聊天明确未完成保存，不报告整次修改成功或自动回滚。
- 新建仍用原生 `WorkspaceEdit.createFile`、不覆盖；目录/删除沿用 VS Code fs 与已有权限保护。现有工具未开放重命名，本次不新增或用服务端 fs 模拟重命名。不修改全局 Auto Save、不用 saveAll，不改变普通手动编辑流程或 Web Virtual FS。
- 回归覆盖插件保存 false/异常、Dirty 目标、批量部分保存、并发内容/版本变化、无变化及保存参与者；服务端覆盖失败 RPC/工具回执、Diff 事件和失败聊天简述。验收：插件 `npm test`、`npm run vscode:prepublish`；Server 的 `test_vscode_project_api.py`、`test_project_files.py`、`test_shared_project_tools.py`、`test_tool_routing.py`、`test_tool_prompt_compatibility.py`；公共边界同时运行 Web TypeScript、Preview 测试和构建。真实 Extension Host、磁盘权限/远程文件系统冲突需单独人工验收。
- 2026-10-09 实际验收：插件 23 项通过；服务端上述测试加 `test_project_reply.py`、`test_project_api.py`、`test_preview_context_flow.py` 共 66 项与 5 个子测试通过，1 项依赖 `PREVIEW_TEST_URL` 的 Vite 联机测试跳过；Web TypeScript、67 项 Preview 测试、Web 构建和插件 prepublish 通过。构建仍有既有大 chunk/Webview 图片运行时解析提示。本次未实测真实 VS Code Extension Host 的权限失败、外部磁盘修改或远程文件系统，不将模拟回归当作宿主实测。

#### ChangeSet 与统一撤销 API（2026-10-10）

- 已提供变更记录、确认/撤销服务及共用 Diff UI 的单/批操作接线，不实现拒绝、Redo 或任意历史版本管理。`project_api/changes.py` 的 `ChangeRecorder` 与 `UndoService` 共用业务规则；Provider 只负责端特有快照和安全执行。
- 每个聊天执行轮次有独立 UUID，ChangeSet 按 session + round + ProjectRef（含 root）绑定；同轮同文件保留首次 before 和最终 after，记录文本、SHA-256、版本、modify/create/delete 和状态。完整恢复文本保存在 PostgreSQL `project_change_sets.record` JSONB，不进入 LLM ToolMessage、聊天正文或服务端生成目录。原始聊天 Diff 不改写；撤销不经过 Agent 记录上下文。
- Web 在会话 Virtual FS 的最终数据库 CAS 成功时，与项目快照同事务持久化 applied 记录；别名工具和 3D Scene 修改也由最终文件集统一记录。写入内存不等于数据库保存成功。插件在原 Provider RPC 外围记录执行前快照，原生操作回执附私有实际保存后快照，服务端提取后从工具回执删除；同轮两次写入之间若用户改过文件即阻止合并写入。现有 Web Agent 通用 create/delete 能力仍不扩展，但撤销适配器支持 VFS 新增/删除恢复。
- 状态：`pending` 表示尚未提交的候选；插件请求前持久化 `applying` 意图，实际保存成功后为 `applied`；保存失败为 `failed`，净内容无变化为 `unchanged`。撤销请求前持久化 `undoing`，成功为 `reverted`；已改变但保存失败为 `undo_failed`。`applying/undoing` 中断后不推断成功，也不自动重试，返回结果未知需核对；失败文件不冒充成功或重新当作待接收。轮次 sealed 前不允许撤销。
- 共用接口：`getChangeSet(id)`、`undoFile(changeSetId,fileId)`、`undoChangeSet(changeSetId)`。HTTP 为 `GET /api/chat/session/{sessionId}/change-sets/{id}`、`POST .../{id}/files/{fileId}/undo`、`POST .../{id}/undo`。批量自行选择 applied 文件，不接收客户端文件列表；返回 `success/changeSetId/results`，每项含 `fileId/path/success/code/changed`（适用时）。SSE `change_set` 提供 ID、roundId 和 ProjectRef，不含全文并接入消息 UI。2026-10-10 修复历史消息绑定：封存记录保存真实 assistant client messageId，消息读取按 session + messageId 精确投影 `project_change_sets`（ID、sessionId、provider），不发送 before/after。前端只恢复唯一有效关联，不按文件名/最新项目猜测；无关联旧记录或多记录歧义仍禁用，避免撤错轮次。该功能需后台重新加载。
- 撤销前统一校验 SHA-256、版本、Dirty 和 VS Code root 身份；批量任何预检冲突阻止整批。原生 RPC 边界再次预检全部目标，再对每个执行目标重验，防止检查与写入间的变化。VS Code 通过已有 write/create/delete、WorkspaceEdit、TextDocument.save()/workspace.fs 执行，不使用服务端文件系统、不改 Auto Save。保存参与者改变恢复文本时返回 `RESTORE_CONTENT_MISMATCH`，不能声称还原成功。插件 Agent RPC 在扩展中串行化，不阻止用户普通编辑。
- ChangeSet 请求用 PostgreSQL advisory lock 跨进程串行化；撤销意图在外部 IO 前可见，超时/中断不盲目重复撤销。批量不是磁盘事务：允许真实部分失败，已成功文件保持 reverted，已改变未保存文件标为 undo_failed 并保留结果。重复成功请求不执行文件操作；失败/未知结果需人工核对，不报告成功。Web 单文件撤销自身增加的项目 revision 同步到本 ChangeSet 剩余 applied 文件，外部 revision 变化仍阻止撤销。
- Web 撤销仅操作该会话当前、ID 相符的数据库虚拟项目；返回 `previewProject/serverRevision` 供既有预览同步使用，不自动切换到历史项目、不重写历史消息快照或二进制 GLB。历史非当前项目返回 `PROJECT_NOT_CURRENT`，须先恢复该项目并通过版本校验。`api/projectChanges.ts` 提供显式宿主客户端，`api/webProjectChanges.ts` 接入 Virtual FS：仅同项目、无本地未保存修改、请求期间未变更的状态才同步，然后请求构建；不自动重新导出或覆写历史 GLB。`applyUndoProject` 精确替换文件集，不走 import reconciliation，不补造入口，不复活已删除文件；插件客户端禁止调用 Preview 撤销。当前轮 SSE 和具有真实 messageId 关联的历史消息都可接入撤销 UI；无关联旧记录仍安全禁用，不按日期/文件名补猜 ID。服务器 API 不执行浏览器构建。插件全文快照合计限制 2 MB，超过则明确拒绝此次写入，不截断恢复内容。现有会话 API 无完整账户鉴权，此 API 校验会话归属但不宣称新增完整用户权限体系。
- 验收：Server `venv\Scripts\python.exe -X utf8 -m pytest tests/test_project_changes.py tests/test_project_files.py tests/test_vscode_project_api.py tests/test_shared_project_tools.py tests/test_project_api.py tests/test_preview_context_flow.py tests/test_tool_routing.py tests/test_tool_prompt_compatibility.py tests/test_project_reply.py -q`；插件 `npm test`、`npm run vscode:prepublish`；Web `npm run test:preview`、`node --experimental-strip-types --test scripts/project-changes.test.ts`、`npx tsc --noEmit`、`npm run build`。2026-10-10：此前 Server 81 项与 5 个子测试通过，1 个 Vite 联机测试跳过；本次另外 Server ChangeSet 专项 15 项、插件 27 项、Web Preview 67 项、Web ChangeSet adapter 4 项、Diff/撤销交互 18 项及 Web TypeScript 与 Web/插件构建通过。测试覆盖双端单/批撤销、create/delete 恢复、Dirty/Hash/版本冲突、部分保存失败、重复请求及状态回读；组件层部分失败、loading 和无可撤销文件也有覆盖。使用内存 Provider / RPC bridge 模拟工作区，不代表真实 VS Code Extension Host、浏览器项目或真实 PostgreSQL 上的人工端到端验收；部署需后台重载完成 init_db，插件重建/重载。

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
- Web iframe 的主题兜底背景仅设在 `html`；`body/#root` 默认透明，项目后加载的 CSS 可决定页面背景。`body/#root` 用 `flow-root` 防止应用首尾外边距折叠并移动整个文档，`body` 默认允许滚动，不以 `overflow: hidden` 裁掉长页面；保留全高尺寸链以兼容场景画布。这些默认样式只属于 Web Preview，不改聊天皮肤、插件布局或生成项目源码。回归测试在 `Web/scripts/preview-core.test.ts`。
  - 2026-10-09 验收：预览测试 64 项、TypeScript 检查及 Web 构建通过（仍有既有大 chunk 警告）。实际打开会话 `64274643-f461-4845-bb42-fd314d4c5985` 的 React Demo，确认项目浅色背景生效、body/root 顶部均为 0；在 1440×420 窗口下 iframe 高 274px、内容高 511px，滚动后可见页脚。未修改项目虚拟文件，未重新人工验证 GLB 场景和 VS Code 插件。
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

#### PPT 上下文与局部修改（2026-10-14）

- Web 与 VS Code 共用 Server 的 PPT 上下文选择和 create_ppt。新稿不附加旧稿正文；明确沿用预算、天数、风格时附加原稿中可核对的要求依据，不由额外 LLM 提取。近期精确历史与公共摘要仍独立保留，当前请求始终完整。
- 明确封面、末页或阿拉伯数字页码的局部修改只附加目标页、整稿设计配置和页面 ID/标题目录；范围不明确、中文页码、范围或全局设计修改保守保留所有页面。派生 referencePlan 不再作为模型任务数据重复上传。不能把部分页面上下文当作完整新稿。
- 新稿继续使用完整 presentation；修改优先使用 revision（baseFingerprint、updates[{slideId,changes}]、deckChanges、appendSlides、removeSlideIds），严格二选一。服务端校验当前会话快照指纹、ID、字段和完整 Schema，深复制合并；对象递归合并，数组替换，null 遵循原字段校验。未修改页面的语义字段、布局与时间轴保留；连续分页属于同一逻辑页面组，受影响组一起重排；补丁模式不把已有续页合回前页，避免续页标题和内容丢失。全局设计变更影响全稿。
- 历史基准只取本会话已保存的 PPT 消息快照，不读当前项目文件或按文件名猜测；默认最近一次。ChatRequest 可显式传 presentationMessageId 锁定历史消息，缺失则拒绝修改，不退回最近稿。没有明确 ID 的“第一份/更早/上一份”等指向先确认目标；本次未增加历史版本选择 UI。
- 每次成功仍生成独立 artifact/project/snapshot ID，保留旧 PPTX 和消息快照；搜图、原生渲染、Visual/Motion QA、来源和下载沿用原管线。局部补丁有已有参考方案时复用它；图片依旧按现有缓存/Provider 解析，过期或服务变化后不保证未改页照片逐像素一致。原生动画写入失败仍按实际失败页安全降级并记录。
- 插件仅使用公共 Office 产物事件和下载，不启用 Web Preview Worker、不接触另一端工程文件。测试：Server 完整离线 pytest（排除两个 DB 联机模块）；专项 tests/test_presentation_revision.py 以及 presentation_design/motion/reference/pexels、project_files。公共验收仍为 Web TypeScript/Preview/构建和插件 npm test/prepublish。测试覆盖上下文选择、原始要求保留、快照指纹、非法补丁、并发会话、真实 PPTX 新旧独立和两端 Agent 流程；真实模型遵从率、第三方图片及 Office 人工视觉需另验。

#### PPT 主题背景、动态效果与 BGM

- **主题视觉与背景图**：新增 deck 级主题视觉配置，并为每页结合主题、页面标题和内容生成图片查询词；默认尽可能为每页寻找相关图片，但根据页面密度选择满版背景、局部配图或低干扰裁切，避免图片压住文字或与内容无关。查询失败时使用与主题一致的渐变、纹理或色块兜底。背景图需保留可读性遮罩和前景/背景层级，使用等比裁切，不拉伸图片。当前 Pexels 仍按既有 `imageRole` 选择页面，不保证每页配图；此处是目标行为，不是现状。
- **动态效果（当前实现）**：`PresentationDesign v1.0` 的同一份 `/presentation.json` 包含 deck 级 `motionLanguage` 和页级 `transition`、`animations`、`animationGroups`、`animationTimeline`、`persistentElements`。`Server/tools/presentation_motion.py` 按设计 DNA、页面角色和内容层级确定性编排；除明确关闭或指定点击外，默认采用 `withPrevious` / `afterPrevious`，并对卡片、步骤等分组做节奏错开。时长、间隔和距离使用受限 token；每页一般最多 5 组，密集页最多 4 组，停顿页 1 组。背景、页脚、页码和装饰保持静态。旧快照仍按旧版淡化/少量点击方案渲染，不会被强制改写。
- **原生 PPTX 与 Web 共用时间轴**：`Server/tools/presentation_motion_renderer.py` 将目标绑定到仍可编辑的 PowerPoint 文字、图片、形状组、原生图表/表格；通过结构化 Open XML 写入 fade/push/wipe 转场以及 appear/fade/rise/wipe/fly/zoom/grow/pulse/colorEmphasis/fadeOut。`Web/src/preview/core/presentationMotion.ts` 消费相同的 target、顺序、trigger、start、duration、delay、clickIndex，以 Web Animations API 模拟、重播和清理。Web 的语义排版与真实 Office 像素布局可能不同，预览明确区分动画模拟与静态实页；减弱动态效果偏好时直接显示终态。图表只支持整体揭示，不宣称 series/category 原生分步；Morph 仅判断候选与记录 `persistentElementId`，实际导出回退 fade，Web 为近似淡化，不宣称原生 Morph。
- **Motion QA 与安全降级**：检查目标、预算、重复顺序、节奏、方向、过长时间轴、连续重复编排、淡化滥用、Morph 条件等；可确定性裁剪、限幅或静态化低优先级组，结构化写入失败时仅该页退回无动画，`visualQA.motionQA.nativeFallbacks` 记录原因，避免损坏整份 PPTX。自然语言修改提示词让模型基于本轮绑定的快照提交受影响页的 revision 补丁（含 motion 字段），再走同一校验/编排/渲染流程，生成新的 artifact/project/snapshot ID，不覆盖旧快照；模型对全部示例指令的实战遵从率尚未独立验收。
- **性能与能力边界**：PPT 图片分配在进程内以与 motion 无关的内容/图片查询键缓存整套图片，限 8 套/128 MB/5 分钟；共用 `search_images` 对候选元数据按 Provider/关键词/方向做缓存，避免重复请求。仅改动画时尽可能复用图片，进程重启或缓存过期后仍可能重新请求。已由本机 PowerPoint 实际打开和逐页放映 10 页发布会、12 页咨询报告、10 页点击版和 10 页效果诊断版；WPS 未验证。测试夹具位于 `.runlogs/motion-acceptance/`，逐项结果见 `PPT_MOTION_REPORT.md`。完整 Preview Worker 的独立验收页覆盖两份 PPT 与 React/Three 的切换、源码及软隐藏恢复；Office/PDF 下载/预览接口有自动化回归，但浏览器系统保存对话框的最终落盘及真实用户会话跨设备刷新仍未完成 UI 验收。
- **主题 BGM**：按演示主题推荐一条可选的纯音乐，用户可在预览中试听、静音和调节音量；导出时将获授权的音频嵌入 PPTX，并配置跨页播放/停止行为。音乐必须有明确来源、署名及演示/分发许可记录；第三方曲库的随机结果不能默认视为可再分发。当前 Jamendo 播放器是独立首页功能，随机曲目尚未与 PPT 主题匹配，也未接入 PPTX 导出。
- **兼容与验收**：图片、动画和 BGM 任一能力失败都要有明确状态与可用降级，不阻断 PPTX 下载。验收需覆盖 PPTX 包内图片/音频/OOXML、PowerPoint 或 LibreOffice 实际播放、预览中的图片等比与文字可读性、无音频/无图片时的主题兜底及旧快照兼容。静态 PNG 截图只能检查布局，不能作为动画或音频验收依据。

#### PPT Design Reference System（当前实现）

- `Server/tools/presentation_reference.py` 保存 8 个**元数据级**设计来源档案：Pitch、Envato Elements、Canva、Slidesgo、SlidesCarnival、Microsoft PowerPoint、OfficePLUS、优品PPT。基础权重依次为 `0.95 / 0.93 / 0.88 / 0.82 / 0.75 / 0.75 / 0.72 / 0.62`。这些档案描述各站擅长的场景、风格、语言、行业、受众、交付类型和抽象视觉特征；不是已获取或授权的模板目录，不包含第三方素材。生成时另对按主题匹配的高权重站点及中文小红书公开索引页执行有域名限制的多源检索。
- 系统从主题、用途、受众和页面概要提取有限的 `PresentationBrief`，按 `baseWeight × scenarioRelevance × styleRelevance × languageRelevance × industryRelevance × audienceRelevance × formatRelevance` 计算确定性得分，并以最高原始分归一化为 `finalWeight`。同分按来源 ID 稳定排序。选前两名主参考、随后两名辅助参考；中文稿另记录 OfficePLUS/优品PPT 作为排版校准来源，即使它们不是主视觉来源也不取代主参考。
- `ReferencePlan` 随 `/presentation.json` 快照保存 brief、八站得分与因子、主辅来源、中文校准、参考意图、抽象 `blendedDNA`、实际填入的 `appliedDNA`、布局语法、动画方向和决策说明。新稿及全局修改重新计算；局部补丁有已有 referencePlan 时复用该快照的设计参考，避免重新检索改变未修改页面；用户显式指定的设计 DNA 保留，用户上传/指定参考的有界语义参数优先于公共档案，绝不复制参考图片或页面几何。
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

### 聊天输入框文件修改方式与双模式执行

审批偏好及批量按钮样式验收（2026-10-11）：Server 偏好 API/审阅测试 10 项及 2 子测试、Web 模式 7 项、Diff 25 项、Preview 67 项、ChangeSet adapter 6 项和插件 27 项通过，TypeScript、Web/插件构建通过。跨端刷新、保存失败保留确认模式、旧会话迟到响应隔离由真实 Hook + 内存偏好服务回归验证；运行中后台真实 GET 已确认 no-store 及数据库已有模式，未改用户偏好来做实测，也未在真实 VS Code 宿主手动验证切换。

共用 `FileEditModeSelector` 位于「+」右侧，向上展开深蓝紫玻璃面板，展示「即刻落笔」（Feather）和「审阅落笔」（BookOpenCheck）；图标为淡紫色 17px / 1.7px 线宽，选中项为柔和紫色渐变。Web 手机窄屏的输入区沿用 PC 控件尺寸和两行排列：上行输入文字，下行左侧为「+」与模式选择，发送按钮靠右；保留移动端边距和底部安全区。VS Code Webview 保留自身紧凑布局。组件通过 value / onChange / loading 接入宿主，不访问 Project API 或文件系统。`useFileEditMode` 按会话通过 GET/PUT `/api/chat/session/{id}/edit-mode` 在数据库持久化 auto/review：Web/插件连接同一后台、同一 sessionId 时读取同一偏好，打开/刷新重新读取，客户端和响应均 no-store，不由端内缓存覆盖。选择切换依次等待本会话读取与之前保存；读取/保存期间选择器右侧展示转圈并禁用重复切换，不改变输入框高度；只有服务器确认后才更新选中项，失败保留最后确认的展示并走共用错误通知，发送继续被拒绝直到恢复读取或成功保存。离开会话/卸载后旧响应不得更新当前选中项。发送瞬间捕获模式，后续切换不影响运行中的轮次或历史 ChangeSet；本次没有新增免刷新实时广播。前端名称、状态、按钮与弹窗文案不由后端枚举生成，保持已有展示映射。

审阅执行（2026-10-11）：auto 保留现有写入、保存、Diff、复原流程。review 在 Web 的请求内 Virtual FS、插件的候选快照上生成和继续读写候选，实际项目确认前不变；首次 before 与最终 after 作为 pending ChangeSet 持久化。`ApplyService` 复用 Provider 的安全恢复边界，实现 `applyFile(id,fileId)` / `applyChangeSet(id)`，HTTP 为 POST `.../change-sets/{id}/files/{fileId}/apply` / `.../{id}/apply`。仅 sealed/pending 可确认，批量自动筛选 pending，预检 Hash/版本/Dirty，保存且复检成功后才 applied；失败/部分失败回读真实记录，未知执行结果不自动重试。既有“落笔 / 一并落笔”按钮接入上述接口，串行防重复；既有复原接口和确认文案不变。新 Web 项目逐卷确认保存在数据库虚拟草稿，全部确认后才发布并构建；期间旧预览不切换。确认/复原不再次记录为 Agent 变更，不改原始 Diff。插件 review 的目录操作及跨 root 批量请求当前明确返回 UNSUPPORTED_OPERATION，不自动写入；未新增拒绝/Redo。

双模式验收：Server 在既有 ChangeSet 验收命令增加 `tests/test_review_changes.py`；Web 增加 `npm run test:composer`、`npm run test:diff`，并运行 Preview、ChangeSet adapter、TypeScript 和构建；插件 `npm test` / `npm run vscode:prepublish`。当前测试使用实际服务/组件与内存数据库、RPC/native API 替身，覆盖确认前不写、单/批确认、create/delete、重复请求、冲突、部分保存失败、确认后复原、会话持久化与发送模式固定；不能代替真实 Extension Host 与生产数据库人工验收。后端重载完成 init_db 后启用新偏好表。

2026-10-11 撤回运行中模式切换改造，恢复发送时固定模式，保留批量按钮尺寸和模式保存 Loading。Web 源码入口修复仅调整消息快照选择：当前项目的快照从 Worker 去重列表过滤后仍可打开 Code，同一项目不同消息不串用源码。验收：Server 93 项、7 子测试通过，1 个联机测试跳过；Web Preview 69 项（含真实 ChatPage + Worker 入口回归）、模式 8 项、Diff 25 项、ChangeSet adapter 6 项，插件 27 项通过；Web TypeScript、Web 构建及插件 prepublish 通过。浏览器实测会话 `2507e8bf-ad04-4236-8389-8a6b6dd69ee8` 的历史源码和预览保留早期标题，不混用最新“代办事务”源码。未重跑真实模型生成、系统下载或真实 VS Code Extension Host；历史无消息快照的旧回执未补造源码。构建保留既有大 chunk 和插件图片运行时解析警告。

确认后的 Web 源码快照按 ChangeSet 的真实消息关联保存，历史读取可恢复该已发布快照；原始 Diff 不变。Web 适配器仅在真实同步成功后通知会话宿主更新快照和既有预览入口；确认后的 SceneSpec 通过既有内存导出和虚拟产物 API 生成 GLB，绑定发起消息，不绑定最新消息。2026-10-11 验证：Server 93 项通过、7 子测试通过、1 联机测试跳过；Web Preview 67、ChangeSet adapter 6、Diff/操作组件 24、模式选择/会话偏好 4 项通过；插件原生保存/RPC 27 项通过，Web TypeScript、Web 构建和插件 prepublish 通过。后台健康检查与真实会话 edit-mode GET 已验证；没有真实 VS Code Extension Host 的手动双模式端到端验收。

| 工程 | 目录 | 命令 | 默认地址/备注 |
| --- | --- | --- | --- |
| Web | `Web/` | `npm run dev` | `http://localhost:5173`；`/api` 代理到 `127.0.0.1:3001` |
| Server | `Server/` | `.\venv\Scripts\python.exe -X utf8 main.py` | 默认 `http://localhost:3001`；沿用 Python UTF-8 后台启动，环境配置见 `Server/.env.example` |
| VS Code 扩展 | `vscode-extension/` | `npm run vscode:prepublish`；开发调试在 VS Code 中按 F5 | 构建 VS Code Webview 与扩展；前端热构建可运行 `npm run watch:webview` |
| Native | `Native/` | `npm start -- --lan` | Expo Go 扫描二维码；手机和开发机需连接同一 Wi-Fi |

核心配置包括 `ARK_*`、`SUPABASE_DB_URL`、各搜索服务 Key、`AMAP_WEB_SERVICE_KEY`、`XIAOYUNQUE_*`、`JUDGE0_URL`、`PROJECT_WORKSPACE_ROOT` 与 `GOR_STORAGE_DIR`。真实密钥应保存在本地环境变量或未提交的 `.env` 文件中。

后台启动使用 PowerShell `Start-Process`，工作目录设为 `Server`，运行上述虚拟环境 Python 并传 `-X utf8 main.py`，窗口隐藏，输出重定向日志；不要改用系统 Python。数据库字段兼容迁移由服务启动的 `init_db()` 执行，存储协议改动后需确认后端已重载并完成初始化；旧插件包需重建/重载后才能使用新公共组件。
