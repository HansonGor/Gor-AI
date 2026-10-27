/**
 * 遥斋（浏览器，PC 与手机）：遥控桌面端「书斋」。只在普通浏览器里生效，桌面应用与 VS Code 插件不安装。
 * - 模式记在本机（localStorage `gor.web.mode`，默认云笺）；遥斋时 clientMode 按 desktop 处理（书斋会话、不加载 Preview），
 *   但聊天请求不带真实工作区 ID，只带遥斋 ID 与本机设备标识，由服务端校验账号、开关与是否被断开后换成真实工作区；
 * - 书斋列表来自 /api/remote/workspaces，列表变化、施行审阅、被断开都经聊天页已有的推送连接收到；
 * - 施行卡片沿用插件与书斋同一套 gor.toolchain 消息，回答经 /api/remote/…/toolchain 转回桌面端。
 */
import { useSyncExternalStore } from 'react';
import { addSyncListener } from '../api/sync';
import { createUuid } from '../utils/uuid';
import { connectToolchainChannel, getToolchainRuns } from '../vscode/toolchainRuns';

export type WebMode = 'yunjian' | 'yaozhai';
export type YaozhaiWorkspace = {
  remoteId: string;
  deviceName: string;
  name: string;
  path: string;
  online: boolean;
  remoteAllowed: boolean;
};
export type YaozhaiState = {
  /** 已从服务端取到过列表。 */
  loaded: boolean;
  workspaces: YaozhaiWorkspace[];
  selectedId: string | null;
  /** 最近一次失败的原因（未登录、电脑未允许、被断开等），面向用户。 */
  error: string | null;
  /** 这台设备被电脑断开、或电脑关掉了遥控：挡住输入框，直到再次登记遥控成功。 */
  revoked: boolean;
};

export const WEB_MODE_KEY = 'gor.web.mode';
export const YAOZHAI_SELECTED_KEY = 'gor.yaozhai.workspace';
export const YAOZHAI_DEVICE_KEY = 'gor.yaozhai.device';
const HEARTBEAT_MS = 60_000;
const EMPTY: YaozhaiState = { loaded: false, workspaces: [], selectedId: null, error: null, revoked: false };

let installed = false;
let active = false;
let current: YaozhaiState = EMPTY;
let deviceId = '';
let heartbeat: ReturnType<typeof setInterval> | undefined;
let fetchImpl: typeof fetch = (...args) => fetch(...args);
const listeners = new Set<() => void>();
const toolchainListeners = new Set<(message: unknown) => void>();

function storageGet(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}

function storageSet(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch { /* 存储不可用时只在本次页面生效 */ }
}

function setState(patch: Partial<YaozhaiState>): void {
  current = { ...current, ...patch };
  for (const listener of [...listeners]) listener();
}

/** 浏览器与系统名，显示在电脑上的「正在遥控」列表里。 */
export function deviceLabel(userAgent: string = typeof navigator === 'undefined' ? '' : navigator.userAgent): string {
  const system = /iPhone/.test(userAgent) ? 'iPhone' : /iPad/.test(userAgent) ? 'iPad' : /Android/.test(userAgent) ? 'Android'
    : /Windows/.test(userAgent) ? 'Windows' : /Mac OS X|Macintosh/.test(userAgent) ? 'Mac' : /Linux/.test(userAgent) ? 'Linux' : '设备';
  const browser = /Edg\//.test(userAgent) ? 'Edge' : /Firefox\//.test(userAgent) ? 'Firefox'
    : /Chrome\/|CriOS\//.test(userAgent) ? 'Chrome' : /Safari\//.test(userAgent) ? 'Safari' : '浏览器';
  return `${system} · ${browser}`;
}

function normalizeWorkspaces(value: unknown): YaozhaiWorkspace[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => item && typeof item === 'object' && typeof item.remoteId === 'string' ? [{
    remoteId: item.remoteId.slice(0, 120),
    deviceName: typeof item.deviceName === 'string' ? item.deviceName.slice(0, 80) : '电脑',
    name: typeof item.name === 'string' ? item.name.slice(0, 255) : '书斋',
    path: typeof item.path === 'string' ? item.path.slice(0, 1024) : '',
    online: item.online === true,
    remoteAllowed: item.remoteAllowed === true,
  }] : []).slice(0, 50);
}

async function readDetail(response: Response): Promise<string> {
  try {
    const detail = (await response.json())?.detail;
    if (typeof detail === 'string' && detail) return detail;
  } catch { /* 非 JSON 时按状态码提示 */ }
  return response.status === 401 ? '遥斋需要先登录。' : `遥斋暂时不可用 (${response.status})`;
}

function post(path: string, body: unknown): Promise<Response> {
  return fetchImpl(path, {
    method: 'POST', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
}

export function isYaozhaiActive(): boolean {
  return active;
}

export function getWebMode(): WebMode {
  return storageGet(WEB_MODE_KEY) === 'yaozhai' ? 'yaozhai' : 'yunjian';
}

export function getSelectedWorkspace(state: YaozhaiState = current): YaozhaiWorkspace | null {
  return state.workspaces.find((item) => item.remoteId === state.selectedId) ?? null;
}

/** 选中的书斋在线且允许遥控时才算可用。 */
export function isWorkspaceUsable(workspace: YaozhaiWorkspace | null): workspace is YaozhaiWorkspace {
  return !!workspace && workspace.online && workspace.remoteAllowed;
}

/** 聊天请求携带的遥斋字段；没有可用书斋时返回 null（输入框此时已被挡住）。 */
export function getRemoteRequestContext(): { remoteWorkspaceId: string; remoteDeviceId: string } | null {
  if (!active || !current.selectedId) return null;
  return { remoteWorkspaceId: current.selectedId, remoteDeviceId: deviceId };
}

/** 取一次书斋列表；未登录或失败时给出原因。 */
export async function refreshYaozhai(): Promise<void> {
  if (!active) return;
  try {
    const response = await fetchImpl('/api/remote/workspaces', { credentials: 'same-origin' });
    if (!response.ok) {
      setState({ loaded: true, workspaces: [], error: await readDetail(response) });
      return;
    }
    const workspaces = normalizeWorkspaces((await response.json())?.workspaces);
    const selected = workspaces.find((item) => item.remoteId === current.selectedId);
    // 还没选过、或选过的已不在列表里：自动选第一个可用的
    const fallback = !selected ? workspaces.find(isWorkspaceUsable) : undefined;
    if (fallback) storageSet(YAOZHAI_SELECTED_KEY, fallback.remoteId);
    // 原因（被断开、电脑关了遥控）保留到下一次遥控成功（attach）时再清除
    setState({ loaded: true, workspaces, selectedId: fallback?.remoteId ?? current.selectedId });
    void attach();
  } catch {
    setState({ loaded: true, error: '无法连接 Gor 服务，请确认电脑与手机在同一网络。' });
  }
}

/** 告诉电脑「这台设备在遥控」，也作为心跳；被拒绝时显示原因。 */
async function attach(): Promise<void> {
  const workspace = getSelectedWorkspace();
  if (!active || !isWorkspaceUsable(workspace)) return;
  try {
    const response = await post(`/api/remote/workspaces/${encodeURIComponent(workspace.remoteId)}/attach`, { deviceId, label: deviceLabel() });
    if (!response.ok) {
      setState({ error: await readDetail(response), revoked: response.status === 403 });
      return;
    }
    if (current.error || current.revoked) setState({ error: null, revoked: false });
    // 补上打开页面之前就在等待回答的审阅（本机已有的卡片不重复）
    const pending = (await response.json().catch(() => null))?.pendingApprovals;
    if (Array.isArray(pending) && workspace.remoteId === current.selectedId) {
      const known = new Set(getToolchainRuns().map((run) => run.approvalId));
      for (const message of pending) {
        const approvalId = (message as { request?: { approvalId?: unknown } })?.request?.approvalId;
        if (typeof approvalId === 'string' && !known.has(approvalId)) for (const listener of [...toolchainListeners]) listener(message);
      }
    }
  } catch { /* 网络抖动：下次心跳再试 */ }
}

function detach(remoteId: string): void {
  void post(`/api/remote/workspaces/${encodeURIComponent(remoteId)}/detach`, { deviceId, label: deviceLabel() }).catch(() => undefined);
}

export function selectYaozhaiWorkspace(remoteId: string): void {
  if (!active || remoteId === current.selectedId) return;
  if (current.selectedId) detach(current.selectedId);
  storageSet(YAOZHAI_SELECTED_KEY, remoteId);
  setState({ selectedId: remoteId, error: null, revoked: false });
  void attach();
}

/** 切换云笺 / 遥斋：两种模式各有一份会话列表，回到新章并重载页面。 */
export function switchWebMode(mode: WebMode, target: Window = window): void {
  if (mode === getWebMode()) return;
  if (mode === 'yunjian' && current.selectedId) detach(current.selectedId);
  storageSet(WEB_MODE_KEY, mode);
  const url = new URL(target.location.href);
  url.hash = '#/chat';
  target.history.replaceState(null, '', url.href);
  target.location.reload();
}

function handleSyncEvent(event: { type: string } & Record<string, unknown>): void {
  if (event.type === 'remote_workspaces_changed') {
    void refreshYaozhai();
  } else if (event.type === 'remote_toolchain') {
    // 只显示当前遥控的书斋转来的审阅
    if (event.remoteId === current.selectedId) for (const listener of [...toolchainListeners]) listener(event.message);
  } else if (event.type === 'remote_revoked' && event.remoteId === current.selectedId) {
    if (event.reason === 'kicked' && event.deviceId !== deviceId) return;
    const name = getSelectedWorkspace()?.deviceName ?? '电脑';
    setState({ error: event.reason === 'kicked' ? `${name} 已断开这台设备的遥控。` : `${name} 已关闭网页遥控。`, revoked: true });
    void refreshYaozhai();
  }
}

/**
 * main.tsx 启动时调用（在桌面端运行时之后）：只在普通浏览器、且上次选择了遥斋时生效。
 * 遥斋需要登录；未登录时列表接口返回原因，界面据此提示。
 */
export function installYaozhaiRuntime(options: { fetchImpl?: typeof fetch } = {}): void {
  if (installed) return;
  const root = document.documentElement;
  if (root.dataset.gorDesktop === 'true' || root.dataset.gorClientMode === 'vscode') return;
  installed = true;
  if (options.fetchImpl) fetchImpl = options.fetchImpl;
  if (getWebMode() !== 'yaozhai') return;
  active = true;
  root.dataset.gorClientMode = 'desktop';
  root.dataset.gorRemote = 'true';
  deviceId = storageGet(YAOZHAI_DEVICE_KEY) ?? '';
  if (!/^[\w-]{8,80}$/.test(deviceId)) {
    deviceId = createUuid();
    storageSet(YAOZHAI_DEVICE_KEY, deviceId);
  }
  current = { ...EMPTY, selectedId: storageGet(YAOZHAI_SELECTED_KEY) };
  // 施行卡片：与插件、书斋同一套消息；回答转给当前遥控的书斋
  connectToolchainChannel((message) => {
    const workspace = getSelectedWorkspace();
    if (!workspace) return false;
    void post(`/api/remote/workspaces/${encodeURIComponent(workspace.remoteId)}/toolchain`, { deviceId, message })
      .then(async (response) => { if (!response.ok) setState({ error: await readDetail(response) }); })
      .catch(() => setState({ error: '回答没能送达电脑，请检查网络后重试。' }));
    return true;
  }, (listener) => { toolchainListeners.add(listener); });
  addSyncListener((event) => handleSyncEvent(event as { type: string } & Record<string, unknown>));
  void refreshYaozhai();
  heartbeat = setInterval(() => { void attach(); }, HEARTBEAT_MS);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useYaozhaiState(): YaozhaiState {
  return useSyncExternalStore(subscribe, () => current, () => current);
}

/** 测试用：重置模块状态。 */
export function resetYaozhaiRuntimeForTests(): void {
  if (heartbeat) clearInterval(heartbeat);
  heartbeat = undefined;
  installed = false;
  active = false;
  current = EMPTY;
  deviceId = '';
  fetchImpl = (...args) => fetch(...args);
  listeners.clear();
  toolchainListeners.clear();
}
