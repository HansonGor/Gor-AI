export type ChatClientMode = 'web' | 'vscode';

export function getChatClientMode(): ChatClientMode {
  return typeof document !== 'undefined' && document.documentElement.dataset.gorClientMode === 'vscode' ? 'vscode' : 'web';
}

/** Every request declares one provider; never send the other provider's context. */
export function projectClientContext(mode: ChatClientMode, workspaceId?: string) {
  return mode === 'vscode'
    ? { clientMode: mode, ...(workspaceId ? { workspaceId } : {}) }
    : { clientMode: mode };
}
