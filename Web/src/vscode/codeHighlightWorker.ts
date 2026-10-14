import { loadCodeLanguage } from '../components/chat/codeHighlight/loadLanguage';
import type { CodeLanguage } from '../components/chat/codeHighlight/languages';
import type { HighlightRequest, HighlightWorker } from '../components/chat/codeHighlight/transport';

/** Lazy Blob transport keeps all highlighting local to the VS Code Webview. */
export class VscodeCodeHighlightWorker implements HighlightWorker {
  onmessage: HighlightWorker['onmessage'] = null;
  onerror: HighlightWorker['onerror'] = null;
  onmessageerror: HighlightWorker['onmessageerror'] = null;
  private stopped = false;
  private native: Worker | undefined;
  private sentLanguages = new Set<CodeLanguage>();
  private ready: Promise<Worker>;

  constructor() {
    this.ready =
      import('../components/chat/codeHighlight/vscode-highlight.worker?worker&inline').then(
        ({ default: BundledWorker }) => {
          const worker = new BundledWorker();
          if (this.stopped) {
            worker.terminate();
            return worker;
          }
          this.native = worker;
          worker.onmessage = (event) => {
            if (!this.stopped) this.onmessage?.(event);
          };
          worker.onerror = (event) => {
            if (!this.stopped) this.onerror?.(event);
          };
          worker.onmessageerror = (event) => {
            if (!this.stopped) this.onmessageerror?.(event);
          };
          return worker;
        },
      );
  }
  postMessage(request: HighlightRequest) {
    void Promise.all([this.ready, loadCodeLanguage(request.language)])
      .then(([worker, module]) => {
        if (this.stopped) return;
        worker.postMessage({
          ...request,
          grammars: this.sentLanguages.has(request.language) ? undefined : module.default,
        });
        this.sentLanguages.add(request.language);
      })
      .catch((error) => {
        if (!this.stopped)
          this.onerror?.(
            new ErrorEvent('error', {
              error,
              message: 'Code highlighting resource failed to load',
            }),
          );
      });
  }
  terminate() {
    this.stopped = true;
    this.native?.terminate();
  }
}
