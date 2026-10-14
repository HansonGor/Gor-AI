import { canHighlightCode, resolveCodeLanguage, type CodeTokens } from './languages';
import type { HighlightWorker } from './transport';

let worker: HighlightWorker | undefined;
let createWorker: () => HighlightWorker = () =>
  new Worker(new URL('./highlight.worker.ts', import.meta.url), { type: 'module' });
let nextId = 0;
const pending = new Map<
  number,
  { finish: (tokens: CodeTokens | null) => void; timer: ReturnType<typeof setTimeout> }
>();
const cache = new Map<string, Promise<CodeTokens | null>>();
let cacheSize = 0;
/** Host bootstrap injects its transport; components never inspect host permissions. */
export function configureCodeHighlightWorker(factory: () => HighlightWorker) {
  stopWorker();
  createWorker = factory;
}
function stopWorker() {
  worker?.terminate();
  worker = undefined;
  for (const entry of pending.values()) {
    clearTimeout(entry.timer);
    entry.finish(null);
  }
  pending.clear();
  cache.clear();
  cacheSize = 0;
}
export function highlightCode(code: string, declaredLanguage?: string): Promise<CodeTokens | null> {
  const language = resolveCodeLanguage(declaredLanguage);
  if (!language || !canHighlightCode(code) || typeof Worker === 'undefined')
    return Promise.resolve(null);
  const key = `${language}\0${code}`;
  const cached = cache.get(key);
  if (cached) {
    cache.delete(key);
    cache.set(key, cached);
    return cached;
  }
  try {
    if (!worker) {
      worker = createWorker();
      worker.onmessage = ({ data }: MessageEvent<{ id: number; tokens: CodeTokens | null }>) => {
        const entry = pending.get(data.id);
        if (!entry) return;
        clearTimeout(entry.timer);
        pending.delete(data.id);
        entry.finish(data.tokens);
      };
      worker.onerror = stopWorker;
      worker.onmessageerror = stopWorker;
    }
    const task = new Promise<CodeTokens | null>((finish) => {
      const id = ++nextId;
      pending.set(id, { finish, timer: setTimeout(stopWorker, 15000) });
      worker!.postMessage({ id, code, language });
    }).catch(() => {
      stopWorker();
      return null;
    });
    cache.set(key, task);
    cacheSize += key.length;
    while (cache.size > 32 || cacheSize > 500_000) {
      const oldest = cache.keys().next().value!;
      cacheSize -= oldest.length;
      cache.delete(oldest);
    }
    return task;
  } catch {
    stopWorker();
    return Promise.resolve(null);
  }
}
