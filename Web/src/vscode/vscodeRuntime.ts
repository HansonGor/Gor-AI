/** Runtime-only URL adaptation for the existing Gor chat page inside VS Code. */
export function installVscodeWebviewRuntime(): void {
  // Keep VS Code conversations in their own server-side session namespace.
  document.documentElement.dataset.gorClientMode = 'vscode';

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

  const originalFetch = window.fetch.bind(window);
  window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const raw = input instanceof Request ? input.url : input instanceof URL ? input.href : input;
    let parsed: URL;
    try {
      parsed = new URL(raw, document.baseURI);
    } catch {
      return originalFetch(input, init);
    }
    if (!isApiPath(parsed.pathname) || parsed.origin === apiBase.origin) return originalFetch(input, init);

    const target = apiUrl(`${parsed.pathname}${parsed.search}${parsed.hash}`);
    if (input instanceof Request) return originalFetch(new Request(target, input), init);
    return originalFetch(target, init);
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
