import assert from 'node:assert/strict';
import test from 'node:test';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Module, { createRequire } from 'node:module';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

const filename = fileURLToPath(new URL('./model-selector.fixture.cjs', import.meta.url));
const compiled = await build({
  stdin: { contents: `
    export { default as Selector } from '../src/components/chat/ModelSelector';
    export { useChatModel, applyChatModelSelection } from '../src/hooks/useChatModel';
    export { useChatModels, resetChatModelsForTests } from '../src/hooks/useChatModels';
  `, resolveDir: dirname(filename), loader: 'ts' },
  bundle: true, platform: 'node', format: 'cjs', write: false, packages: 'external',
  plugins: [{ name: 'styles', setup(builder) {
    builder.onResolve({ filter: /\.less$/ }, args => ({ path: args.path, namespace: 'styles' }));
    builder.onLoad({ filter: /.*/, namespace: 'styles' }, () => ({ contents: '', loader: 'js' }));
  } }],
});
const fixture = new Module(filename);
fixture.filename = filename;
fixture.paths = Module._nodeModulePaths(dirname(filename));
fixture.require = createRequire(filename);
fixture._compile(compiled.outputFiles[0].text, filename);
const { Selector, useChatModel, applyChatModelSelection, useChatModels, resetChatModelsForTests } = fixture.exports;
const dom = new JSDOM('<!doctype html><body><div id="root"></div></body>', { url: 'http://gor.test/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.Node = dom.window.Node;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const MODELS = [
  { id: 'ep-flash', name: 'DeepSeek V4.1 Flash', providerName: '方舟', description: '当前默认模型', supports_tools: true, supports_thinking: true, available: true },
  { id: 'ep-pro', name: 'DeepSeek V4 Pro', providerName: '方舟', description: '更强推理', supports_tools: true, supports_thinking: true, available: true },
  { id: 'or-x', name: 'OpenRouter 模型', providerName: 'OpenRouter', description: '', supports_tools: true, supports_thinking: true, available: false,
    unavailable_reason: '未配置 OpenRouter 密钥，暂不可用' },
  { id: 'no-tools', name: '无工具模型', providerName: '方舟', description: '', supports_tools: false, supports_thinking: false, available: false },
];

async function mount(element) {
  const root = createRoot(document.getElementById('root'));
  await act(async () => root.render(element));
  return root;
}

test('renders nothing until the model list is available', async () => {
  const root = await mount(React.createElement(Selector, { models: [] }));
  assert.equal(document.querySelector('.model-selector'), null);
  await act(async () => root.unmount());
});

test('shows the current model, lists model names only and only selects available ones', async () => {
  const changes = [];
  const root = await mount(React.createElement(Selector, { models: MODELS, value: 'ep-flash', onChange: id => changes.push(id) }));
  const trigger = document.querySelector('.model-selector .file-edit-mode-trigger');
  assert.equal(trigger.textContent, 'DeepSeek V4.1 Flash');
  assert.equal(trigger.getAttribute('title'), 'DeepSeek V4.1 Flash');
  assert.ok(trigger.querySelector('.lucide-cpu'));
  await act(async () => trigger.click());
  const options = [...document.querySelectorAll('[role="radio"]')];
  assert.deepEqual(options.map(o => o.querySelector('strong').textContent), MODELS.map(m => m.name));
  assert.equal(options[0].getAttribute('aria-checked'), 'true');
  // 所有端精简：每项只有模型名，不显示提供方说明、能力标签、分隔线与底部提示
  assert.deepEqual(options.map(o => o.textContent), MODELS.map(m => m.name));
  assert.equal(document.querySelector('.model-selector-popover .thinking-mode-divider'), null);
  assert.equal(document.querySelector('.model-selector-note'), null);
  assert.equal(options[2].disabled, true);
  assert.match(options[2].getAttribute('title'), /未配置 OpenRouter 密钥/);
  assert.ok(options[2].querySelector('.lucide-lock'));
  assert.match(options[3].getAttribute('title'), /不支持工具调用/);
  assert.equal(options[0].getAttribute('title'), null);
  await act(async () => options[2].click());
  assert.deepEqual(changes, []);
  await act(async () => options[1].click());
  assert.deepEqual(changes, ['ep-pro']);
  assert.equal(document.querySelector('[role="dialog"]'), null);
  assert.equal(document.activeElement, trigger);
  await act(async () => root.unmount());
});

test('an unknown saved model falls back to the first model and a single model shows only its name', async () => {
  const root = await mount(React.createElement(Selector, { models: MODELS.slice(0, 1), value: 'removed' }));
  const trigger = document.querySelector('.model-selector .file-edit-mode-trigger');
  assert.equal(trigger.textContent, 'DeepSeek V4.1 Flash');
  await act(async () => trigger.click());
  assert.deepEqual([...document.querySelectorAll('[role="radio"]')].map(o => o.textContent), ['DeepSeek V4.1 Flash']);
  assert.equal(document.querySelector('.model-selector-note'), null);
  await act(async () => root.unmount());
});

test('Qwen without credentials is visible and locked with the server availability reason', async () => {
  const qwen = { id: 'qwen3.8-flash', name: '千问 3.8 Flash', providerName: '阿里云百炼',
    description: '', supports_tools: true, supports_thinking: true, available: false,
    unavailable_reason: '未配置千问密钥，暂不可用' };
  const changes = [];
  const root = await mount(React.createElement(Selector, {
    models: [MODELS[0], qwen], value: MODELS[0].id, onChange: id => changes.push(id),
  }));
  await act(async () => document.querySelector('.model-selector .file-edit-mode-trigger').click());
  const option = [...document.querySelectorAll('[role="radio"]')][1];
  assert.equal(option.textContent, '千问 3.8 Flash');
  assert.equal(option.disabled, true);
  assert.equal(option.title, qwen.unavailable_reason);
  await act(async () => option.click());
  assert.deepEqual(changes, []);
  await act(async () => root.unmount());
});

function server({ catalogOk = true, preference = {}, failRead = false } = {}) {
  const saved = { ...preference };
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url, method: init.method ?? 'GET' });
    if (url === '/api/chat/models') {
      return catalogOk ? { ok: true, json: async () => ({ models: MODELS, defaultModelId: 'ep-flash' }) }
        : { ok: false, json: async () => ({}) };
    }
    const session = decodeURIComponent(url.split('/session/')[1].split('/')[0]);
    if (failRead && (init.method ?? 'GET') === 'GET') return { ok: false, json: async () => ({}) };
    if (init.method === 'PUT') return { ok: true, json: async () => ({ modelId: JSON.parse(init.body).modelId }) };
    return { ok: true, json: async () => ({ modelId: 'ep-flash' }) };
  };
  return { saved, calls };
}

function ModelProbe({ sessionId, sink, onError }) {
  sink.current = useChatModel(sessionId, onError);
  return null;
}

test('model selection is temporary, reload/session defaults to DeepSeek, and failures send without modelId', async () => {
  const api = server();
  const sink = { current: null };
  let root = await mount(React.createElement(ModelProbe, { sessionId: 's1', sink }));
  await act(async () => { await sink.current.freezeChatModel(); });
  assert.equal(sink.current.chatModelId, 'ep-flash');
  assert.match(api.calls[0].url, /\/api\/chat\/session\/s1\/model$/);
  await act(async () => { sink.current.setChatModel('ep-pro'); await sink.current.freezeChatModel(); });
  assert.equal(api.saved.s1, undefined, 'selection is not persisted');
  assert.equal(await sink.current.freezeChatModel(), 'ep-pro');
  await act(async () => root.render(React.createElement(ModelProbe, { sessionId: 's2', sink })));
  await act(async () => root.render(React.createElement(ModelProbe, { sessionId: 's1', sink })));
  await act(async () => { await sink.current.freezeChatModel(); });
  assert.equal(sink.current.chatModelId, 'ep-flash', 'reload returns to the server default');

  server({ failRead: true });
  const errors = [];
  await act(async () => root.render(React.createElement(ModelProbe, { sessionId: 's2', sink, onError: m => errors.push(m) })));
  let frozen = 'unset';
  await act(async () => { frozen = await sink.current.freezeChatModel(); });
  assert.equal(frozen, undefined);
  assert.equal(sink.current.chatModelId, null);
  assert.deepEqual(errors, ['模型选择保存失败。']);
  await act(async () => root.unmount());
});

test('switching models resets shared thinking mode to the 酌思 default, but reselecting does not', () => {
  const calls = [];
  applyChatModelSelection('ep-pro', 'ep-flash', value => calls.push(['model', value]), value => calls.push(['thinking', value]));
  assert.deepEqual(calls, [['thinking', 'auto'], ['model', 'ep-pro']]);
  calls.length = 0;
  applyChatModelSelection('ep-pro', 'ep-pro', value => calls.push(['model', value]), value => calls.push(['thinking', value]));
  assert.deepEqual(calls, [['model', 'ep-pro']]);
});

function CatalogProbe({ sink }) {
  sink.current = useChatModels();
  return null;
}

test('model catalog is shared across components and retried after a failure', async () => {
  resetChatModelsForTests();
  let api = server({ catalogOk: false });
  const sink = { current: null };
  let root = await mount(React.createElement(CatalogProbe, { sink }));
  await act(async () => { await new Promise(r => setTimeout(r, 0)); });
  assert.equal(sink.current.failed, true);
  assert.deepEqual(sink.current.models, []);
  await act(async () => root.unmount());

  api = server();
  const other = { current: null };
  root = await mount(React.createElement(React.Fragment, null,
    React.createElement(CatalogProbe, { sink }), React.createElement(CatalogProbe, { sink: other })));
  await act(async () => { await new Promise(r => setTimeout(r, 0)); });
  assert.equal(sink.current.failed, false);
  assert.equal(sink.current.defaultModelId, 'ep-flash');
  assert.equal(other.current.models.length, 4);
  assert.equal(api.calls.filter(c => c.url === '/api/chat/models').length, 1, 'one shared request');
  await act(async () => root.unmount());
});
