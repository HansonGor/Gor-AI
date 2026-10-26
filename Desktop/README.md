# Gor Desktop

用 Electron 承载现有 Web 前端的桌面端，两种模式：

- **云笺**（Web 模式）：普通会话、与 Web 共用账号和会话，界面与 Web 一致。
- **书斋**（本地模式，侧栏顶部「云笺 | 书斋」切换）：把本机一个项目文件夹登记为 Gor 工作区，Agent 直接读写其中的文件、运行工具链，能力与 VS Code 插件一致。

## 开发（热更新）

先启动后端和 Web 开发服务器（`npm --prefix ../Web run dev`，即 http://localhost:5173），再：

```bash
npm --prefix ../workspace-core install   # 首次：公共工作区核心的依赖
npm install
npm run dev
```

- 窗口直接加载 Web 开发服务器：改前端代码保存后即时生效（Vite 热更新，不刷新页面）。
- 改 `src/` 下的主进程代码：自动重新编译并重启窗口；编译出错时保留当前窗口并打印错误。
- 关闭窗口即结束开发模式。开发模式用独立的用户数据目录 `Gor Dev`，可与已安装的正式版同时打开。
- 开发服务器地址可用环境变量 `GOR_DESKTOP_DEV_URL` 修改（只接受本机地址）。

### 桌面图标（Windows）

```powershell
powershell -File Desktop\scripts\create-dev-shortcut.ps1
```

在桌面生成「Gor 开发版」图标（带橙色 DEV 角标，图标文件生成在 `Desktop/out/gor-dev.ico`；放在 `%APPDATA%` 时资源管理器读不出，桌面会显示空白图标）。双击运行 `scripts/dev-launch.ps1`：后端（3001）、Web 开发服务器（5173）没在跑就先在后台启动，已在跑的直接复用，再打开开发模式窗口。关闭窗口只结束桌面端，后端与 Web 继续在后台运行；日志在 `%APPDATA%\Gor Dev\logs`。

## 以正式方式运行

```bash
npm --prefix ../Web run build   # 生成 Web/dist
npm start                       # 编译主进程并按 app://gor 加载构建产物
```

后端默认 `http://localhost:3001`。可用环境变量 `GOR_DESKTOP_API_BASE`，或在用户数据目录（Windows：`%APPDATA%\Gor`）放 `config.json`：

```json
{ "apiBase": "https://gor.example.com" }
```

## 测试与打包

```bash
npm test        # 协议、转发、凭证相关单元测试
npm run dist    # 构建 Web 与主进程，输出 Windows 安装包到 release/
```

## 结构

- `src/protocol.ts`：`app://gor/` 静态文件解析、`/api` 转发与登录凭证处理（不依赖 Electron，可离线测试）
- `src/tokenStore.ts`：登录凭证用系统加密保存，不明文落盘
- `src/main.ts`：Electron 窗口、协议注册、外链与单实例
- `src/shuzhai.ts`：书斋服务（选文件夹与最近列表、登记连接、请求分发），本机读写由 `../workspace-core` 的本机宿主完成
- `src/preload.ts`：只向页面暴露 `window.gorDesktop.shuzhai`（状态、选文件夹、重开最近、收起、在资源管理器中显示）

详细说明见仓库根目录 `project.md` 的「桌面端 Desktop」一节。
