import { useCallback, useEffect, useRef, useState } from 'react';
import { RefreshCw, X } from 'lucide-react';
import { Button } from '../ui/button';
import { Input } from '../ui/input';

interface WebPreviewProps {
  revision: number;
  onClose: () => void;
}

type PreviewState = 'loading' | 'ready' | 'error';

export default function WebPreview({ revision, onClose }: WebPreviewProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const cleanupRef = useRef<(() => void) | null>(null);
  const compileErrorRef = useRef(false);
  const [routeInput, setRouteInput] = useState('/');
  const [route, setRoute] = useState('/');
  const [reload, setReload] = useState(0);
  const [state, setState] = useState<PreviewState>('loading');
  const [error, setError] = useState('');

  const refresh = useCallback(() => {
    setState('loading');
    setError('');
    setReload((value) => value + 1);
  }, []);

  useEffect(() => {
    if (revision === 0) return;
    const timer = window.setTimeout(refresh, 700);
    return () => window.clearTimeout(timer);
  }, [revision, refresh]);

  useEffect(() => () => cleanupRef.current?.(), []);

  useEffect(() => {
    const hot = import.meta.hot;
    if (!hot) return;
    const onViteError = (payload: { err?: { message?: string } }) => {
      compileErrorRef.current = true;
      setState('error');
      setError(payload.err?.message || 'Vite 编译失败，请检查源码。');
    };
    const onViteUpdate = () => {
      compileErrorRef.current = false;
      setError('');
      setState('ready');
    };
    hot.on('vite:error', onViteError);
    hot.on('vite:afterUpdate', onViteUpdate);
    return () => {
      hot.off('vite:error', onViteError);
      hot.off('vite:afterUpdate', onViteUpdate);
    };
  }, []);

  const openRoute = (next: string) => {
    const normalized = next.trim();
    if (!/^\/[a-zA-Z0-9/_-]*$/.test(normalized) || normalized.startsWith('/chat')) {
      setState('error');
      setError('请输入以 / 开头的页面路由；聊天页不能嵌套预览。');
      return;
    }
    setRoute(normalized);
    setRouteInput(normalized);
    refresh();
  };

  const onFrameLoad = async () => {
    cleanupRef.current?.();
    try {
      const frame = iframeRef.current;
      const frameWindow = frame?.contentWindow;
      const doc = frame?.contentDocument;
      if (!frameWindow || !doc) throw new Error('无法访问预览页面。');

      const vite = await fetch('/@vite/client', { cache: 'no-store' });
      if (!vite.ok) throw new Error('Vite 开发服务未就绪；请在 Web 目录运行 npm run dev。');

      const showError = (message: string) => {
        setState('error');
        setError(message.slice(0, 2000));
      };
      const inspectOverlay = () => {
        const overlay = doc.querySelector('vite-error-overlay');
        if (overlay) {
          showError(
            overlay.shadowRoot?.textContent?.trim() || 'Vite 编译失败，请检查页面中的错误。',
          );
        } else if (!compileErrorRef.current) {
          setState('ready');
          setError('');
        }
      };
      const onError = (event: ErrorEvent) => showError(event.message || '页面运行出错。');
      const onRejection = (event: PromiseRejectionEvent) => showError(String(event.reason));
      frameWindow.addEventListener('error', onError);
      frameWindow.addEventListener('unhandledrejection', onRejection);
      const observer = new MutationObserver(inspectOverlay);
      observer.observe(doc.documentElement, { childList: true, subtree: true });
      cleanupRef.current = () => {
        observer.disconnect();
        frameWindow.removeEventListener('error', onError);
        frameWindow.removeEventListener('unhandledrejection', onRejection);
      };
      const recordedError = (frameWindow as Window & { __previewError?: string }).__previewError;
      if (recordedError) showError(recordedError);
      else inspectOverlay();
      window.setTimeout(() => {
        if (!frame?.isConnected) return;
        const currentError = (frameWindow as Window & { __previewError?: string }).__previewError;
        if (currentError) showError(currentError);
        else if (!doc.getElementById('root')?.hasChildNodes() && !compileErrorRef.current) {
          showError('页面未渲染。请检查 Vite 编译输出或浏览器控制台。');
        }
      }, 1200);
    } catch (cause) {
      setState('error');
      setError(cause instanceof Error ? cause.message : '预览启动失败。');
    }
  };

  const previewUrl = `/?preview=1&reload=${reload}#${route}`;

  return (
    <section className="web-preview" aria-label="网页实时预览">
      <div className="web-preview-header">
        <div>
          <strong>网页预览</strong>
          <span className={`web-preview-status ${state}`}>
            {state === 'loading' ? '加载中' : state === 'ready' ? '运行中' : '出错'}
          </span>
        </div>
        <div className="web-preview-actions">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={refresh}
            aria-label="刷新预览"
            title="刷新预览"
          >
            <RefreshCw size={16} />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={onClose}
            aria-label="收起预览"
            title="收起预览"
          >
            <X size={18} />
          </Button>
        </div>
      </div>
      <div className="web-preview-route">
        <Button type="button" variant="outline" size="sm" onClick={() => openRoute('/')}>
          首页
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={() => openRoute('/code')}>
          代码页
        </Button>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            openRoute(routeInput);
          }}
        >
          <Input
            aria-label="预览路由"
            value={routeInput}
            onChange={(event) => setRouteInput(event.target.value)}
            placeholder="/report"
          />
          <Button type="submit" variant="outline" size="sm">
            打开
          </Button>
        </form>
      </div>
      {error && (
        <pre className="web-preview-error" role="alert">
          {error}
        </pre>
      )}
      <iframe
        key={previewUrl}
        ref={iframeRef}
        src={previewUrl}
        title={`网页预览 ${route}`}
        onLoad={onFrameLoad}
        onError={() => {
          setState('error');
          setError('预览页面加载失败。');
        }}
      />
    </section>
  );
}
