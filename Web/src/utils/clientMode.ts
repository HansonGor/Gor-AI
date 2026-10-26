/** web：浏览器与桌面端「云笺」；vscode：VS Code 插件；desktop：桌面端「书斋」（本机文件夹）。 */
export type ChatClientMode = 'web' | 'vscode' | 'desktop';

export function getChatClientMode(): ChatClientMode {
  if (typeof document === 'undefined') return 'web';
  const mode = document.documentElement.dataset.gorClientMode;
  return mode === 'vscode' || mode === 'desktop' ? mode : 'web';
}

/** 操作真实工作区（插件或书斋）而不是 Web 虚拟项目；这类模式不加载、不初始化 Preview。 */
export function isWorkspaceClientMode(mode: ChatClientMode = getChatClientMode()): boolean {
  return mode !== 'web';
}

/** Every request declares one provider; never send the other provider's context. */
export function projectClientContext(mode: ChatClientMode, workspaceId?: string) {
  return isWorkspaceClientMode(mode)
    ? { clientMode: mode, ...(workspaceId ? { workspaceId } : {}) }
    : { clientMode: mode };
}
