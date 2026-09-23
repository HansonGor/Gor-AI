# 项目概览

本项目是一个 AI 助手应用，包含 Web 前端、Python API 服务和 Expo 移动端容器。主要交互在 Web 页面完成；移动端通过 WebView 加载 Web 页面，并提供设备定位桥接。

> 本文按当前源码整理。功能是否可用还取决于对应服务、数据库和第三方 API 是否已配置并运行。文档不包含 `.env` 中的真实密钥。

## 目录结构

```text
D:\Gor\
├─ Web/                 React Web 前端
│  ├─ src/pages/        首页、聊天页、代码沙箱 Demo
│  ├─ src/components/   聊天、侧边栏、音乐播放器及通用 UI
│  ├─ src/preview/      Preview Project 的纯逻辑 Core 与模板
│  │  └─ runtime/        Browser Worker、协议、编译器与依赖解析
│  ├─ src/stores/       Preview Project 浏览器内存状态
│  ├─ src/hooks/        会话、消息、主题、天气等状态逻辑
│  └─ src/api/          聊天 API 与 SSE 处理
├─ Server/              FastAPI 后端
│  ├─ agent/            Agent 循环、提示词、Token 统计
│  ├─ routes/           HTTP/SSE 路由
│  ├─ tools/            Agent 工具（含受限 Web 文件操作）
│  ├─ tests/            文件工具及 Agent 变更事件测试
│  ├─ db/               PostgreSQL 会话与额度数据
│  └─ models/           对话、视觉模型与向量检索
├─ Native/              Expo / React Native 容器
│  └─ bridges/          WebView 与原生能力的桥接
└─ project.md           本文档
```

目录示意省略第三方依赖及生成文件，例如 `node_modules/`、`dist/`、`venv/`、`.expo/`、`__pycache__/`、`.mypy_cache/`、`generated/`。`Web/public/` 和 `Native/assets/` 是静态资源目录，也未逐项展开。

## 技术栈

| 部分 | 主要技术 | 用途 |
| --- | --- | --- |
| Web | React 18、TypeScript、Vite 5、React Router 7、esbuild-wasm、Three.js 0.186.0 | 页面、路由、浏览器端编译及沙箱内程序化 3D 场景 |
| Web UI | shadcn/ui、Tailwind CSS 3、Less、Radix UI、Lucide | UI 组件、样式与图标；Chat 链路已不依赖 Ant Design / Ant Design Mobile |
| 内容呈现 | react-markdown、remark-gfm | 渲染 AI 回复中的 Markdown、代码块和表格 |
| Server | Python 3.10+、FastAPI、Uvicorn、Pydantic、httpx | API、SSE 流式响应和外部请求 |
| AI | LangChain、langchain-openai、火山方舟 OpenAI 兼容接口 | 对话模型与工具调用 |
| 数据 | Supabase PostgreSQL、asyncpg；阿里云百炼 Embedding、pgvector | 会话持久化、Token 统计与知识库检索 |
| Native | Expo 57、React Native 0.86、React Native WebView、expo-location | 移动端 WebView 容器和定位 |
| 可选代码沙箱 | Judge0 | 隔离执行代码；需单独部署和启动 |

第三方能力还包括 Tavily 联网搜索、小云雀视频生成、高德地图定位/天气、Jamendo 音乐。文档生成分别使用 `python-docx`、`openpyxl`、`python-pptx`、`reportlab`。

## 基础配置与启动

### Web

- 配置入口：`Web/package.json`、`Web/vite.config.js`、`Web/src/config/index.ts`、`Web/.env.example`。Vite 的开发/预览 CORS 已开启，以便具有不透明来源的受限 Runtime iframe 加载本地、受信任的运行时模块；这不会向 Runtime 暴露主页面对象。
- 开发服务监听 `0.0.0.0:5173`；Vite 将 `/api` 代理到 `http://127.0.0.1:3001`。
- 使用 HashRouter，当前页面路由为 `#/`（首页）、`#/chat`（聊天）、`#/code`（代码沙箱 Demo）和 `#/weather`（天气页）。
- 聊天页可打开右侧“网页预览”。它使用同源 iframe 加载正在运行的 Vite 页面，默认预览首页；可切换首页、代码页，或输入新增路由（如 `/report`）。文件保存后，Vite HMR 会更新预览，面板也支持手动刷新。
- 高德 JSAPI 的前端变量为 `VITE_AMAP_JS_API_KEY` 和 `VITE_AMAP_JS_CODE`；按 `Web/.env.example` 配置。

```powershell
cd D:\Gor\Web
npm install
npm run dev
```

生产构建使用 `npm run build`，本地预览使用 `npm run preview`。

### Server

- 配置入口：`Server/config.py` 和 `Server/.env.example`。复制示例为 `Server/.env` 后填写实际密钥；不要提交真实 `.env`。
- 默认监听 `0.0.0.0:3001`，健康检查为 `GET /api/health`。
- 主要配置组：`ARK_*`（对话/视觉模型）、`SUPABASE_DB_URL`、`TAVILY_API_KEY`、`DASHSCOPE_*` / `EMBEDDING_*`、`XIAOYUNQUE_*`、`AMAP_WEB_SERVICE_KEY`、`PORT`、`CLIENT_ORIGIN`、`JUDGE0_URL`、`AGENT_*`。
- `ARK_MAX_OUTPUT_TOKENS`：单次模型输出上限，默认 16384，范围约束为 1024–32768，需使用支持该上限的模型。用于避免较长场景源码的工具 JSON 被原先固定的 4096 token 截断；上限提高不代表每次都消耗满额。Agent 遇到 `finish_reason=length` 或无效工具参数时不执行该轮写入、不自动重试，并显示错误提示；空响应也不再静默结束。
- `PROJECT_WORKSPACE_ROOT` 可配置 AI 文件工具的工作区，默认是项目的 `Web/` 目录。搜索与读取只允许指定文本源码类型；修改仅允许 `src/` 下的源码或 `index.html`，新建文件仅允许在 `src/` 下。`.env`、密钥相关名称、依赖、生成目录、路径穿越和符号链接均被拒绝；单文件上限 100 KB。模型没有任意 shell 执行工具。
- 服务启动时尝试初始化 PostgreSQL 会话表、消息表和模型额度表；若数据库连接失败，进程仍可能启动，但依赖持久化的功能会受影响。

```powershell
cd D:\Gor\Server
python -m venv venv
.\venv\Scripts\pip.exe install -r requirements.txt
$env:PYTHONIOENCODING = 'utf-8'
.\venv\Scripts\python.exe main.py
```

Windows 终端使用 UTF-8 输出可避免启动日志中的 emoji 因 GBK 编码报错。代码执行功能的默认 Judge0 地址是 `http://localhost:2358`，需要另行启动 Judge0；仅启动 FastAPI 不会启动沙箱。

### Native

- 配置入口：`Native/package.json`、`Native/app.json`、`Native/App.tsx`。
- 当前原生应用主要是 WebView 包装层；Web 平台使用 iframe 加载 Web 项目。
- `Native/App.tsx` 中真机访问地址目前写为局域网地址 `http://192.168.1.3:5173/`。换电脑或网络后，需要改成开发机实际可访问的地址，并确保 Web 与后端能被设备访问。

```powershell
cd D:\Gor\Native
npm install
npm start
```

也可使用 `npm run android`、`npm run ios`、`npm run web`。iOS 原生运行需要相应的 Apple 开发环境。

## 当前实现的功能

### 聊天与 AI

- 多会话创建、切换、历史消息加载与删除；服务端用 PostgreSQL 保存会话和消息。
- `POST /api/chat` 通过 SSE 推送思考状态、工具状态、回复内容、文件/视频结果及 Token 相关信息；支持停止生成。
- 上传或粘贴图片，前端压缩后发送，后端调用视觉模型解析。
- AI 回复支持 Markdown、代码块、表格、链接、文件下载卡片和视频播放。新生成的文件元数据会随消息保存，重新进入会话后仍可恢复文件列表。
- 深色/浅色主题及移动端悬浮会话栏；桌面会话栏可通过右边缘垂直居中的按钮收起或展开，状态保存到本地存储。会话数量统一显示为“0条”“2条”等小号文字。
- Chat 页面 UI 已统一为 shadcn/ui + Tailwind CSS + lucide-react：Header、Sidebar、消息状态、输入区、会话删除确认、Preview/Code 标签及 Preview 外围控件使用统一组件与图标。现有 Less 仅继续承担 Markdown、文件/视频内容、Preview Runtime 以及主题覆盖等复杂样式；聊天业务 Hook、SSE 协议和 Preview 架构未改变。
- Chat 已移除 Ant Design Mobile：原 Toast 改为项目内统一反馈提示，额度/上下文警告和会话删除使用 shadcn AlertDialog，流式加载状态使用 Lucide 动画。首页的天气刷新、快捷功能、每日进度及底部导航也使用 shadcn Button/Card。当前 Web 源码和依赖清单中均无 `antd` / `antd-mobile`。
- Agent 已注册天气、联网搜索、Word/Excel/PPT/PDF 生成、视频生成、知识库检索和 Python 沙箱执行工具。
- 默认聊天中的 React 页面生成与预览现在使用 `list_preview_files`、`read_preview_file`、`write_preview_file`：前端发送当前浏览器内存 Preview Project 的受限快照，Agent 按请求读取并生成虚拟源码，`preview_file_changed` SSE 事件返回 projectId、虚拟路径、完整内容与统一 diff。前端校验项目 ID 和路径后写入现有 Virtual FS，聊天气泡展示虚拟文件 diff，自动打开 Preview Worker 的 `Preview` 标签并在本轮生成完成后 Build & Run；真实 `Web/src` 不会被这些工具修改。
- 真实工作区的 `search_project_files`、`read_project_file`、`edit_project_file`、`create_project_file` 仍保留在 Server，但不暴露给默认聊天工具集。只有 API 请求显式传入 `workspaceEdit: true` 时才会向 Agent 开放；当前 Web 聊天界面不发送这个标志。既有 `project_file_changed`、真实 Vite 网页预览保留用于该显式路径，不再作为普通“生成网页并预览”的默认结果。
- 预览面板展示 Vite 页面加载状态、编译错误和浏览器运行错误。它不启动新的服务或运行模型生成的 shell 命令。
- 聊天顶部右侧的 **Preview Worker** 入口在有生成文件、当前会话存在虚拟项目变更或面板已打开时显示；生成文件数量角标只统计当前会话的生成文件。面板提供 `Preview`、`Code` 两个标签和独立关闭按钮。`Preview` 显示实际运行的虚拟 React 页面，`Code` 显示虚拟项目源码，二者各有可折叠的文件侧栏。桌面端 Build/Runtime 状态及操作按钮与标签位于同一顶部区域，底边使用单条分隔线。
- `Preview` 的侧栏列出虚拟项目网页入口和当前会话的生成文件，点击可切换预览；网页入口标题尝试从虚拟源码的标题、城市及天气内容概括为“广州天气.html”一类名称，无法识别时回退为项目名，因此动态生成的标题不保证总能准确识别。生成文件支持 Word、Excel、PPT、PDF、HTML、3D HTML 浏览；Word/Excel/PPT 由后端解析为有数量上限的只读结构，PDF/HTML 使用 iframe，生成文件保留下载入口。
- `Code` 使用完全位于浏览器内存中的 **Preview Project + Virtual FS**。它不读取或修改真实 `Web/src`，刷新页面后允许丢失。当前提供 HTML、React 两种源码模板、派生文件树、目录及整个侧栏展开/折叠、文件选择、源码查看与轻量文本编辑，以及新建测试文件、删除选中文件、重置项目等基础验证操作。
- Preview Project 现已具备浏览器端的编译链路：Virtual FS 经统一 Worker Client 同步到独立 Browser Web Worker，由 `esbuild-wasm` 编译 JS、JSX、TS、TSX 与 CSS。React 默认模板以 `/src/main.tsx` 为入口，可返回结构化 Build Result（JS/CSS 输出、warning、耗时、buildId）或结构化诊断信息。
- Preview Project 的 React Build Result 现可在独立的 Sandbox iframe Runtime 中真实运行。点击 `Build & Run` 会以完整 iframe reload 清理旧 DOM、CSS 和 React 状态，再将本次 Build Result 通过 `postMessage` 交给 Runtime；CSS 仅注入 iframe 自身文档。构建状态和运行状态分别显示，语法错误不会执行错误 Bundle。
- Runtime 会捕获 `error`、`unhandledrejection` 与 `console.log/info/warn/error`，以 structured-clone 安全的普通对象显示错误和控制台内容。每次通信绑定 `runtimeId`、`projectId`、`buildId`；Parent 还校验 `event.source === iframe.contentWindow`，忽略旧运行实例和伪造/过期消息。
- Three.js 是现有 Runtime 新增的本地固定依赖，而不是第二套预览系统。AI 可通过原有 Preview 文件工具生成 `/src/main.ts` 及多个 Geometry 场景模块，使用 `import * as THREE from 'three'` 或具名导入；Three.js 仅在 sandbox iframe 内创建 Renderer/Canvas。动画、相机与 ResizeObserver 由虚拟场景源码实现。默认 Agent 不再注册旧的 `create_3d_scene` 下载 HTML 工具，既有 Generated Files/HTML 预览仍保留。

### Preview Project 与 Virtual FS

Preview Project 的核心数据结构是可序列化的普通对象：

```ts
interface PreviewProject {
  id: string;
  name: string;
  template: 'html' | 'react';
  files: Record<string, string>;
}
```

- Virtual FS 的路径统一为 Unix 风格绝对路径，如 `/index.html`、`/src/App.tsx`。Windows 分隔符、重复 `/` 和 `.` 路径段会被规范化；任何 `..` 路径穿越都会被拒绝。
- Core 提供不可变的 `readFile`、`writeFile`、`deleteFile`、`fileExists`、`listFiles` 纯函数。文件树由 `files` 即时推导，不保存第二份树状态。
- React 默认模板包含 `/index.html`、`/src/main.tsx`、`/src/App.tsx`、`/src/style.css`；HTML 默认模板包含 `/index.html`、`/main.js`、`/style.css`。
- 状态层使用 React 自带的 `useSyncExternalStore` 管理内存状态；项目 `files` 只包含字符串键值，可直接通过 `structuredClone(files)`，也可在后续阶段作为 `postMessage` 数据发送给 Web Worker。
- 模块依赖保持为 UI → Store → Virtual FS Core → Path Utils；Template 由 Store 创建，File Tree UI 调用纯 `buildFileTree(files)` 派生目录结构。Core 和 Template 不依赖 React、DOM 或状态管理实现。
- 阶段三的 Worker Protocol 位于 `src/preview/runtime/workerProtocol.ts`，统一定义 `INIT`、`SYNC_FILES`、`BUILD`、`RESET` 和对应的 READY、同步、成功、错误消息。所有传输内容均为 structured-clone 兼容的普通对象；Worker 只使用收到的 Virtual FS Snapshot，不访问真实磁盘。
- Worker Client 集中创建、初始化、同步、构建、重置和释放 Worker；它通过 buildId 与项目 ID 防止过期结果更新界面。组件卸载和 Vite HMR 时会 terminate/dispose Worker，避免遗留编译请求。
- Virtual FS Resolver 复用 Path Utils，支持相对导入、无扩展名导入与 `index.ts` / `index.tsx` / `index.js` / `index.jsx`，并映射 ts、tsx、js、jsx、css、json Loader。依赖白名单为 `react`、`react-dom`、`react-dom/client`、`react/jsx-runtime`、`react/jsx-dev-runtime`、`three`；其他包、`three/addons`、`three/examples` 和 CDN 导入均得到 Build Error。不会在 Runtime 安装依赖。
- `core/entryPoint.ts` 从虚拟 `/index.html` 的首个 module script 的 src 选择编译入口（例如 `/src/main.ts`）；无声明则保留 React `/src/main.tsx`、HTML `/main.js` 默认值。入口仍经原有 Virtual FS Resolver 校验；不存在的入口会报 Build Error。虚拟 HTML 只提供入口和标题，不作为 Runtime DOM 执行；Runtime 仍只有固定的 root 容器，CSS 需要由源码 import。
- `Code` 标签提供可编辑源码文本区；`Preview` 顶部将 Build 与 Runtime 状态分别显示，Build Error 显示文件、行、列、消息和源码行。编译器仍在内部返回包含 buildId、输出文件、warning 的结构化 Build Result，但当前界面不展开这些产物详情。
- Runtime Protocol 位于 `src/preview/runtime/runtimeProtocol.ts`，Runtime Controller 位于 `runtimeController.ts`，受信任的 iframe Host 位于 `iframeRuntimeHost.ts`，入口页为 `Web/preview-runtime.html`。React/ReactDOM/Three.js 依赖被编译为 iframe 内置静态 Runtime 的 shim，Build Result 为 IIFE；Three.js 本体由项目构建时打包（`three` 与 `@types/three` 均固定 0.186.0），无需网络 CDN。每次 Run 完整重载 iframe，Reset/Dispose 导航至 `about:blank`，让旧文档、Canvas、动画循环和事件监听随文档销毁，而不是仅清空 root。
- 聊天与 Preview Project 的桥接不创建第二套文件系统：Server 的 `tools/preview_project.py` 对每次请求的虚拟文件快照进行路径、类型、数量和大小校验；Web 的 `previewProjectStore` 应用 SSE 变更并请求阶段四 Runtime 自动构建。请求内虚拟文件最多 40 个、单文件 100 KB、总计 500 KB，数据仅驻留浏览器内存和当前请求生命周期。切换/新建会话会重建默认 React 虚拟项目。
- iframe 属性固定为 `sandbox="allow-scripts"`，不含 `allow-same-origin`。Bundle 仅在该 iframe 中用 Blob module import 执行；Parent Window 不使用 `eval`、`new Function`、用户 bundle 的 script 注入或直接 import。
- 验证命令：在 `Web/` 运行 `npm run test:preview`。该脚本验证阶段二能力以及 Worker Protocol、路径/扩展解析、Loader、依赖 allowlist、诊断和 Build Result 的 structured-clone 兼容性。

### 首页及其他页面

- 首页展示快捷入口、定位天气、每日进度展示和音乐播放器。首页交互控件使用 shadcn Button/Card，视觉效果仍由 Tailwind 与 Less 的玻璃样式实现。音乐通过后端 `/api/music/random` 获取 Jamendo 曲目。
- 独立的 `#/code` 页面可提交代码到 `/api/judge/execute`，查看运行状态、标准输出、错误输出、耗时与内存。页面默认提交 Python（Judge0 language ID 71）。
- Native WebView 可接收 Web 的定位请求，通过 `expo-location` 获取设备位置并返回给 Web 页面。

### 主要后端接口

| 接口 | 用途 |
| --- | --- |
| `GET /api/health` | 健康检查 |
| `POST /api/chat` | SSE 流式对话 |
| `/api/chat/session/*`、`/api/chat/sessions` | 会话与消息管理 |
| `GET /api/weather` | 高德天气接口 |
| `GET /api/music/random` | 随机音乐 |
| `/api/video/*` | 视频任务查询与代理 |
| `GET /api/download/{filename}` | 下载生成文件 |
| `GET /api/preview/{filename}` | 安全解析生成的 Word、Excel、PPT，供 Preview Worker 只读展示 |
| `POST /api/judge/execute` | 代理 Judge0 执行代码 |

### 通过聊天生成虚拟 React 页面并预览（默认流程）

1. 启动 Web 与 Server，在 `#/chat` 发送“用 React 生成一个页面并在 Preview Worker 预览”。无需先手动打开预览项目。
2. Agent 读取浏览器传来的默认 React 模板快照，把完整文件写入虚拟 `/src/App.tsx`、`/src/style.css` 等路径。聊天回复显示虚拟文件列表及 diff，右侧 Preview Worker 自动切换到 `Preview`；在 `Code` 可单独查看或编辑这些虚拟源码。
3. 本轮生成完成后，Virtual FS 同步到 Browser Worker；`esbuild-wasm` 编译，再由受限 iframe 运行 React Build Result。Build Error 与 Runtime Error 分开显示，修复可在后续对话中继续修改同一内存项目。
4. 虚拟源码并非下载文件，也不会写入真实 `Web/src`；刷新页面后虚拟项目会丢失，切换/新建会话也会重建空白模板。历史聊天文本仍在数据库，但虚拟文件快照和结构化 diff 不会随历史恢复。

### 通过聊天生成 Three.js 3D 场景

1. 安装 Web 依赖后启动 Web 与 Server。在 Chat 发送“生成一个汽车模型在公路上行驶的 3D 场景。”，或描述房间、机器人、太阳系等几何场景；并非硬编码汽车模板。
2. Agent 使用 `list_preview_files` / `read_preview_file` / `write_preview_file` 生成完整虚拟源码，按复杂度拆分 main/car/road/environment 等模块，最后更新 `/index.html` 的 module 入口和场景标题。不会写入真实 `Web/src`，不会输出 GLB/OBJ 等模型文件。
3. `preview_file_changed` SSE → 同一 Preview Project/Virtual FS → Browser Web Worker → esbuild-wasm → Build Result → 原有 Runtime Controller → `sandbox="allow-scripts"` iframe → Three.js WebGL。生成结束自动 Build & Run，Preview 显示实际场景，Code 文件树查看或编辑全部虚拟源码。
4. 继续对话（例如“把汽车改成黄色并降低速度”）会读写当前虚拟源码，然后再次 Build & Run。无需刷新 Gor；手动编辑后可点击 Build & Run。每次运行完整重载，不是 Fast Refresh。
5. 场景代码负责 `ResizeObserver`、`renderer.setSize`、相机 aspect/projection 更新；提示词要求像素比上限为 2。WebGL 不可用或生成代码出错时沿用 Runtime Error；编译失败沿用 Build Error。模型生成质量不保证每次一次成功，可根据错误继续修正。

### 显式修改真实 Web 项目（独立旧流程）

1. 按上文分别启动 Web 的 Vite 服务和 Server 的 FastAPI 服务。确认 `http://localhost:5173/#/chat` 可访问。
2. 调用聊天 API 时显式设置 `workspaceEdit: true`，并描述要修改的真实工作区源码。当前 Web 聊天界面没有这个开关；仅在聊天文本中提出要求不会开启真实文件工具。
3. 成功写入后，聊天回复显示变更文件及可展开 diff，右侧网页预览自动打开。新建路由时，在预览面板输入该路由路径；也可手动切换页面或刷新。
4. 若代码无法编译，面板会显示 Vite 错误；修复并保存后，预览随 HMR 恢复。代码执行 Demo `#/code` 和 Judge0 与网页预览独立。

验证命令：在 `Web/` 运行 `npx tsc --noEmit` 和 `npm run build`；在 `Server/` 运行 `.\venv\Scripts\python.exe -m unittest discover -s tests -v`。若要运行会短暂修改并恢复首页文案的 Vite 联调测试，先启动 Vite，再设置 `PREVIEW_TEST_URL=http://127.0.0.1:5173` 后执行同一测试命令。

## 当前边界

- AI 可在聊天中生成代码；`execute_python` 的实际执行仍需要 Judge0 可达。网页预览直接加载 Vite 正在运行的页面，不依赖 Judge0，也不会自动启动或托管 Vite 进程。
- 默认虚拟文件工具完全不访问真实磁盘；其内容经聊天请求传到 Server 供 Agent 当前轮读取与修改，生成文件经 SSE 回到浏览器内存。真实文件工具仅在显式 `workspaceEdit: true` 路径启用，范围是配置的 Web 工作区而不是整个 `D:\Gor`；后端、Native、依赖清单和敏感配置不可由这些工具修改。两类 diff 均随当前聊天流显示，历史消息数据库尚不保存结构化 diff 或虚拟项目快照。
- Preview Worker 保留 `file_ready` 生成文件及历史 HTML 成品浏览；升级前历史消息只恢复正文明确写出且仍存在于受限 `src/` 下的 HTML，不扫描猜测文件。新的 3D 默认走虚拟 Three.js 源码 → 编译 → Runtime，不生成下载模型文件。Generated Preview 与 Preview Project 共享面板但保留各自内容来源。
- Preview Project 支持 React 与 Three.js Geometry 场景 Build Result 在 sandbox iframe 中运行，不读取或执行真实工作区源码。HTML 模板保留编译能力，但不提供通用 HTML 文档挂载 Runtime。
- 尚未实现 Vue Compiler/Runtime、GLB/GLTF/OBJ/FBX、模型上传/下载、外部模型生成 API、模型 Loader、R3F/Drei、物理引擎、专业 3D 编辑器、Gizmo、材质/骨骼编辑器；也未实现 Preview Project 数据库或 localStorage/IndexedDB 持久化、版本/快照、Undo/Redo、自动回滚、任意依赖安装或 Fast Refresh。已有 AI Preview Tools 与 FastAPI 聊天桥接，不应再记为“未实现”。
- HTML/3D 预览运行在受限 iframe 中，不授予同源访问权限；Office 预览为文本和表格的结构化近似呈现，不保证与桌面 Office 的字体、动画、复杂图形和分页完全一致。单个 Office 文件在线解析上限为 20 MB。
- 旧的真实 Vite 网页预览是同源开发模式，仅适用于可信本地源码；新的虚拟项目使用不透明源 sandbox iframe，不能读取 Parent DOM/State/Store，主页面不执行生成的 bundle。sandbox 与依赖白名单不是 CPU/GPU 配额或完整网络隔离：不可信场景仍可能占用资源或主动发起网络请求，应只在可信本地场景使用；没有自动回滚。`#/chat` 不支持嵌套预览。
- 知识库检索依赖 Embedding 服务及已建立的 `knowledge_vector` / pgvector 数据表和内容；当前源码中没有完整的上传与建库页面。
- 首页部分功能卡片只有展示数据，只有配置了 `to` 路由的 AI Chat 卡片会跳转；不要将这些展示项视为已实现的独立业务模块。
- 第三方 API 功能需要对应密钥、网络和额度；本文记录的是代码中的实现与配置入口，不保证外部服务始终可用。

## 开发计划

### 阶段三：Web Worker + esbuild-wasm 编译系统（已完成）

- 完成链路：Preview Project → Virtual FS → Worker Client → Browser Web Worker → esbuild-wasm → Build Result / Build Error。
- 阶段三交付时编译产物只作为结构化结果返回；当时不执行 bundle。后续阶段四增加了独立的受限 iframe Runtime，至今仍未在 Parent Window 中使用 `eval`、`new Function` 或用户 Bundle script injection，也没有放宽 Generated HTML/3D iframe 的 sandbox。
- 浏览器验收已验证 React 模板从 Ready 进入 Build Success，输出 `/out/bundle.js` 和 `/out/bundle.css`；制造 `/src/App.tsx` TSX 语法错误后显示文件、行、列和源码行，修复后无需刷新即可恢复 Success。

### 阶段四：Sandbox iframe React Runtime（已完成）

- 完成链路：Build Result → Runtime Controller → `sandbox="allow-scripts"` iframe → React/ReactDOM Runtime → Runtime Result。每次 Build & Run 均创建新的 runtimeId 并完整重载 iframe，旧 DOM、CSS、React State 和 listener 不会延续。
- Runtime 入口只加载项目内、构建时固定的 React/ReactDOM 模块；Worker 的 dependency allowlist 输出 shim 后，用户 Bundle 以 IIFE 通过消息传入 iframe 内并在 Blob module 中执行。Parent Window 从不执行或 import 用户 Bundle。
- Browser Parent 和 Runtime 同时验证协议元数据；Parent 要求消息源是当前 iframe 的 `contentWindow`，并匹配 runtimeId、projectId、buildId。组件卸载、项目切换和 Reset Runtime 都会清理 listener/iframe 状态。
- 浏览器验收：React 默认模板、App 文本修改和 CSS 修改均可 Build & Run 并在 iframe 中更新；TSX 语法错误显示 Build Error 且保留上次 Runtime；`throw new Error()` 与 `Promise.reject()` 均在 Build Success 后显示 Runtime Error，修复后恢复 Runtime Success；`console.log`/`console.info` 内容显示在 Runtime Console。全程未刷新 Gor 主页面。
- 最近一次相关验证：`npm run test:preview`（16 项通过）、`npx tsc --noEmit`（通过）、`npm run build`（通过）。
