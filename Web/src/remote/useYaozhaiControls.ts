import { useCallback } from 'react';
import { useAuth } from '../user/auth';
import {
  getSelectedWorkspace, getWebMode, isWorkspaceUsable, isYaozhaiActive, refreshYaozhai, selectYaozhaiWorkspace, switchWebMode,
  useYaozhaiState, type WebMode,
} from './remoteRuntime';

/**
 * 浏览器遥斋的宿主逻辑，供聊天页接入纯展示的切换器、空状态与窄屏模式图标。
 * 桌面应用与插件中 enabled 为 false；未登录时只在已处于遥斋时显示切换器（便于切回云笺）。
 */
export function useYaozhaiControls() {
  const state = useYaozhaiState();
  const auth = useAuth();
  const isBrowser = typeof document !== 'undefined'
    && document.documentElement.dataset.gorDesktop !== 'true' && document.documentElement.dataset.gorClientMode !== 'vscode';
  const active = isYaozhaiActive();
  const mode: WebMode = active ? 'yaozhai' : getWebMode() === 'yaozhai' ? 'yaozhai' : 'yunjian';
  const signedIn = auth.user !== null;
  const selected = getSelectedWorkspace(state);
  return {
    /** 浏览器中显示切换器：已登录，或当前就在遥斋。 */
    enabled: isBrowser && (signedIn || active),
    active,
    mode,
    signedIn,
    authReady: auth.status === 'ready',
    state,
    selected,
    /** 遥斋可以发消息：选中的电脑在线且允许遥控。 */
    ready: active && signedIn && !state.revoked && isWorkspaceUsable(selected),
    switchMode: useCallback((next: WebMode) => switchWebMode(next), []),
    select: useCallback((remoteId: string) => selectYaozhaiWorkspace(remoteId), []),
    refresh: useCallback(() => { void refreshYaozhai(); }, []),
  };
}
