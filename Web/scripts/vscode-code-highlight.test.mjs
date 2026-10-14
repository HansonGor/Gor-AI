import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import vm from 'node:vm';
import Module, { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = dirname(fileURLToPath(import.meta.url));
const workerBuild = await build({
  entryPoints: [
    fileURLToPath(
      new URL('../src/components/chat/codeHighlight/vscode-highlight.worker.ts', import.meta.url),
    ),
  ],
  bundle: true,
  platform: 'browser',
  format: 'iife',
  write: false,
  metafile: true,
});
const workerCode = workerBuild.outputFiles[0].text;

test('plugin worker bundles to one import-free file and highlights cloned grammars locally', async () => {
  assert.equal(Object.values(workerBuild.metafile.outputs)[0].imports.length, 0);
  assert.doesNotMatch(workerCode, /\bimport(?:Scripts)?\s*\(/);
  const replies = [];
  const self = { postMessage: (value) => replies.push(value) };
  vm.runInNewContext(workerCode, { self, console, TextEncoder, TextDecoder });
  const jsx = structuredClone((await import('shiki/langs/jsx.mjs')).default);
  const json = structuredClone((await import('shiki/langs/json.mjs')).default);
  const source = 'const App = () => <section title="Gor">你好</section>;';
  await self.onmessage({ data: { id: 1, language: 'jsx', code: source, grammars: jsx } });
  assert.equal(replies[0].tokens.map((l) => l.map((t) => t.content).join('')).join('\n'), source);
  assert.ok(new Set(replies[0].tokens.flat().map((t) => t.color)).size > 1);
  await self.onmessage({ data: { id: 2, language: 'jsx', code: source } });
  assert.equal(replies[1].tokens.map((l) => l.map((t) => t.content).join('')).join('\n'), source);
  await self.onmessage({ data: { id: 3, language: 'json', code: '{"x":1}', grammars: json } });
  assert.ok(replies[2].tokens);
  await self.onmessage({ data: { id: 4, language: 'python', code: 'print(1)' } });
  assert.equal(replies[3].tokens, null);
  const examples = {
    typescript: 'const count: number = 1;',
    javascript: 'const count = 1;',
    tsx: 'const App = () => <div>Hello</div>;',
    python: 'def greet(name):\n    return "Hello " + name',
    html: '<section class="gor">Hello</section>',
    css: '.gor { color: red; }',
    sql: 'SELECT name FROM users WHERE id = 1;',
    shellscript: 'echo "Hello" # greeting',
    vue: '<template><div>{{ name }}</div></template>',
  };
  for (const [language, code] of Object.entries(examples)) {
    const grammars = structuredClone((await import(`shiki/langs/${language}.mjs`)).default);
    await self.onmessage({ data: { id: replies.length + 1, language, code, grammars } });
    const tokens = replies.at(-1).tokens;
    assert.ok(tokens, language);
    assert.equal(tokens.map((line) => line.map((token) => token.content).join('')).join('\n'), code);
    assert.ok(new Set(tokens.flat().map((token) => token.color)).size > 1, language);
  }
});

const filename = dir + '/vscode-code-highlight.fixture.cjs';
const adapterBuild = await build({
  entryPoints: [fileURLToPath(new URL('../src/vscode/codeHighlightWorker.ts', import.meta.url))],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  write: false,
  plugins: [
    {
      name: 'transport-boundary',
      setup(b) {
        b.onResolve({ filter: /vscode-highlight\.worker\?worker&inline$/ }, () => ({
          path: 'inline',
          namespace: 'mock',
        }));
        b.onResolve({ filter: /codeHighlight\/loadLanguage$/ }, () => ({
          path: 'language',
          namespace: 'mock',
        }));
        b.onLoad({ filter: /.*/, namespace: 'mock' }, ({ path }) => ({
          contents:
            path === 'inline'
              ? 'export default class InlineWorker { constructor(){return globalThis.createNativeHighlightWorker();} }'
              : 'export const loadCodeLanguage=(language)=>globalThis.loadGrammar(language);',
          loader: 'js',
        }));
      },
    },
  ],
});
const fixture = new Module(filename);
fixture.filename = filename;
fixture.paths = Module._nodeModulePaths(dir);
fixture.require = createRequire(filename);
fixture._compile(adapterBuild.outputFiles[0].text, filename);
const { VscodeCodeHighlightWorker } = fixture.exports;
const turn = () => new Promise((resolve) => setImmediate(resolve));

test('plugin transport lazily forwards only required grammars once per worker', async () => {
  const workers = [];
  const languages = [];
  const replies = [];
  globalThis.createNativeHighlightWorker = () => {
    const worker = {
      requests: [],
      postMessage(value) {
        this.requests.push(value);
      },
      terminate() {
        this.stopped = true;
      },
    };
    workers.push(worker);
    return worker;
  };
  globalThis.loadGrammar = async (language) => {
    languages.push(language);
    return { default: [{ name: language, scopeName: 'source.test', patterns: [] }] };
  };
  const adapter = new VscodeCodeHighlightWorker();
  assert.equal(workers.length, 0);
  adapter.onmessage = (event) => replies.push(event.data);
  adapter.postMessage({ id: 1, language: 'typescript', code: 'const x = 1;' });
  adapter.postMessage({ id: 2, language: 'typescript', code: 'const x = 2;' });
  adapter.postMessage({ id: 3, language: 'json', code: '{"x":1}' });
  await turn();
  assert.deepEqual(languages, ['typescript', 'typescript', 'json']);
  assert.equal(workers.length, 1);
  assert.ok(workers[0].requests[0].grammars);
  assert.equal(workers[0].requests[1].grammars, undefined);
  assert.ok(workers[0].requests[2].grammars);
  workers[0].onmessage({ data: { id: 1, tokens: [] } });
  assert.equal(replies.length, 1);
  adapter.terminate();
  assert.equal(workers[0].stopped, true);
  workers[0].onmessage({ data: { id: 1, tokens: [] } });
  assert.equal(replies.length, 1);
});

test('closing plugin transport during bootstrap never posts stale code', async () => {
  const workers = [];
  globalThis.createNativeHighlightWorker = () => {
    const worker = {
      requests: [],
      postMessage(value) {
        this.requests.push(value);
      },
      terminate() {
        this.stopped = true;
      },
    };
    workers.push(worker);
    return worker;
  };
  globalThis.loadGrammar = async () => ({ default: [] });
  const adapter = new VscodeCodeHighlightWorker();
  adapter.postMessage({ id: 1, language: 'python', code: 'print(1)' });
  adapter.terminate();
  await turn();
  assert.equal(workers[0].stopped, true);
  assert.equal(workers[0].requests.length, 0);
});

test('language load failures reach the existing fallback path without posting code', async () => {
  const original = globalThis.ErrorEvent;
  globalThis.ErrorEvent = class {
    constructor(type, details) {
      this.type = type;
      Object.assign(this, details);
    }
  };
  const worker = {
    requests: [],
    postMessage(value) {
      this.requests.push(value);
    },
    terminate() {},
  };
  globalThis.createNativeHighlightWorker = () => worker;
  globalThis.loadGrammar = async () => {
    throw new Error('grammar unavailable');
  };
  try {
    const adapter = new VscodeCodeHighlightWorker();
    let error;
    adapter.onerror = (event) => {
      error = event;
    };
    adapter.postMessage({ id: 1, language: 'tsx', code: '<App />' });
    await turn();
    assert.equal(error.error.message, 'grammar unavailable');
    assert.equal(worker.requests.length, 0);
    adapter.terminate();
  } finally {
    globalThis.ErrorEvent = original;
  }
});
