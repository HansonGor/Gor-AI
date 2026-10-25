/**
 * Gor 桌面端第一版：用 Electron 承载现有 Web 前端（Web 模式、普通会话，与 Web 共用账号与会话），不改界面。
 * 页面经 app://gor/ 加载；/api 由主进程转发到后端（默认 http://localhost:3001，可用环境变量
 * GOR_DESKTOP_API_BASE 或用户数据目录下 config.json 的 apiBase 修改）。
 */
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { app, BrowserWindow, net, protocol, safeStorage, shell } from 'electron';
import {
  APP_HOST, APP_ORIGIN, APP_SCHEME, contentTypeFor, createApiForwarder, isApiPath, isInAppUrl, resolveApiBase, resolveDevServerUrl,
  resolveStaticFile,
} from './protocol';
import { createTokenStore } from './tokenStore';
import { TITLE_BAR_OVERLAY, usesOverlayTitleBar, WINDOW_CHROME_CSS } from './windowChrome';

// 标准、安全的自定义协议：页面拥有稳定的同源环境（存储、Worker、fetch、Preview 的模块脚本都可用）
protocol.registerSchemesAsPrivileged([{
  scheme: APP_SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, codeCache: true },
}]);

const log = (message: string) => console.log(message);
let mainWindow: BrowserWindow | null = null;

// 开发态用独立的用户数据目录：与已安装的正式版互不抢单实例锁，登录状态也分开；
// GOR_DESKTOP_PROFILE=xxx 再开一个互不干扰的开发实例（目录「Gor Dev xxx」），用来在一台电脑上测多端同步
if (!app.isPackaged) {
  const profile = process.env.GOR_DESKTOP_PROFILE?.trim().replace(/[^\w-]/g, '');
  app.setPath('userData', path.join(app.getPath('appData'), profile ? `Gor Dev ${profile}` : 'Gor Dev'));
}

// 开发模式（npm run dev）：直接加载 Web 开发服务器，前端改动热更新；打包后的正式版忽略该设置
const devOrigin = app.isPackaged ? null : resolveDevServerUrl(process.env.GOR_DESKTOP_DEV_URL);
const isAppUrl = (value: string) => isInAppUrl(value, devOrigin);

function webRoot(): string {
  // 打包后 Web 构建产物位于 resources/web；开发时直接用仓库里的 Web/dist
  return app.isPackaged ? path.join(process.resourcesPath, 'web') : path.resolve(__dirname, '../../Web/dist');
}

async function readConfigApiBase(): Promise<unknown> {
  try {
    return JSON.parse(await fs.readFile(path.join(app.getPath('userData'), 'config.json'), 'utf8'))?.apiBase;
  } catch {
    return undefined;
  }
}

async function serveStatic(root: string, pathname: string): Promise<Response> {
  const file = resolveStaticFile(root, pathname);
  if (!file) return new Response('Not found', { status: 404 });
  try {
    const data = await fs.readFile(file);
    return new Response(data, {
      headers: {
        'Content-Type': contentTypeFor(file),
        // Preview 运行时 iframe 是无源沙箱，加载本地模块脚本需要 CORS 放行
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache',
      },
    });
  } catch {
    return new Response('Not found', { status: 404 });
  }
}

function openExternally(value: string): void {
  try {
    const url = new URL(value);
    if (url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'mailto:') void shell.openExternal(url.toString());
  } catch { /* 忽略无效地址 */ }
}

function createWindow(): BrowserWindow {
  const overlayTitleBar = usesOverlayTitleBar(process.platform);
  const window = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 380,
    minHeight: 560,
    title: 'Gor',
    backgroundColor: '#101829',
    autoHideMenuBar: true,
    show: false,
    // Windows：去掉系统标题栏，窗口按钮浮在页面右上角（macOS/Linux 暂保留系统标题栏）
    ...(overlayTitleBar ? { titleBarStyle: 'hidden' as const, titleBarOverlay: TITLE_BAR_OVERLAY } : {}),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  if (overlayTitleBar) {
    // 每次页面加载（含登录后的重载）都注入拖动区与让位样式
    window.webContents.on('dom-ready', () => { void window.webContents.insertCSS(WINDOW_CHROME_CSS); });
  }
  window.once('ready-to-show', () => window.show());
  // 站外链接交给系统浏览器；应用内新窗口（如在新窗口打开预览）仍在桌面端打开
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isAppUrl(url)) return { action: 'allow' };
    openExternally(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    if (isAppUrl(url)) return;
    event.preventDefault();
    openExternally(url);
  });
  void window.loadURL(`${devOrigin ?? APP_ORIGIN}/#/chat`);
  return window;
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(async () => {
    const apiBase = resolveApiBase(process.env.GOR_DESKTOP_API_BASE, await readConfigApiBase());
    const tokens = createTokenStore(path.join(app.getPath('userData'), 'auth-token.bin'), {
      available: () => safeStorage.isEncryptionAvailable(),
      encrypt: (text) => safeStorage.encryptString(text),
      decrypt: (data) => safeStorage.decryptString(data),
    }, log);
    await tokens.load();
    const forward = createApiForwarder({ apiBase, tokens, fetchImpl: (input, init) => net.fetch(input, init), log });
    const root = webRoot();
    log(devOrigin
      ? `[Gor Desktop] Dev mode: ${devOrigin}（前端热更新，/api 经开发服务器代理）`
      : `[Gor Desktop] Web: ${root}  API: ${apiBase}`);

    protocol.handle(APP_SCHEME, (request) => {
      const url = new URL(request.url);
      if (url.host !== APP_HOST) return new Response('Not found', { status: 404 });
      return isApiPath(url.pathname) ? forward(request) : serveStatic(root, url.pathname);
    });

    mainWindow = createWindow();
    mainWindow.on('closed', () => { mainWindow = null; });
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
