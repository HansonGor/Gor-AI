import { useSyncExternalStore } from 'react';

/**
 * 全局界面偏好：是否显示思考过程卡片。只影响展示，思考照常进行、记录照常保存。
 * 存在浏览器 localStorage；不可用（隐私模式、被禁用）时退回内存值，默认显示。
 */
const KEY = 'gor:show-thinking';
const listeners = new Set<() => void>();
let memory: boolean | null = null;

function read(): boolean {
  if (memory !== null) return memory;
  try {
    const stored = globalThis.localStorage?.getItem(KEY);
    memory = stored === null || stored === undefined ? true : stored !== 'false';
  } catch {
    memory = true;
  }
  return memory;
}

export function setShowThinking(value: boolean): void {
  memory = value;
  try { globalThis.localStorage?.setItem(KEY, value ? 'true' : 'false'); } catch { /* 仅保留本次会话内存值 */ }
  listeners.forEach(listener => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useShowThinking(): boolean {
  return useSyncExternalStore(subscribe, read, () => true);
}

/** 仅供测试重置。 */
export function resetShowThinkingForTests(): void {
  memory = null;
}
