/**
 * 账号登录状态：Web 与插件共用一套账号。
 * Web 靠同源 HttpOnly Cookie；插件的凭证由扩展存入 SecretStorage，Webview 只在内存中持有，
 * 由 vscode/vscodeRuntime.ts 的 fetch 包装统一附加到 /api 请求上。
 */
import { useSyncExternalStore } from 'react';
import { getChatClientMode } from '../utils/clientMode';
import { postVscodeMessage, setVscodeAuthToken, waitForVscodeAuthSaved } from '../vscode/vscodeRuntime';

export interface AuthUser {
  id: string;
  email: string;
  nickname: string;
  /** 头像更新时间（毫秒），没有头像时为 null。 */
  avatarVersion?: number | null;
}

export interface AuthState {
  status: 'loading' | 'ready';
  user: AuthUser | null;
}

let state: AuthState = { status: 'loading', user: null };
const listeners = new Set<() => void>();

function setState(next: AuthState): void {
  state = next;
  listeners.forEach((listener) => listener());
}

export function getAuthState(): AuthState {
  return state;
}

export function subscribeAuth(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useAuth(): AuthState {
  return useSyncExternalStore(subscribeAuth, getAuthState, getAuthState);
}

async function postJson(path: string, body?: unknown): Promise<any> {
  const response = await fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data: any = {};
  try { data = await response.json(); } catch { /* 非 JSON 错误页按状态码提示 */ }
  if (!response.ok) {
    const detail = typeof data?.detail === 'string' ? data.detail : '';
    throw new Error(detail || (response.status >= 500 ? '服务暂时不可用，请稍后再试' : '请求失败，请稍后再试'));
  }
  return data;
}

let currentUserRequest: Promise<AuthUser | null> | null = null;

/** 只查询一次当前用户；侧栏（桌面与手机抽屉）、头像等多处共用。 */
export function ensureCurrentUser(): Promise<AuthUser | null> {
  currentUserRequest ??= loadCurrentUser();
  return currentUserRequest;
}

/** 头像等账号资料更新后同步到登录状态。 */
export function updateAuthUser(user: AuthUser): void {
  if (state.user?.id === user.id) setState({ status: 'ready', user });
}

export async function loadCurrentUser(): Promise<AuthUser | null> {
  try {
    const response = await fetch('/api/auth/me', { credentials: 'same-origin' });
    const data = response.ok ? await response.json() : null;
    const user: AuthUser | null = data?.user ?? null;
    setState({ status: 'ready', user });
    return user;
  } catch {
    // 后端不可达时按未登录展示，不阻塞聊天页
    setState({ status: 'ready', user: null });
    return null;
  }
}

/** 插件把凭证交给扩展持久化，等写入确认后再刷新，避免刷新后取不到凭证。 */
async function persistPluginToken(token: string | null): Promise<void> {
  if (getChatClientMode() !== 'vscode') return;
  setVscodeAuthToken(token);
  const saved = waitForVscodeAuthSaved();
  postVscodeMessage(token ? { type: 'gor.saveAuthToken', token } : { type: 'gor.clearAuthToken' });
  await saved;
}

export async function login(email: string, password: string, remember: boolean): Promise<AuthUser> {
  const data = await postJson('/api/auth/login', { email, password, remember });
  await persistPluginToken(typeof data.token === 'string' ? data.token : null);
  setState({ status: 'ready', user: data.user });
  return data.user;
}

export async function register(nickname: string, email: string, password: string): Promise<AuthUser> {
  const data = await postJson('/api/auth/register', { nickname, email, password });
  await persistPluginToken(typeof data.token === 'string' ? data.token : null);
  setState({ status: 'ready', user: data.user });
  return data.user;
}

export async function logout(): Promise<void> {
  try {
    await postJson('/api/auth/logout');
  } finally {
    // 即使后端注销失败，本机也不再保留凭证
    await persistPluginToken(null);
    setState({ status: 'ready', user: null });
  }
}

const OPEN_FIRST_SESSION_KEY = 'gor-open-first-session';

/** 读取并清除「重载后打开第一个会话」的一次性标记（登录、注册后设置）。 */
export function consumeOpenFirstSession(): boolean {
  try {
    const flagged = localStorage.getItem(OPEN_FIRST_SESSION_KEY) === '1';
    localStorage.removeItem(OPEN_FIRST_SESSION_KEY);
    return flagged;
  } catch {
    return false;
  }
}

/**
 * 身份变化后会话命名空间随之改变：去掉旧身份的会话链接并整页重载，让各状态按新身份初始化。
 * openFirstSession：登录/注册后进入会话列表第一个（最近更新的）会话，而不是本机上次打开的会话。
 */
export function reloadForIdentityChange(openFirstSession = false): void {
  if (openFirstSession) {
    try { localStorage.setItem(OPEN_FIRST_SESSION_KEY, '1'); } catch { /* 存储不可用时按原有规则选会话 */ }
  }
  // VS Code Webview 的页面由扩展注入，页面自行 location.reload() 会变成空白（黑屏），
  // 由扩展重新设置 Webview 内容；新内容不带旧会话链接。
  if (getChatClientMode() === 'vscode' && postVscodeMessage({ type: 'gor.reloadWebview' })) return;
  const url = new URL(window.location.href);
  const [hashPath] = url.hash.split('?');
  url.hash = hashPath || '#/chat';
  url.searchParams.delete('sessionId');
  window.history.replaceState(null, '', url.href);
  window.location.reload();
}
