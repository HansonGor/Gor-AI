# Gor Desktop

用 Electron 承载现有 Web 前端的桌面端。第一版为 Web 模式：普通会话、与 Web 共用账号和会话，界面与 Web 一致。

## 开发（热更新）

先启动后端和 Web 开发服务器（`npm --prefix ../Web run dev`，即 http://localhost:5173），再：

```bash
npm install
npm run dev
```

- 窗口直接加载 Web 开发服务器：改前端代码保存后即时生效（Vite 热更新，不刷新页面）。
- 改 `src/` 下的主进程代码：自动重新编译并重启窗口；编译出错时保留当前窗口并打印错误。
- 关闭窗口即结束开发模式。开发模式用独立的用户数据目录 `Gor Dev`，可与已安装的正式版同时打开。
- 开发服务器地址可用环境变量 `GOR_DESKTOP_DEV_URL` 修改（只接受本机地址）。

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

详细说明见仓库根目录 `project.md` 的「桌面端 Desktop」一节。
