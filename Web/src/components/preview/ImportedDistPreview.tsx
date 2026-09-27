import { useEffect, useRef, useState } from 'react';
import type { ImportedDistArchive } from '../../preview/core/importArchive';

function mimeType(path: string): string {
  const extension = path.split('.').pop()?.toLowerCase();
  const known: Record<string, string> = {
    css: 'text/css', html: 'text/html', htm: 'text/html', js: 'text/javascript', mjs: 'text/javascript',
    json: 'application/json', svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
    gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', ico: 'image/x-icon', woff: 'font/woff',
    woff2: 'font/woff2', ttf: 'font/ttf', mp4: 'video/mp4', webm: 'video/webm', mp3: 'audio/mpeg',
  };
  return known[extension ?? ''] ?? 'application/octet-stream';
}

function localPath(reference: string, basePath: string): string | null {
  const value = reference.trim();
  if (!value || value.startsWith('#') || /^(?:data:|blob:|https?:|mailto:|tel:|javascript:)/i.test(value)) return null;
  const pathname = value.split(/[?#]/, 1)[0];
  const base = pathname.startsWith('/') ? '' : basePath.slice(0, basePath.lastIndexOf('/') + 1);
  const parts = `${base}${pathname}`.split('/').filter(Boolean);
  const normalized: string[] = [];
  for (const part of parts) {
    if (part === '.') continue;
    if (part === '..') {
      if (!normalized.length) return null;
      normalized.pop();
    } else normalized.push(part);
  }
  return `/${normalized.join('/')}`;
}

function decodeText(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

function rewriteCss(css: string, basePath: string, urls: Map<string, string>): string {
  return css.replace(/url\(\s*(['"]?)([^'"\)]+)\1\s*\)/gi, (match, _quote: string, rawUrl: string) => {
    const path = localPath(rawUrl, basePath);
    const url = path ? urls.get(path) : undefined;
    return url ? `url("${url}")` : (/^(?:data:|https?:)/i.test(rawUrl.trim()) ? match : 'url("")');
  });
}

function buildSandboxDocument(archive: ImportedDistArchive): { html: string; urls: string[] } {
  const urls = new Map<string, string>();
  const createdUrls: string[] = [];
  for (const [path, bytes] of Object.entries(archive.files)) {
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    const url = URL.createObjectURL(new Blob([copy.buffer], { type: mimeType(path) }));
    urls.set(path, url);
    createdUrls.push(url);
  }

  const source = archive.files[archive.entryPath];
  if (!source) throw new Error('ZIP 中的 dist 入口文件不存在。');
  const parsed = new DOMParser().parseFromString(decodeText(source), 'text/html');
  parsed.querySelectorAll('base, meta[http-equiv="refresh"]').forEach((node) => node.remove());

  parsed.querySelectorAll('link[href]').forEach((node) => {
    const link = node as HTMLLinkElement;
    const path = localPath(link.getAttribute('href') ?? '', archive.entryPath);
    if (!path) {
      link.remove();
      return;
    }
    const bytes = archive.files[path];
    if (!bytes) {
      link.remove();
      return;
    }
    if ((link.rel || '').toLowerCase().includes('stylesheet')) {
      const style = parsed.createElement('style');
      style.textContent = rewriteCss(decodeText(bytes), path, urls);
      link.replaceWith(style);
    } else {
      const url = urls.get(path);
      if (url) link.href = url;
      else link.remove();
    }
  });

  parsed.querySelectorAll('script[src]').forEach((node) => {
    const script = node as HTMLScriptElement;
    const path = localPath(script.getAttribute('src') ?? '', archive.entryPath);
    if (!path) {
      script.remove();
      return;
    }
    const bytes = archive.files[path];
    if (!bytes) {
      script.remove();
      return;
    }
    if (script.type === 'module') {
      const url = urls.get(path);
      if (url) script.src = url;
      else script.remove();
    } else {
      script.removeAttribute('src');
      script.textContent = decodeText(bytes);
    }
  });

  parsed.querySelectorAll('[src], [poster], [srcset]').forEach((node) => {
    for (const attribute of ['src', 'poster']) {
      const reference = node.getAttribute(attribute);
      if (!reference || /^(?:data:|blob:|https?:)/i.test(reference)) continue;
      const path = localPath(reference, archive.entryPath);
      const url = path ? urls.get(path) : undefined;
      if (url) node.setAttribute(attribute, url);
      else node.removeAttribute(attribute);
    }
    const srcset = node.getAttribute('srcset');
    if (srcset) {
      const rewritten = srcset.split(',').map((candidate) => {
        const [reference, ...descriptor] = candidate.trim().split(/\s+/);
        const path = localPath(reference, archive.entryPath);
        const url = path ? urls.get(path) : undefined;
        return url ? [url, ...descriptor].join(' ') : '';
      }).filter(Boolean).join(', ');
      if (rewritten) node.setAttribute('srcset', rewritten);
      else node.removeAttribute('srcset');
    }
  });
  parsed.querySelectorAll('style').forEach((style) => {
    style.textContent = rewriteCss(style.textContent ?? '', archive.entryPath, urls);
  });

  const scrollbarStyles = parsed.createElement('style');
  scrollbarStyles.id = 'gor-imported-dist-scrollbars';
  scrollbarStyles.textContent = `
    html { overflow: hidden !important; }
    html, html body, html body * {
      scrollbar-width: thin !important;
      scrollbar-color: rgba(148, 144, 174, .4) transparent !important;
    }
    html::-webkit-scrollbar, html body::-webkit-scrollbar, html body *::-webkit-scrollbar { width: 8px !important; height: 8px !important; }
    html::-webkit-scrollbar-track, html body::-webkit-scrollbar-track, html body *::-webkit-scrollbar-track { background: transparent !important; }
    html::-webkit-scrollbar-thumb, html body::-webkit-scrollbar-thumb, html body *::-webkit-scrollbar-thumb {
      border: 2px solid transparent !important;
      border-radius: 8px !important;
      background: rgba(148, 144, 174, .4) !important;
      background-clip: padding-box !important;
    }
    html::-webkit-scrollbar-thumb:hover, html body::-webkit-scrollbar-thumb:hover, html body *::-webkit-scrollbar-thumb:hover {
      background: rgba(124, 104, 238, .68) !important;
      background-clip: padding-box !important;
    }
    html::-webkit-scrollbar-button, html body::-webkit-scrollbar-button, html body *::-webkit-scrollbar-button {
      display: none !important;
      width: 0 !important;
      height: 0 !important;
    }
  `;
  parsed.head.append(scrollbarStyles);

  // Report the document's full height to the host so the visible scrollbar
  // belongs to Gor (and uses Gor's own scrollbar styling), not the iframe.
  const scrollBridge = parsed.createElement('script');
  scrollBridge.textContent = `(() => {
    const report = () => {
      const root = document.documentElement;
      const body = document.body;
      const height = Math.min(200000, Math.max(root.scrollHeight, body?.scrollHeight || 0, root.offsetHeight, body?.offsetHeight || 0));
      window.parent.postMessage({ type: 'gor-imported-dist-size', height }, '*');
    };
    const schedule = () => requestAnimationFrame(report);
    addEventListener('load', schedule);
    new ResizeObserver(schedule).observe(document.documentElement);
    if (document.body) new ResizeObserver(schedule).observe(document.body);
    schedule();
  })();`;
  (parsed.body ?? parsed.documentElement).append(scrollBridge);

  const csp = parsed.createElement('meta');
  csp.httpEquiv = 'Content-Security-Policy';
  csp.content = "default-src 'none'; script-src 'unsafe-inline' blob:; style-src 'unsafe-inline' blob:; img-src blob: data:; font-src blob: data:; media-src blob: data:; connect-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'";
  parsed.head.prepend(csp);
  return { html: `<!doctype html>${parsed.documentElement.outerHTML}`, urls: createdUrls };
}

export default function ImportedDistPreview({ archive }: { archive: ImportedDistArchive }) {
  const [html, setHtml] = useState('');
  const [error, setError] = useState('');
  const [documentHeight, setDocumentHeight] = useState<number | null>(null);
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    setError('');
    try {
      const result = buildSandboxDocument(archive);
      setHtml(result.html);
      setDocumentHeight(null);
      return () => result.urls.forEach((url) => URL.revokeObjectURL(url));
    } catch (reason) {
      setHtml('');
      setError(reason instanceof Error ? reason.message : '无法预览这个 dist ZIP。');
    }
  }, [archive]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frameRef.current?.contentWindow) return;
      if (!event.data || event.data.type !== 'gor-imported-dist-size') return;
      const height = Number(event.data.height);
      if (!Number.isFinite(height) || height <= 0) return;
      const viewportHeight = contentRef.current?.clientHeight ?? 0;
      setDocumentHeight(Math.max(viewportHeight, Math.min(200000, Math.ceil(height))));
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  if (error) return <div className="preview-state is-error"><strong>无法预览此 dist</strong><span>{error}</span></div>;
  if (!html) return <div className="preview-state">正在准备隔离预览…</div>;
  return (
    <div className="preview-worker-content imported-dist-content" ref={contentRef}>
      <iframe
        ref={frameRef}
        title={archive.name}
        className="preview-worker-frame imported-dist-frame"
        sandbox="allow-scripts allow-pointer-lock"
        srcDoc={html}
        style={documentHeight ? { height: `${documentHeight}px` } : undefined}
      />
    </div>
  );
}
