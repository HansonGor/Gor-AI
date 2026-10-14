import assert from 'node:assert/strict';
import test from 'node:test';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Module, { createRequire } from 'node:module';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
const filename = fileURLToPath(new URL('./share-export.fixture.cjs', import.meta.url));
const compiled = await build({
  stdin: {
    contents: `export {exportShareImage,disposeShareImage,sharePixelRatios} from '../src/share/exportShareImage';export {saveBlob} from '../src/preview/core/saveFile';export {saveVscodeShareImage} from '../src/vscode/saveShareImage';export {installVscodeWebviewRuntime} from '../src/vscode/vscodeRuntime';`,
    resolveDir: dirname(filename),
    loader: 'ts',
  },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  write: false,
  external: ['react', 'react-dom', 'react-dom/*', 'lucide-react'],
  define: { 'import.meta.env': '{"BASE_URL":"/"}' },
  plugins: [
    {
      name: 'canvas-boundary',
      setup(b) {
        b.onResolve({ filter: /\.less$/ }, () => ({ path: 'style', namespace: 'fixture' }));
        b.onResolve({ filter: /^html-to-image$/ }, () => ({
          path: 'canvas',
          namespace: 'fixture',
        }));
        b.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({
          contents:
            path === 'canvas'
              ? 'export const toCanvas=(node,options)=>globalThis.canvasRenderer(node,options);'
              : '',
          loader: 'js',
        }));
      },
    },
  ],
});
const mod = new Module(filename);
mod.filename = filename;
mod.paths = Module._nodeModulePaths(dirname(filename));
mod.require = createRequire(filename);
mod._compile(compiled.outputFiles[0].text, filename);
const {
  exportShareImage,
  disposeShareImage,
  sharePixelRatios,
  saveBlob,
  saveVscodeShareImage,
  installVscodeWebviewRuntime,
} = mod.exports;
const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/' });
for (const name of [
  'window',
  'document',
  'Node',
  'Element',
  'HTMLElement',
  'HTMLImageElement',
  'FileReader',
  'MutationObserver',
  'location',
])
  globalThis[name] =
    name === 'window' ? dom.window : name === 'document' ? dom.window.document : dom.window[name];
Object.defineProperty(document, 'fonts', {
  value: { ready: Promise.resolve() },
  configurable: true,
});
dom.window.HTMLImageElement.prototype.decode = async () => {};
// Deterministic unit measurement only; actual fonts/layout/PNG are verified in the browser fixture.
dom.window.HTMLElement.prototype.getBoundingClientRect = function () {
  return {
    height: this.classList.contains('gor-share-sheet')
      ? 650 + (this.querySelector('.gor-share-body')?.textContent.length || 0) * 2
      : 1,
    width: 750,
  };
};
let urls = 0,
  revoked = [];
URL.createObjectURL = () => `blob:test-${++urls}`;
URL.revokeObjectURL = (url) => revoked.push(url);
const reset = () => {
  document.body.replaceChildren();
  revoked = [];
  globalThis.fetch = async () => ({
    ok: true,
    blob: async () => new dom.window.Blob(['image'], { type: 'image/png' }),
  });
  document.fonts.ready = Promise.resolve();
};
const body = {
  id: 'a',
  role: 'assistant',
  content: '正文内容完整。'.repeat(220),
  images: [],
  citationNames: {},
};
const canvasFor = (options) => ({
  width: Math.floor(750 * options.pixelRatio),
  height: Math.floor(options.height * options.pixelRatio),
  getContext: () => ({ getImageData: (x, y) => ({ data: [x % 255, y % 255, 123, 255] }) }),
  toBlob: (callback) => callback(new Blob(['PNG boundary'], { type: 'image/png' })),
});
test('one complete template, dynamic height, ratio retry and one owned image', async () => {
  reset();
  const captured = [];
  let attempts = 0;
  globalThis.canvasRenderer = async (node, options) => {
    assert.ok(options.height > 1800);
    assert.equal(options.width, 750);
    attempts++;
    if (options.pixelRatio === 2) throw new Error('allocation');
    captured.push(node.querySelector('.gor-share-card').textContent);
    assert.equal(node.querySelectorAll('.gor-share-brand').length, 1);
    assert.equal(node.querySelectorAll('.gor-share-footer').length, 1);
    return canvasFor(options);
  };
  const image = await exportShareImage([body], new AbortController().signal);
  assert.equal(captured.length, 1);
  assert.equal(captured[0], body.content);
  assert.equal(attempts, 2);
  assert.ok(image.blob.size);
  assert.equal(document.querySelector('.gor-share-render-host'), null);
  disposeShareImage(image);
  assert.deepEqual(revoked, [image.url]);
});
test('1, 5 and 20 messages remain in original order in one progressively taller PNG', async () => {
  reset();
  const heights = [];
  for (const count of [1, 5, 20]) {
    let renders = 0;
    const messages = Array.from({ length: count }, (_, i) => ({
      ...body,
      id: String(i),
      content: '完整正文 ' + i + ' ' + '江南夜色'.repeat(8),
    }));
    globalThis.canvasRenderer = async (node, options) => {
      renders++;
      heights.push(options.height);
      assert.deepEqual(
        [...node.querySelectorAll('.gor-share-message')].map((m) => m.dataset.messageId),
        messages.map((m) => m.id),
      );
      assert.equal(node.querySelectorAll('.gor-share-landscape').length, 1);
      assert.equal(node.querySelectorAll('.gor-share-brand').length, 1);
      assert.equal(node.querySelectorAll('.gor-share-footer').length, 1);
      return canvasFor(options);
    };
    const image = await exportShareImage(messages, new AbortController().signal);
    assert.equal(renders, 1);
    disposeShareImage(image);
  }
  assert.ok(heights[0] < heights[1] && heights[1] < heights[2]);
});
test('image and font failures reject instead of exporting missing content', async () => {
  for (const failure of ['image', 'font']) {
    reset();
    let renders = 0;
    globalThis.canvasRenderer = () => {
      renders++;
    };
    if (failure === 'image') globalThis.fetch = async () => ({ ok: false, status: 403 });
    else {
      document.fonts.ready = Promise.reject(new Error('字体失败'));
      document.fonts.ready.catch(() => {});
    }
    await assert.rejects(
      exportShareImage([body], new AbortController().signal),
      failure === 'image' ? /图片加载失败/ : /字体失败/,
    );
    assert.equal(renders, 0);
    assert.equal(document.querySelector('.gor-share-render-host'), null);
  }
});
test('empty input, cancellation and Canvas failure never return a partial or blank image', async () => {
  reset();
  await assert.rejects(exportShareImage([], new AbortController().signal), /选择/);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(exportShareImage([body], controller.signal), { name: 'AbortError' });
  globalThis.canvasRenderer = async () => {
    throw new Error('Canvas');
  };
  await assert.rejects(exportShareImage([body], new AbortController().signal), /单张图片/);
  assert.equal(revoked.length, 0);
  assert.equal(document.querySelector('.gor-share-render-host'), null);
});
test('stalled Canvas can be cancelled promptly', async () => {
  reset();
  globalThis.canvasRenderer = () => new Promise(() => {});
  const controller = new AbortController();
  const task = exportShareImage([body], controller.signal);
  const rejection = assert.rejects(task, { name: 'AbortError' });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  await rejection;
  assert.equal(document.querySelector('.gor-share-render-host'), null);
});
test('extreme heights reject explicitly without Canvas calls or pagination', async () => {
  reset();
  assert.deepEqual(sharePixelRatios(1000), [2, 1.5, 1]);
  assert.throws(() => sharePixelRatios(20000), /无法完整导出/);
  let attempts = 0;
  globalThis.canvasRenderer = () => {
    attempts++;
  };
  await assert.rejects(
    exportShareImage([{ ...body, content: '长'.repeat(10000) }], new AbortController().signal),
    /单张图片/,
  );
  assert.equal(attempts, 0);
  assert.equal(document.querySelector('.gor-share-render-host'), null);
});
test('silent dimension reduction, transparent Canvas and null encoding are rejected', async () => {
  for (const failure of ['dimensions', 'blank', 'encoding']) {
    reset();
    globalThis.canvasRenderer = async (node, options) => {
      const canvas = canvasFor(options);
      if (failure === 'dimensions') canvas.height = 100;
      if (failure === 'blank')
        canvas.getContext = () => ({ getImageData: () => ({ data: [0, 0, 0, 0] }) });
      if (failure === 'encoding') canvas.toBlob = (callback) => callback(null);
      return canvas;
    };
    await assert.rejects(exportShareImage([body], new AbortController().signal), /单张图片/);
    assert.equal(document.querySelector('.gor-share-render-host'), null);
  }
});
test('resources finish loading before full template height is measured', async () => {
  reset();
  let resolveFonts;
  document.fonts.ready = new Promise((resolve) => {
    resolveFonts = resolve;
  });
  let called = false;
  globalThis.canvasRenderer = async (node, options) => {
    called = true;
    return canvasFor(options);
  };
  const task = exportShareImage([body], new AbortController().signal);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(called, false);
  resolveFonts();
  const image = await task;
  assert.equal(called, true);
  disposeShareImage(image);
});
test('Web saves the single PNG blob/name; picker cancel remains retryable', async () => {
  reset();
  let anchor;
  dom.window.HTMLAnchorElement.prototype.click = function () {
    anchor = this;
  };
  const blob = new Blob(['actual bytes'], { type: 'image/png' });
  assert.equal(await saveBlob({ suggestedName: 'Gor-聊天.png', blob }), true);
  assert.equal(anchor.download, 'Gor-聊天.png');
  assert.match(anchor.href, /blob:test-/);
  window.showSaveFilePicker = async () => {
    throw new DOMException('cancel', 'AbortError');
  };
  Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });
  assert.equal(await saveBlob({ suggestedName: 'Gor-聊天.png', blob }), false);
  delete window.showSaveFilePicker;
});
test('VS Code single image uses the existing bridge and correlates cancellation/failure', async () => {
  reset();
  let sent;
  window.acquireVsCodeApi = () => ({
    postMessage: (message) => {
      sent = message;
    },
  });
  installVscodeWebviewRuntime();
  assert.equal(sent.type, 'gor.workspaceContextReady');
  for (const result of [{ saved: true }, { saved: false }, { saved: false, error: '保存失败' }]) {
    const promise = saveVscodeShareImage({
      suggestedName: 'Gor-聊天.png',
      blob: new Blob(['PNG'], { type: 'image/png' }),
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(sent.type, 'gor.saveShareImage');
    assert.equal(sent.base64, 'UE5H');
    window.dispatchEvent(
      new dom.window.MessageEvent('message', {
        data: { type: 'gor.shareImageSaved', requestId: 'other', saved: true },
      }),
    );
    window.dispatchEvent(
      new dom.window.MessageEvent('message', {
        data: { type: 'gor.shareImageSaved', requestId: sent.requestId, ...result },
      }),
    );
    if (result.error) await assert.rejects(promise, /保存失败/);
    else assert.equal(await promise, result.saved);
  }
});
