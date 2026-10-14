import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { toCanvas } from 'html-to-image';
import ShareImageTemplate from '../components/chat/ShareImageTemplate';
import { waitForCodeHighlights } from '../components/chat/codeHighlight/ready';
import type { ShareMessage } from './shareContent';

export interface ShareImage {
  blob: Blob;
  url: string;
}
export function disposeShareImage(image: ShareImage | null) {
  if (image) URL.revokeObjectURL(image.url);
}
const SINGLE_IMAGE_LIMIT =
  '聊天内容过长，超出单张图片的尺寸或内存限制，无法完整导出。请减少勾选内容后重试。';
/** Conservative allocation budget, not a fixed layout height or an aspect ratio. */
export function sharePixelRatios(height: number): number[] {
  if (!Number.isFinite(height) || height < 1) throw new Error('分享图片尺寸异常，无法导出。');
  const ratios = [2, 1.5, 1].filter(
    (ratio) => height * ratio <= 16384 && 750 * height * ratio * ratio <= 16 * 1024 * 1024,
  );
  if (!ratios.length) throw new Error(SINGLE_IMAGE_LIMIT);
  return ratios;
}
function assertCompleteCanvas(canvas: HTMLCanvasElement, height: number, ratio: number) {
  if (canvas.width !== Math.floor(750 * ratio) || canvas.height !== Math.floor(height * ratio))
    throw new Error(SINGLE_IMAGE_LIMIT);
  const context = canvas.getContext('2d');
  if (!context) throw new Error(SINGLE_IMAGE_LIMIT);
  // Detect silent, uniform/transparent allocation failures without another full-size canvas.
  const pixels = [
    [0, 0],
    [375, 180],
    [375, 400],
    [375, height - 40],
  ].map(([x, y]) =>
    [
      ...context.getImageData(
        Math.floor(x * ratio),
        Math.max(0, Math.min(canvas.height - 1, Math.floor(y * ratio))),
        1,
        1,
      ).data,
    ].join(','),
  );
  if (new Set(pixels).size === 1)
    throw new Error('浏览器未能完整绘制长图，未生成空白图片。请减少勾选内容后重试。');
}
export function abortIfNeeded(signal: AbortSignal) {
  if (signal.aborted)
    throw signal.reason instanceof Error
      ? signal.reason
      : new DOMException('取消生成', 'AbortError');
}
function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  abortIfNeeded(signal);
  return new Promise((resolve, reject) => {
    const stop = () => {
      cleanup();
      reject(signal.reason ?? new DOMException('取消生成', 'AbortError'));
    };
    const cleanup = () => signal.removeEventListener('abort', stop);
    signal.addEventListener('abort', stop, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}

async function inlineImages(node: HTMLElement, signal: AbortSignal) {
  const cache = new Map<string, Promise<string>>();
  for (const img of node.querySelectorAll('img')) {
    abortIfNeeded(signal);
    const url = img.src;
    if (!cache.has(url))
      cache.set(
        url,
        (async () => {
          const response = await fetch(url, {
            signal,
            credentials: new URL(url).origin === location.origin ? 'same-origin' : 'omit',
          });
          if (!response.ok) throw new Error(`图片读取失败 (${response.status})`);
          const blob = await response.blob();
          if (blob.size > 20 * 1024 * 1024) throw new Error('正文图片过大，无法安全生成分享图。');
          return new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result));
            reader.onerror = () => reject(new Error('图片读取失败'));
            reader.readAsDataURL(blob);
          });
        })(),
      );
    try {
      img.src = await withAbort(cache.get(url)!, signal);
      await withAbort(img.decode(), signal);
    } catch (error) {
      abortIfNeeded(signal);
      throw new Error(
        `正文或夜景图片加载失败，可能受跨域限制；未忽略图片，请重试。${error instanceof Error ? error.message : ''}`,
      );
    }
  }
}

export async function exportShareImage(
  messages: ShareMessage[],
  signal: AbortSignal,
): Promise<ShareImage> {
  if (!messages.length) throw new Error('请先选择有正文的消息。');
  const host = document.createElement('div');
  host.className = 'gor-share-render-host';
  host.setAttribute('aria-hidden', 'true');
  host.setAttribute('inert', '');
  document.body.append(host);
  const mount = document.createElement('div');
  host.append(mount);
  const root = createRoot(mount);
  const timeout = new AbortController();
  const abort = () => timeout.abort(signal.reason);
  signal.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(
    () => timeout.abort(new Error('分享图生成超时，请减少选取内容后重试。')),
    120000,
  );
  try {
    abortIfNeeded(signal);
    flushSync(() => root.render(<ShareImageTemplate messages={messages} />));
    const sheet = mount.querySelector<HTMLElement>('.gor-share-sheet')!;
    await waitForCodeHighlights(sheet, timeout.signal);
    await inlineImages(sheet, timeout.signal);
    let fontTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await withAbort(
        Promise.race([
          document.fonts.ready,
          new Promise((_, reject) => {
            fontTimer = setTimeout(() => reject(new Error('字体加载超时，请重试。')), 15000);
          }),
        ]),
        timeout.signal,
      );
    } finally {
      clearTimeout(fontTimer);
    }
    abortIfNeeded(timeout.signal);
    // Measure the entire template after resource loading; preview height is irrelevant.
    const height = Math.ceil(sheet.getBoundingClientRect().height);
    let blob: Blob | null = null;
    for (const ratio of sharePixelRatios(height)) {
      let canvas: HTMLCanvasElement | undefined;
      try {
        canvas = await withAbort(
          toCanvas(sheet, {
            pixelRatio: ratio,
            width: 750,
            height,
            backgroundColor: '#182440',
            fontEmbedCSS: '',
            skipAutoScale: true,
          }),
          timeout.signal,
        );
        assertCompleteCanvas(canvas, height, ratio);
        blob = await withAbort(
          new Promise<Blob | null>((resolve) => canvas!.toBlob(resolve, 'image/png')),
          timeout.signal,
        );
        if (blob?.size) break;
      } catch {
        abortIfNeeded(timeout.signal);
      } finally {
        if (canvas) {
          canvas.width = 0;
          canvas.height = 0;
        }
      }
    }
    abortIfNeeded(timeout.signal);
    if (!blob?.size) throw new Error(SINGLE_IMAGE_LIMIT);
    return { blob, url: URL.createObjectURL(blob) };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
    root.unmount();
    host.remove();
  }
}
