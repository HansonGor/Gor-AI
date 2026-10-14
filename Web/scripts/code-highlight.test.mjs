import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Module, { createRequire } from 'node:module';
import { build } from 'esbuild';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import { Simulate } from 'react-dom/test-utils';

const dir = dirname(fileURLToPath(import.meta.url));
const runtimePath = new URL('../node_modules/.cache/gor-shiki-test.mjs', import.meta.url);
const runtime = await build({
  stdin: {
    contents: `export * from '../src/components/chat/codeHighlight/runtime'; export * from '../src/components/chat/codeHighlight/languages';`,
    resolveDir: dir,
    loader: 'ts',
  },
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
  external: ['shiki/*'],
});
await mkdir(dirname(fileURLToPath(runtimePath)), { recursive: true });
await writeFile(runtimePath, runtime.outputFiles[0].text);
const { tokenizeCode, resolveCodeLanguage, canHighlightCode } = await import(runtimePath.href);
test.after(() => rm(runtimePath, { force: true }));

test('real Dark+ grammars cover common languages, aliases and literal special characters', async () => {
  const samples = {
    typescript: 'const n: number = 1;',
    javascript: 'const n = "hello";',
    tsx: 'const App = () => <div title="x">你好</div>;',
    jsx: 'const App = () => <div />;',
    python: 'def greet(name):\n    return "hello"',
    html: '<div title="&">text</div>',
    css: '.app { color: red; }',
    json: '{"name": "Gor", "value": 1}',
    sql: 'SELECT id FROM users WHERE id = 1;',
    shellscript: 'echo "$HOME"',
    vue: '<template><div>{{ msg }}</div></template>\n<script setup>const msg = "hello"</script>',
  };
  for (const [language, code] of Object.entries(samples)) {
    const tokens = await tokenizeCode(code, language);
    assert.equal(tokens.map((line) => line.map((t) => t.content).join('')).join('\n'), code);
    assert.ok(new Set(tokens.flat().map((t) => t.color)).size > 1, language);
  }
  assert.equal(resolveCodeLanguage('TS'), 'typescript');
  assert.equal(resolveCodeLanguage('bash'), 'shellscript');
  for (const language of [undefined, '', 'unknown', '__proto__', 'constructor'])
    assert.equal(resolveCodeLanguage(language), null);
  assert.equal(canHighlightCode('x'.repeat(100_001)), false);
  assert.equal(canHighlightCode('line\n'.repeat(2501)), false);
  const long = Array.from({ length: 600 }, (_, i) => `const item${i}: string = "value";`).join(
    '\n',
  );
  assert.equal((await tokenizeCode(long, 'typescript')).length, 600);
});

const filename = dir + '/code-highlight.fixture.cjs';
const bundle = await build({
  stdin: {
    contents: `export {MarkdownCodeBlock,markdownCodeComponents,shareCodeComponents} from '../src/components/chat/MarkdownCodeBlock'; export {waitForCodeHighlights} from '../src/components/chat/codeHighlight/ready'; export {default as Markdown} from 'react-markdown'; export {default as CodeDiff} from '../src/components/chat/CodeDiff'; export {presentDiff} from '../src/components/chat/diffPresentation'; export {default as PreviewSourceViewer} from '../src/components/preview/PreviewSourceViewer';`,
    resolveDir: dir,
    loader: 'ts',
  },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  write: false,
  external: ['react', 'react-dom/*', 'lucide-react'],
  plugins: [
    {
      name: 'boundary',
      setup(b) {
        b.onResolve({ filter: /\.(less|css)$/ }, () => ({ path: 'style', namespace: 'mock' }));
        b.onResolve({ filter: /^(?:\.\/client|.*codeHighlight\/client)$/ }, () => ({
          path: 'client',
          namespace: 'mock',
        }));
        b.onLoad({ filter: /.*/, namespace: 'mock' }, ({ path }) => ({
          contents:
            path === 'client'
              ? 'export const highlightCode=(...args)=>globalThis.highlightTest(...args);'
              : '',
          loader: 'js',
        }));
      },
    },
  ],
});
const mod = new Module(filename);
mod.filename = filename;
mod.paths = Module._nodeModulePaths(dir);
mod.require = createRequire(filename);
mod._compile(bundle.outputFiles[0].text, filename);
const {
  MarkdownCodeBlock,
  markdownCodeComponents,
  shareCodeComponents,
  waitForCodeHighlights,
  Markdown,
  CodeDiff,
  presentDiff,
  PreviewSourceViewer,
} = mod.exports;
const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/' });
for (const name of ['window', 'document', 'HTMLElement', 'Element', 'MutationObserver'])
  globalThis[name] = dom.window[name];
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let calls = [];
globalThis.highlightTest = async (code, language) => {
  calls.push({ code, language });
  return resolveCodeLanguage(language)
    ? await tokenizeCode(code, resolveCodeLanguage(language))
    : null;
};

test('Markdown blocks highlight safely, inline code stays native, plain blocks and copy keep exact text', async () => {
  calls = [];
  const root = createRoot(document.getElementById('root'));
  let copied;
  Object.defineProperty(navigator, 'clipboard', {
    value: {
      writeText: async (value) => {
        copied = value;
      },
    },
    configurable: true,
  });
  const source = 'const html = "<img src=x onerror=alert(1)> &";\n';
  try {
    await act(async () => {
      root.render(
        React.createElement(
          Markdown,
          { components: markdownCodeComponents() },
          'inline `text`\n\n```tsx\n' +
            source +
            '```\n\n```mystery\nplain & <>\n```\n\n```\nno language\n```',
        ),
      );
    });
    const blocks = document.querySelectorAll('.gor-code-block');
    assert.equal(blocks.length, 3);
    assert.equal(blocks[0].querySelector('code').textContent, source);
    assert.ok(blocks[0].querySelector('code span[style*="color"]'));
    assert.equal(blocks[0].querySelector('img'), null);
    assert.equal(document.querySelector('p code').textContent, 'text');
    assert.equal(blocks[1].querySelector('code').textContent, 'plain & <>\n');
    assert.equal(blocks[2].querySelector('.gor-code-block-header span').textContent, 'Text');
    await act(async () => blocks[0].querySelector('button').click());
    assert.equal(copied, source);
    assert.match(blocks[0].textContent, /已复制/);
  } finally {
    await act(async () => root.unmount());
  }
});

test('unclosed streaming fences render immediately and rapid deltas coalesce; final content highlights immediately', async () => {
  calls = [];
  const root = createRoot(document.getElementById('root'));
  const components = markdownCodeComponents({ streaming: true });
  try {
    for (const value of ['c', 'const', 'const count: number = 1;'])
      await act(async () =>
        root.render(React.createElement(Markdown, { components }, '```ts\n' + value)),
      );
    assert.equal(calls.length, 0);
    assert.equal(
      document.querySelector('.gor-code-block code').textContent,
      'const count: number = 1;\n',
    );
    await act(async () => new Promise((resolve) => setTimeout(resolve, 300)));
    assert.equal(calls.length, 1);
    await act(async () =>
      root.render(
        React.createElement(
          Markdown,
          { components: markdownCodeComponents() },
          '```ts\nconst count: number = 2;\n```',
        ),
      ),
    );
    assert.equal(calls.length, 2);
    assert.match(document.querySelector('code').textContent, /2/);
  } finally {
    await act(async () => root.unmount());
  }
});

test('late highlights cannot overwrite new code, share waits for committed colors and omits copy controls', async () => {
  const original = globalThis.highlightTest;
  const replies = [];
  globalThis.highlightTest = (code) => new Promise((resolve) => replies.push({ code, resolve }));
  const root = createRoot(document.getElementById('root'));
  try {
    await act(async () =>
      root.render(
        React.createElement(MarkdownCodeBlock, { code: 'old', language: 'ts', share: true }),
      ),
    );
    await act(async () =>
      root.render(
        React.createElement(MarkdownCodeBlock, { code: 'new', language: 'ts', share: true }),
      ),
    );
    const wait = waitForCodeHighlights(
      document.getElementById('root'),
      new AbortController().signal,
    );
    let ready = false;
    wait.then(() => {
      ready = true;
    });
    await act(async () => replies[0].resolve([[{ content: 'old', color: '#fff' }]]));
    assert.equal(document.querySelector('code').textContent, 'new');
    assert.equal(ready, false);
    await act(async () => replies[1].resolve([[{ content: 'new', color: '#c5b3ff' }]]));
    await wait;
    assert.equal(document.querySelector('code').textContent, 'new');
    assert.equal(document.querySelector('.gor-code-block button'), null);
    const abort = new AbortController();
    await act(async () =>
      root.render(
        React.createElement(MarkdownCodeBlock, { code: 'pending', language: 'ts', share: true }),
      ),
    );
    const cancelled = waitForCodeHighlights(document.getElementById('root'), abort.signal);
    abort.abort();
    await assert.rejects(cancelled, { name: 'AbortError' });
  } finally {
    await act(async () => root.unmount());
    globalThis.highlightTest = original;
  }
});

test('multiple share blocks use the same colors and preserve all source text', async () => {
  const root = createRoot(document.getElementById('root'));
  try {
    await act(async () =>
      root.render(
        React.createElement(
          Markdown,
          { components: shareCodeComponents },
          '```python\ndef f():\n    return 1\n```\n\n```json\n{"x": 1}\n```',
        ),
      ),
    );
    await waitForCodeHighlights(document.getElementById('root'), new AbortController().signal);
    const blocks = [...document.querySelectorAll('.gor-code-block')];
    assert.equal(blocks.length, 2);
    assert.ok(blocks.every((b) => b.querySelector('span[style*="color"]')));
    assert.deepEqual(
      blocks.map((b) => b.querySelector('code').textContent),
      ['def f():\n    return 1\n', '{"x": 1}\n'],
    );
  } finally {
    await act(async () => root.unmount());
  }
});

test('Diff colors map to original line numbers in Unified and Split without changing text', async () => {
  const root = createRoot(document.getElementById('root'));
  const raw =
    '--- a/App.tsx\n+++ b/App.tsx\n@@ -12,2 +15,2 @@\n const title: string = "Gor";\n-const value = 1;\n+const value = 2;\n@@ -30 +33 @@\n-return <div>old</div>;\n+return <div>new</div>;\n';
  const model = presentDiff(raw);
  const before = JSON.stringify(model);
  try {
    await act(async () =>
      root.render(
        React.createElement(CodeDiff, { path: 'App.tsx', raw, model, viewType: 'unified' }),
      ),
    );
    assert.ok(document.querySelector('.diff-code span[style*="color"]'));
    assert.match(document.querySelector('.diff-unified').textContent, /const value = 1/);
    assert.match(document.querySelector('.diff-unified').textContent, /const value = 2/);
    assert.equal(document.querySelectorAll('.diff-code-insert').length, 2);
    await act(async () =>
      root.render(
        React.createElement(CodeDiff, { path: 'App.tsx', raw, model, viewType: 'split' }),
      ),
    );
    assert.ok(document.querySelector('.diff-split .diff-code-delete span[style*="color"]'));
    assert.ok(document.querySelector('.diff-split .diff-code-insert span[style*="color"]'));
    assert.equal(JSON.stringify(model), before);
    await act(async () =>
      root.render(
        React.createElement(CodeDiff, { path: 'unknown.ext', raw, model, viewType: 'unified' }),
      ),
    );
    assert.equal(document.querySelector('.diff-code span[style*="color"]'), null);
    assert.match(document.querySelector('.diff-unified').textContent, /const value = 2/);
  } finally {
    await act(async () => root.unmount());
  }
});

test('Preview keeps native editing and synchronizes both scroll axes after coloring', async () => {
  const root = createRoot(document.getElementById('root'));
  let source = 'const value: number = 1;\n';
  const received = [];
  function Editor() {
    const [value, setValue] = React.useState(source);
    return React.createElement(PreviewSourceViewer, {
      path: 'App.ts',
      source: value,
      onChange: (next) => {
        received.push(next);
        source = next;
        setValue(next);
      },
    });
  }
  try {
    await act(async () => root.render(React.createElement(Editor)));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 300)));
    const textarea = document.querySelector('textarea');
    const colors = document.querySelector('.preview-source-colors');
    assert.equal(colors.textContent, source + '\u200b');
    assert.equal(colors.getAttribute('aria-hidden'), 'true');
    assert.equal(textarea.value, source);
    assert.ok(textarea.classList.contains('is-syntax-highlighted'));
    textarea.scrollTop = 70;
    textarea.scrollLeft = 140;
    await act(async () => Simulate.scroll(textarea));
    assert.equal(colors.scrollTop, 70);
    assert.equal(colors.scrollLeft, 140);
    assert.equal(document.querySelector('.preview-source-line-numbers').scrollTop, 70);
    const next = 'const title = "你好";\n';
    await act(async () => Simulate.change(textarea, { target: { value: next } }));
    assert.deepEqual(received, [next]);
    assert.equal(textarea.value, next);
    assert.equal(document.querySelector('.preview-source-colors'), null);
    await act(async () => new Promise((resolve) => setTimeout(resolve, 300)));
    assert.equal(document.querySelector('.preview-source-colors').textContent, next + '\u200b');
  } finally {
    await act(async () => root.unmount());
  }
});

test('Preview rejects stale file colors and unknown extensions remain editable plain text', async () => {
  const original = globalThis.highlightTest;
  const replies = [];
  globalThis.highlightTest = (code) => new Promise((resolve) => replies.push({ code, resolve }));
  const root = createRoot(document.getElementById('root'));
  try {
    await act(async () =>
      root.render(
        React.createElement(PreviewSourceViewer, {
          path: 'old.ts',
          source: 'old',
          onChange: () => {},
        }),
      ),
    );
    await act(async () => new Promise((resolve) => setTimeout(resolve, 300)));
    await act(async () =>
      root.render(
        React.createElement(PreviewSourceViewer, {
          path: 'new.ts',
          source: 'new',
          onChange: () => {},
        }),
      ),
    );
    await act(async () => new Promise((resolve) => setTimeout(resolve, 300)));
    await act(async () => replies[0].resolve([[{ content: 'old', color: '#fff' }]]));
    assert.equal(document.querySelector('textarea').value, 'new');
    assert.equal(document.querySelector('.preview-source-colors'), null);
    await act(async () => replies[1].resolve([[{ content: 'new', color: '#fff' }]]));
    assert.equal(document.querySelector('.preview-source-colors').textContent, 'new\u200b');
    globalThis.highlightTest = original;
    await act(async () =>
      root.render(
        React.createElement(PreviewSourceViewer, {
          path: 'notes.unknown',
          source: 'plain <>&',
          onChange: () => {},
        }),
      ),
    );
    await act(async () => new Promise((resolve) => setTimeout(resolve, 300)));
    assert.equal(document.querySelector('.preview-source-colors'), null);
    assert.equal(document.querySelector('textarea').value, 'plain <>&');
    await act(async () =>
      root.render(
        React.createElement(PreviewSourceViewer, {
          path: null,
          source: undefined,
          onChange: () => {},
        }),
      ),
    );
    assert.ok(document.querySelector('.preview-source-empty'));
  } finally {
    await act(async () => root.unmount());
    globalThis.highlightTest = original;
  }
});

test('worker requests deduplicate across aliases, bound their cache and recover safely from errors', async () => {
  const path = new URL('../node_modules/.cache/gor-shiki-client-test.mjs', import.meta.url);
  const built = await build({
    stdin: {
      contents: `export {highlightCode} from '../src/components/chat/codeHighlight/client';`,
      resolveDir: dir,
      loader: 'ts',
    },
    bundle: true,
    platform: 'node',
    format: 'esm',
    write: false,
  });
  await writeFile(path, built.outputFiles[0].text);
  const original = globalThis.Worker;
  const workers = [];
  globalThis.Worker = class {
    requests = [];
    constructor() {
      workers.push(this);
    }
    postMessage(value) {
      this.requests.push(value);
    }
    terminate() {
      this.terminated = true;
    }
    reply(request) {
      this.onmessage({
        data: { id: request.id, tokens: [[{ content: request.code, color: '#d4d4d4' }]] },
      });
    }
  };
  try {
    const { highlightCode } = await import(path.href);
    const a = highlightCode('const x = 1', 'ts'),
      b = highlightCode('const x = 1', 'typescript');
    assert.equal(a, b);
    assert.equal(workers[0].requests.length, 1);
    workers[0].reply(workers[0].requests[0]);
    await a;
    const tasks = Array.from({ length: 40 }, (_, i) => highlightCode(`const x = ${i + 2}`, 'ts'));
    for (const request of workers[0].requests.slice(1)) workers[0].reply(request);
    await Promise.all(tasks);
    const evicted = highlightCode('const x = 1', 'ts');
    assert.equal(workers[0].requests.length, 42);
    workers[0].reply(workers[0].requests.at(-1));
    await evicted;
    const failed = highlightCode('broken', 'py');
    workers[0].onerror();
    assert.equal(await failed, null);
    assert.equal(workers[0].terminated, true);
    assert.equal(await highlightCode('x'.repeat(100_001), 'ts'), null);
    assert.equal(await highlightCode('plain', 'unknown'), null);
    const retried = highlightCode('print(1)', 'py');
    assert.equal(workers.length, 2);
    workers[1].reply(workers[1].requests[0]);
    await retried;
  } finally {
    globalThis.Worker = original;
    await rm(path, { force: true });
  }
});
