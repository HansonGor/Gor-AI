/** Runtime-only URL adaptation for the existing Gor chat page inside VS Code. */
import { installToolchainBridge } from './toolchainRuns';

let vscodeApi: { postMessage: (message: unknown) => void } | undefined;
export function postVscodeMessage(message: unknown): boolean {
  if (!vscodeApi) return false;
  vscodeApi.postMessage(message); return true;
}

// 账号凭证只存在扩展的 SecretStorage 与这里的内存中；Webview 启动时向扩展索取一次。
const AUTH_TOKEN_WAIT_MS = 1500;
let authToken: string | null = null;
let authTokenReady: Promise<void> = Promise.resolve();
const authSavedWaiters = new Set<() => void>();

export function setVscodeAuthToken(token: string | null): void {
  authToken = token;
}

/** 等扩展确认凭证已写入（或已清除）；超时后照常继续，最坏情况是刷新后需重新登录。 */
export function waitForVscodeAuthSaved(timeoutMs = 3_000): Promise<void> {
  if (!vscodeApi) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => { clearTimeout(timer); authSavedWaiters.delete(finish); resolve(); };
    const timer = window.setTimeout(finish, timeoutMs);
    authSavedWaiters.add(finish);
  });
}

function requestStoredAuthToken(): void {
  authTokenReady = new Promise((resolve) => {
    const finish = () => { clearTimeout(timer); window.removeEventListener('message', onMessage); resolve(); };
    const onMessage = (event: MessageEvent) => {
      if (event.data?.type !== 'gor.authToken') return;
      authToken = typeof event.data.token === 'string' && event.data.token ? event.data.token : null;
      finish();
    };
    const timer = window.setTimeout(finish, AUTH_TOKEN_WAIT_MS);
    window.addEventListener('message', onMessage);
  });
  vscodeApi?.postMessage?.({ type: 'gor.authTokenRequest' });
}
export function installVscodeWebviewRuntime(): void {
  // Keep VS Code conversations in their own server-side session namespace.
  document.documentElement.dataset.gorClientMode = 'vscode';
  let activeWorkspaceId: string | undefined;
  const workspaceIdWaiters = new Set<(workspaceId: string) => void>();
  window.addEventListener('message', (event: MessageEvent) => {
    const data = event.data;
    if (data?.type === 'gor.authTokenSaved') {
      [...authSavedWaiters].forEach((resolve) => resolve());
      return;
    }
    if (!data || typeof data !== 'object' || data.type !== 'gor.workspaceContext') return;
    activeWorkspaceId = typeof data.workspaceId === 'string' ? data.workspaceId : undefined;
    if (activeWorkspaceId) {
      document.documentElement.dataset.gorWorkspaceId = activeWorkspaceId;
      for (const resolve of workspaceIdWaiters) resolve(activeWorkspaceId);
      workspaceIdWaiters.clear();
    } else {
      delete document.documentElement.dataset.gorWorkspaceId;
    }
  });
  vscodeApi = (window as any).acquireVsCodeApi?.();
  vscodeApi?.postMessage?.({ type: 'gor.workspaceContextReady' });
  requestStoredAuthToken();
  installToolchainBridge(postVscodeMessage);

  const apiMeta = document.querySelector<HTMLMetaElement>('meta[name="gor-api-base"]');
  const assetsMeta = document.querySelector<HTMLMetaElement>('meta[name="gor-assets-base"]');
  const apiBaseValue = apiMeta?.content;
  const assetsBaseValue = assetsMeta?.content;
  if (!apiBaseValue || apiBaseValue.startsWith('__GOR_') || !assetsBaseValue || assetsBaseValue.startsWith('__GOR_')) return;

  let apiBase: URL;
  let assetsBase: URL;
  try {
    apiBase = new URL(apiBaseValue);
    assetsBase = new URL(assetsBaseValue.endsWith('/') ? assetsBaseValue : `${assetsBaseValue}/`);
  } catch {
    console.error('[Gor VS Code] Invalid API or webview resource URL.');
    return;
  }

  document.body.classList.add('gor-vscode-host');

  const apiUrl = (path: string) => new URL(path.replace(/^\/+/, ''), `${apiBase.origin}/`).toString();
  const assetUrl = (path: string) => new URL(path.replace(/^\/+/, ''), assetsBase).toString();
  const isApiPath = (pathname: string) => pathname === '/api' || pathname.startsWith('/api/');
  const waitForWorkspaceId = (timeoutMs = 3_000): Promise<string | undefined> => {
    if (activeWorkspaceId) return Promise.resolve(activeWorkspaceId);
    return new Promise((resolve) => {
      const finish = (workspaceId?: string) => {
        clearTimeout(timer);
        workspaceIdWaiters.delete(onWorkspaceId);
        resolve(workspaceId);
      };
      const onWorkspaceId = (workspaceId: string) => finish(workspaceId);
      const timer = window.setTimeout(() => finish(), timeoutMs);
      workspaceIdWaiters.add(onWorkspaceId);
    });
  };

  const originalFetch = window.fetch.bind(window);
  window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = input instanceof Request ? input.url : input instanceof URL ? input.href : input;
    let parsed: URL;
    try {
      parsed = new URL(raw, document.baseURI);
    } catch {
      return originalFetch(input, init);
    }
    if (!isApiPath(parsed.pathname)) return originalFetch(input, init);

    // 首批请求（会话列表等）要等扩展交回已存凭证，否则会按未登录读到 default:vscode 的列表。
    await authTokenReady;
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
    headers.set('X-Gor-Client', 'vscode');
    if (authToken) headers.set('Authorization', `Bearer ${authToken}`);
    else headers.delete('Authorization');
    let requestInit: RequestInit | undefined = { ...init, headers };
    if (parsed.pathname === '/api/chat' && typeof init?.body === 'string') {
      try {
        const body = JSON.parse(init.body);
        if (body && typeof body === 'object' && !Array.isArray(body)) {
          const chatBody = { ...body, clientMode: 'vscode' } as Record<string, unknown>;
          for (const key of Object.keys(chatBody)) {
            if (key.startsWith('previewProject') || key.startsWith('previewServer') || key.startsWith('previewContent') || key === 'newPreviewProject') delete chatBody[key];
          }
          // A chat submitted immediately after opening the view can race the
          // extension's WebSocket registration. Wait briefly for the handshake
          // instead of silently sending a write request without its workspace.
          const workspaceId = activeWorkspaceId ?? await waitForWorkspaceId();
          if (workspaceId) chatBody.workspaceId = workspaceId;
          else delete chatBody.workspaceId;
          requestInit = {
            ...requestInit,
            body: JSON.stringify(chatBody),
          };
        }
      } catch {
        // Leave malformed/non-JSON requests untouched; normal Chat requests are JSON.
      }
    }
    if (parsed.origin === apiBase.origin) return originalFetch(input, requestInit);

    const target = apiUrl(`${parsed.pathname}${parsed.search}${parsed.hash}`);
    if (input instanceof Request) return originalFetch(new Request(target, input), requestInit);
    return originalFetch(target, requestInit);
  }) as typeof window.fetch;

  const rewriteElement = (element: Element) => {
    for (const attribute of ['src', 'href']) {
      const value = element.getAttribute(attribute);
      if (!value || !value.startsWith('/')) continue;
      if (value.startsWith('/images/')) {
        element.setAttribute(attribute, assetUrl(value));
      } else if (isApiPath(new URL(value, document.baseURI).pathname) || attribute === 'href' || element.tagName === 'IFRAME') {
        element.setAttribute(attribute, apiUrl(value));
      }
    }
  };

  document.querySelectorAll('img[src], image[href], a[href], iframe[src], video[src], source[src]').forEach(rewriteElement);
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === 'attributes' && record.target instanceof Element) rewriteElement(record.target);
      record.addedNodes.forEach((node) => {
        if (!(node instanceof Element)) return;
        rewriteElement(node);
        node.querySelectorAll('img[src], image[href], a[href], iframe[src], video[src], source[src]').forEach(rewriteElement);
      });
    }
  });
  observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['src', 'href'] });

  const resourceStyles = document.createElement('style');
  const background = assetUrl('/images/jiangnan-chat-bg.png');
  const brandMark = assetUrl('/images/gor-header-logo.png');
  resourceStyles.textContent = `
    .chat-page {
      background-color: #101829 !important;
      background-image: url("${background}") !important;
      background-position: center center !important;
      background-size: cover !important;
      background-repeat: no-repeat !important;
    }
    .chat-page::before { background-image: none !important; }
    .gor-brand-mark::after { -webkit-mask-image: url("${brandMark}") !important; mask-image: url("${brandMark}") !important; }
  `;
  document.head.append(resourceStyles);

  const backgroundProbe = new Image();
  backgroundProbe.onerror = () => console.error('[Gor VS Code] Chat background asset failed to load:', background);
  backgroundProbe.src = background;
}
