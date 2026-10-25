/**
 * app://gor/ 协议的纯逻辑（不依赖 Electron，便于离线测试）：
 *  - 静态文件：从 Web 构建产物目录读取，防止路径穿越；
 *  - /api 转发：由主进程转发到 Gor 后端，页面看到的是同源请求，Web 代码无需改动。
 *    桌面端以 X-Gor-Client: desktop 登录，后端把凭证放在响应体里；凭证只留在主进程，
 *    转发时以 Authorization: Bearer 附加，页面拿不到。
 */
import * as path from 'node:path';

export const APP_SCHEME = 'app';
export const APP_HOST = 'gor';
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  // esbuild-wasm 用 instantiateStreaming 加载，必须是 application/wasm
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
};

export function contentTypeFor(file: string): string {
  return MIME_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
}

/** 把 URL 路径解析为构建目录内的文件；越界、非法编码返回 null。根路径对应 index.html（页面用 hash 路由）。 */
export function resolveStaticFile(root: string, pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes('\0') || decoded.includes('\\')) return null;
  const relative = decoded === '/' || decoded === '' ? 'index.html' : decoded.replace(/^\/+/, '');
  const base = path.resolve(root);
  const target = path.resolve(base, relative);
  return target === base || !target.startsWith(base + path.sep) ? null : target;
}

/**
 * 是否为应用自身页面。主进程是 Node，它的 URL 解析不认识 app: 这个自定义协议，
 * `origin` 恒为 "null"，所以按协议与主机判断（用 origin 比较会把站内跳转和重载都当成外链拦掉）。
 */
export function isAppUrl(value: string): boolean {
  try {
    const url = new URL(value);
    // Node 不会把自定义协议的主机名转成小写，这里统一忽略大小写
    return url.protocol === `${APP_SCHEME}:` && url.host.toLowerCase() === APP_HOST && !url.username && !url.password;
  } catch {
    return false;
  }
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** 开发模式的 Web 开发服务器地址：只接受本机 http(s) 地址，返回其 origin；否则 null（按正式模式运行）。 */
export function resolveDevServerUrl(value: string | undefined): string | null {
  if (!value?.trim()) return null;
  try {
    const url = new URL(value.trim());
    if ((url.protocol === 'http:' || url.protocol === 'https:') && LOCAL_HOSTS.has(url.hostname) && !url.username && !url.password) {
      return url.origin;
    }
  } catch { /* 无效地址按正式模式运行 */ }
  return null;
}

/** 站内页面：正式模式为 app://gor，开发模式另含 Web 开发服务器的同源页面。 */
export function isInAppUrl(value: string, devOrigin: string | null): boolean {
  if (isAppUrl(value)) return true;
  if (!devOrigin) return false;
  try { return new URL(value).origin === devOrigin; } catch { return false; }
}

export function isApiPath(pathname: string): boolean {
  return pathname === '/api' || pathname.startsWith('/api/');
}

export interface TokenStore {
  get(): string | null;
  /** persist=false 时只保存在内存中（登录时未勾选「记住我」），退出应用即失效 */
  set(token: string, persist: boolean): Promise<void> | void;
  clear(): Promise<void> | void;
}

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface ApiForwarderOptions {
  apiBase: string;
  tokens: TokenStore;
  fetchImpl: FetchLike;
  log?: (message: string) => void;
}

// 这些请求头由转发方决定，不沿用页面发来的值
const STRIPPED_REQUEST_HEADERS = new Set([
  'host', 'origin', 'referer', 'cookie', 'authorization', 'x-gor-client', 'content-length', 'connection',
]);
// fetch 已经解压并按块读取，原样带回会让浏览器二次解码或长度不符
const STRIPPED_RESPONSE_HEADERS = new Set(['set-cookie', 'content-encoding', 'content-length', 'transfer-encoding', 'connection']);
const NULL_BODY_STATUS = new Set([101, 204, 205, 304]);

function jsonResponse(data: unknown, status: number): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
}

export function createApiForwarder({ apiBase, tokens, fetchImpl, log = () => undefined }: ApiForwarderOptions) {
  const base = new URL(apiBase);
  return async function forward(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const target = new URL(`${url.pathname}${url.search}`, base);
    const method = request.method.toUpperCase();

    const headers = new Headers();
    request.headers.forEach((value, key) => {
      if (!STRIPPED_REQUEST_HEADERS.has(key.toLowerCase())) headers.set(key, value);
    });
    headers.set('X-Gor-Client', 'desktop');
    const token = tokens.get();
    if (token) headers.set('Authorization', `Bearer ${token}`);

    const body = method === 'GET' || method === 'HEAD' ? undefined : new Uint8Array(await request.arrayBuffer());
    const issuesToken = method === 'POST' && (url.pathname === '/api/auth/login' || url.pathname === '/api/auth/register');
    // 注册即登录，按「记住我」处理；登录以请求体里的 remember 为准
    let persist = true;
    if (url.pathname === '/api/auth/login' && body) {
      try { persist = JSON.parse(new TextDecoder().decode(body))?.remember === true; } catch { persist = false; }
    }

    let response: Response;
    try {
      response = await fetchImpl(target.toString(), { method, headers, body, redirect: 'manual' });
    } catch (error) {
      log(`[Gor Desktop] API ${method} ${url.pathname} failed: ${error instanceof Error ? error.message : String(error)}`);
      return jsonResponse({ success: false, detail: '无法连接 Gor 服务，请确认后端已启动' }, 502);
    }

    if (method === 'POST' && url.pathname === '/api/auth/logout') await tokens.clear();

    if ((issuesToken && response.ok) || (url.pathname === '/api/auth/me' && response.ok && token)) {
      let data: any;
      try {
        data = await response.json();
      } catch {
        return jsonResponse({ success: false, detail: '服务返回了无法识别的数据' }, 502);
      }
      if (issuesToken && typeof data?.token === 'string') {
        await tokens.set(data.token, persist);
        delete data.token;
      } else if (!issuesToken && data && data.user === null) {
        // 凭证已过期或在别处被注销：本机一并清除
        await tokens.clear();
      }
      return jsonResponse(data, response.status);
    }

    const outHeaders = new Headers();
    response.headers.forEach((value, key) => {
      if (!STRIPPED_RESPONSE_HEADERS.has(key.toLowerCase())) outHeaders.set(key, value);
    });
    // SSE 等流式响应直接透传响应体，不缓冲
    return new Response(NULL_BODY_STATUS.has(response.status) ? null : response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: outHeaders,
    });
  };
}

/** 后端地址：环境变量优先，其次桌面端配置文件，最后默认本机 3001；只接受 http/https。 */
export function resolveApiBase(fromEnv: string | undefined, fromConfig: unknown, fallback = 'http://localhost:3001'): string {
  for (const candidate of [fromEnv, fromConfig]) {
    if (typeof candidate !== 'string' || !candidate.trim()) continue;
    try {
      const url = new URL(candidate.trim());
      if ((url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password) return url.origin;
    } catch { /* 忽略无效地址，继续下一个来源 */ }
  }
  return fallback;
}
