/** Export only after React has committed each asynchronous highlighted (or plain) block. */
export function waitForCodeHighlights(root: HTMLElement, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      observer.disconnect();
      signal.removeEventListener('abort', abort);
    };
    const abort = () => {
      cleanup();
      reject(signal.reason ?? new DOMException('取消生成', 'AbortError'));
    };
    const check = () => {
      if (signal.aborted) return abort();
      if (!root.querySelector('[data-code-status="pending"]')) {
        cleanup();
        resolve();
      }
    };
    const observer = new MutationObserver(check);
    observer.observe(root, {
      attributes: true,
      subtree: true,
      attributeFilter: ['data-code-status'],
    });
    signal.addEventListener('abort', abort, { once: true });
    check();
  });
}
