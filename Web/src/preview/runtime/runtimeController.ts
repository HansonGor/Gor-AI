import type { PreviewBuildResult } from './workerProtocol.ts';
import type { RuntimeMetadata, RuntimeToParentMessage } from './runtimeProtocol.ts';
import { isRuntimeToParentMessage } from './runtimeProtocol.ts';

export interface RuntimeControllerOptions {
  iframe: HTMLIFrameElement;
  runtimeUrl: string;
  onEvent: (message: RuntimeToParentMessage) => void;
}

export class PreviewRuntimeController {
  private readonly iframe: HTMLIFrameElement;
  private readonly runtimeUrl: string;
  private readonly onEvent: (message: RuntimeToParentMessage) => void;
  private active: RuntimeMetadata | null = null;
  private sequence = 0;
  private pendingRun: { javascript: string; css: string | null } | null = null;
  private initTimers: number[] = [];
  private disposed = false;

  constructor(options: RuntimeControllerOptions) {
    this.iframe = options.iframe;
    this.runtimeUrl = options.runtimeUrl;
    this.onEvent = options.onEvent;
    window.addEventListener('message', this.handleMessage);
    this.iframe.addEventListener('load', this.handleLoad);
  }

  run(result: PreviewBuildResult): string {
    const javascript = result.outputFiles.find((file) => file.type === 'js')?.contents;
    if (!javascript) throw new Error('Build Result does not include JavaScript output.');
    const css = result.outputFiles.find((file) => file.type === 'css')?.contents ?? null;
    const runtimeId = `preview-runtime-${Date.now()}-${++this.sequence}`;
    this.active = { runtimeId, projectId: result.projectId, buildId: result.buildId };
    this.pendingRun = { javascript, css };
    this.iframe.src = `${this.runtimeUrl}?runtime=${encodeURIComponent(runtimeId)}`;
    return runtimeId;
  }

  reset(): void {
    this.pendingRun = null;
    this.active = null;
    this.clearInitTimers();
    // Destroy the browsing context's scene, animation loops and WebGL resources.
    this.iframe.src = 'about:blank';
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.pendingRun = null;
    this.clearInitTimers();
    this.active = null;
    window.removeEventListener('message', this.handleMessage);
    this.iframe.removeEventListener('load', this.handleLoad);
    this.iframe.src = 'about:blank';
  }

  private handleLoad = (): void => {
    this.clearInitTimers();
    const metadata = this.active;
    if (!metadata) return;
    // Development module loading may finish just after the document load event.
    // Re-sending this idempotent initialization message avoids losing the first handshake.
    [0, 50, 200].forEach((delay) => {
      this.initTimers.push(window.setTimeout(() => {
        if (!this.disposed && this.active?.runtimeId === metadata.runtimeId) {
          this.iframe.contentWindow?.postMessage({ type: 'RUNTIME_INIT', ...metadata }, '*');
        }
      }, delay));
    });
  };

  private handleMessage = (event: MessageEvent<unknown>): void => {
    if (this.disposed || event.source !== this.iframe.contentWindow || !isRuntimeToParentMessage(event.data) || !this.active) return;
    const message = event.data;
    if (message.type === 'RUNTIME_HOST_READY') {
      if (message.runtimeId === this.active.runtimeId) this.iframe.contentWindow?.postMessage({ type: 'RUNTIME_INIT', ...this.active }, '*');
      return;
    }
    if (message.runtimeId !== this.active.runtimeId || message.projectId !== this.active.projectId || message.buildId !== this.active.buildId) return;
    if (message.type === 'RUNTIME_READY') this.clearInitTimers();
    this.onEvent(message);
    if (message.type === 'RUNTIME_READY' && this.pendingRun) {
      const run = this.pendingRun;
      this.pendingRun = null;
      this.iframe.contentWindow?.postMessage({ type: 'RUNTIME_RUN', ...this.active, ...run }, '*');
    }
  };

  private clearInitTimers(): void {
    this.initTimers.forEach((timer) => window.clearTimeout(timer));
    this.initTimers = [];
  }
}
