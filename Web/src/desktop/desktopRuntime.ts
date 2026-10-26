/**
 * 桌面端适配层：只有 Electron preload 注入了 window.gorDesktop 时才生效，浏览器与 VS Code 插件不受影响。
 * - 「云笺」即现有 Web 模式；「书斋」把 clientMode 设为 desktop，会话、请求与书斋登记都按本机工作区处理；
 * - 模式记在本机（localStorage），切换时回到新章并重载页面，让会话列表、Preview 等按新模式重新初始化；
 * - 书斋状态来自主进程，页面只读状态并经桥接请求「选文件夹 / 重开最近 / 收起 / 在资源管理器中显示」。
 */
import { useSyncExternalStore } from 'react';

export type DesktopMode = 'yunjian' | 'shuzhai';
export type ShuzhaiFolder = { path: string; name: string };
export type ShuzhaiRecent = ShuzhaiFolder & { openedAt: number };
export type ShuzhaiConnection = 'idle' | 'connecting' | 'connected' | 'disconnected';
export type ShuzhaiState = {
  folder: ShuzhaiFolder | null;
  recent: ShuzhaiRecent[];
  connection: ShuzhaiConnection;
  workspaceId: string | null;
};
export type ShuzhaiOpenResult = { ok: boolean; reason?: string; state: ShuzhaiState };

export type ShuzhaiBridge = {
  getState(): Promise<ShuzhaiState>;
  pickFolder(): Promise<ShuzhaiOpenResult>;
  openRecent(folderPath: string): Promise<ShuzhaiOpenResult>;
  close(): Promise<ShuzhaiState>;
  reveal(): Promise<boolean>;
  onState(listener: (state: ShuzhaiState) => void): () => void;
};

declare global {
  interface Window {
    gorDesktop?: { shuzhai?: ShuzhaiBridge };
  }
}

export const DESKTOP_MODE_KEY = 'gor.desktop.mode';
const EMPTY_STATE: ShuzhaiState = { folder: null, recent: [], connection: 'idle', workspaceId: null };

let bridge: ShuzhaiBridge | undefined;
let current: ShuzhaiState = EMPTY_STATE;
const listeners = new Set<() => void>();
const workspaceWaiters = new Set<(workspaceId: string) => void>();

function readStoredMode(): DesktopMode {
  try {
    return localStorage.getItem(DESKTOP_MODE_KEY) === 'shuzhai' ? 'shuzhai' : 'yunjian';
  } catch {
    return 'yunjian';
  }
}

function normalizeState(value: unknown): ShuzhaiState {
  const raw = (value && typeof value === 'object' ? value : {}) as Partial<ShuzhaiState>;
  const folder = raw.folder && typeof raw.folder.path === 'string' && typeof raw.folder.name === 'string'
    ? { path: raw.folder.path, name: raw.folder.name } : null;
  const recent = Array.isArray(raw.recent)
    ? raw.recent.filter((item) => item && typeof item.path === 'string' && typeof item.name === 'string')
      .map((item) => ({ path: item.path, name: item.name, openedAt: Number(item.openedAt) || 0 }))
    : [];
  const connection = (['idle', 'connecting', 'connected', 'disconnected'] as const).includes(raw.connection as ShuzhaiConnection)
    ? raw.connection as ShuzhaiConnection : 'idle';
  const workspaceId = typeof raw.workspaceId === 'string' && raw.workspaceId ? raw.workspaceId : null;
  return { folder, recent, connection, workspaceId };
}

/** 主进程推来的状态：书斋模式下把已登记的工作区 ID 写到根元素，供聊天请求携带。 */
export function applyShuzhaiState(value: unknown): void {
  current = normalizeState(value);
  if (getDesktopMode() === 'shuzhai') {
    const ready = current.folder && current.connection === 'connected' ? current.workspaceId : null;
    if (ready) {
      document.documentElement.dataset.gorWorkspaceId = ready;
      for (const resolve of [...workspaceWaiters]) resolve(ready);
      workspaceWaiters.clear();
    } else {
      delete document.documentElement.dataset.gorWorkspaceId;
    }
  }
  for (const listener of [...listeners]) listener();
}

export function isDesktopApp(): boolean {
  return Boolean(bridge);
}

export function getDesktopMode(): DesktopMode | null {
  if (!bridge) return null;
  return document.documentElement.dataset.gorClientMode === 'desktop' ? 'shuzhai' : 'yunjian';
}

/** main.tsx 启动时调用；不在桌面端时什么也不做。 */
export function installDesktopRuntime(target: Window = window): void {
  const candidate = target.gorDesktop?.shuzhai;
  if (!candidate || typeof candidate.getState !== 'function') return;
  bridge = candidate;
  document.documentElement.dataset.gorDesktop = 'true';
  if (readStoredMode() === 'shuzhai') document.documentElement.dataset.gorClientMode = 'desktop';
  bridge.onState(applyShuzhaiState);
  void bridge.getState().then(applyShuzhaiState).catch(() => undefined);
}

/** 书斋模式下发送前最多等 timeoutMs 让书斋完成登记；超时返回 undefined，服务端会如实说明未连接。 */
export function waitForShuzhaiWorkspace(timeoutMs = 5_000): Promise<string | undefined> {
  const ready = current.folder && current.connection === 'connected' ? current.workspaceId : null;
  if (ready) return Promise.resolve(ready);
  if (!current.folder) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    const finish = (workspaceId?: string) => {
      clearTimeout(timer);
      workspaceWaiters.delete(finish);
      resolve(workspaceId);
    };
    const timer = setTimeout(() => finish(undefined), timeoutMs);
    workspaceWaiters.add(finish);
  });
}

/** 切换云笺 / 书斋：两种模式各有一份会话列表，回到新章并重载页面。 */
export function switchDesktopMode(mode: DesktopMode, target: Window = window): void {
  if (!bridge || mode === getDesktopMode()) return;
  try {
    localStorage.setItem(DESKTOP_MODE_KEY, mode);
  } catch { /* 存储不可用时本次仍按选择重载，下次启动回到云笺 */ }
  if (mode === 'shuzhai') document.documentElement.dataset.gorClientMode = 'desktop';
  else document.documentElement.dataset.gorClientMode = 'web';
  const url = new URL(target.location.href);
  url.hash = '#/chat';
  target.history.replaceState(null, '', url.href);
  target.location.reload();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useShuzhaiState(): ShuzhaiState {
  return useSyncExternalStore(subscribe, () => current, () => current);
}

export const shuzhai = {
  pickFolder: () => bridge?.pickFolder().then((result) => { applyShuzhaiState(result.state); return result; }),
  openRecent: (folderPath: string) => bridge?.openRecent(folderPath).then((result) => { applyShuzhaiState(result.state); return result; }),
  close: () => bridge?.close().then((state) => { applyShuzhaiState(state); return state; }),
  reveal: () => bridge?.reveal(),
};

/** 测试用：重置模块状态。 */
export function resetDesktopRuntimeForTests(): void {
  bridge = undefined;
  current = EMPTY_STATE;
  listeners.clear();
  workspaceWaiters.clear();
}
