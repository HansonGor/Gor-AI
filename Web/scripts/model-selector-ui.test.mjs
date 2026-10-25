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

test('Web phone, Web narrowed by Preview and the VS Code plugin share one compact composer style', async () => {
  const { readFile } = await import('node:fs/promises');
  const { default: less } = await import('less');
  const chatBox = await readFile(new URL('../src/components/ChatBox/ChatBox.less', import.meta.url), 'utf8');
  const source = await readFile(new URL('../src/components/chat/ThinkingModeSelector.less', import.meta.url), 'utf8');
  assert.match(chatBox, /\.chat-page \.input-area \{[^}]*container: chat-composer \/ inline-size;/);
  const { css } = await less.render(source);
  const panel = '.chat-composer-panel.chat-composer-panel.chat-composer-panel.chat-composer-panel:has(.model-selector)';
  // 把三处生成的规则按「去掉宿主前缀后的选择器 → 声明」归一化后比较，必须完全相同
  const rulesFor = (scope, prefix) => [...scope.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter(([, selector]) => selector.includes(prefix + ' ' + panel))
    .map(([, selector, body]) => `${selector.trim().split(prefix).join('<host>').replace(/\s+/g, ' ')} {${body.replace(/\s+/g, ' ').trim()}}`)
    .sort();
  const section = (header) => {
    const start = css.indexOf(header);
    assert.notEqual(start, -1, header);
    let depth = 0;
    for (let index = css.indexOf('{', start); index < css.length; index += 1) {
      if (css[index] === '{') depth += 1;
      if (css[index] === '}' && (depth -= 1) === 0) return css.slice(css.indexOf('{', start) + 1, index);
    }
    return '';
  };
  const phone = rulesFor(section('@media (max-width: 640px)'), '.chat-page.chat-page');
  const narrowed = rulesFor(section('@container chat-composer (max-width: 700px)'), '.chat-page.chat-page');
  const plugin = rulesFor(css.replace(/@(media|container)[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, ''), '.chat-page.chat-page.is-vscode-plugin');
  assert.ok(phone.length > 10, '窄输入框样式应生成完整规则');
  assert.deepEqual(narrowed, phone);
  assert.deepEqual(plugin, phone, '插件不再单独设计输入框');
  const all = phone.join('\n');
  assert.match(all, /\.upload-btn, <host> .* \.send-btn \{width: 44px !important; height: 44px !important;/);
  const panelRule = phone.find((rule) => rule.startsWith('<host> .chat-composer-panel') && rule.includes('{grid-template-rows')) ?? '';
  for (const declaration of ['grid-template-rows: auto auto auto;', 'display: grid;', 'grid-template-columns: 48px minmax(0, 1fr) auto;',
    'gap: 10px 8px;', 'padding: 13px 16px 13px 15px;', 'border-radius: 27px;']) {
    assert.ok(panelRule.includes(declaration), declaration);
  }
  assert.match(all, /\.file-edit-mode-trigger \{[^}]*overflow: hidden;[^}]*font-size: 12px;/);
  assert.match(all, /> span \{min-width: 0; overflow: hidden; text-overflow: ellipsis;\}/);
  assert.doesNotMatch(all, /\.chat-composer-modes \{[^}]*overflow/, 'popovers anchored to the chip row must not be clipped');
  assert.doesNotMatch(css, /36px !important/, '不再有插件专用的 36px 按钮');
  // 外观也统一为对话中的输入框：欢迎页窄屏的发光圆钮、胶囊形面板不再覆盖
  assert.match(all, /\.upload-btn \{border: 1px solid rgba\(236, 239, 255, 0\.06\) !important; background: transparent !important; box-shadow: none;\}/);
  assert.match(all, /\.send-btn:disabled \{opacity: 0\.4 !important; border-color: rgba\(255, 255, 255, 0\.08\) !important; background: rgba\(167, 174, 202, 0\.24\) !important; box-shadow: none !important;\}/);
  assert.match(all, /border: 1px solid rgba\(227, 233, 255, 0\.17\); border-radius: 27px; background: rgba\(21, 37, 66, 0\.76\);/);
});

test('conversation composer send button matches the 44px upload button', async () => {
  const { readFile } = await import('node:fs/promises');
  const chatBox = await readFile(new URL('../src/components/ChatBox/ChatBox.less', import.meta.url), 'utf8');
  assert.match(chatBox, /\.chat-page \.chat-composer-panel \.upload-btn \{ width: 44px !important; height: 44px !important;/);
  assert.match(chatBox, /\.chat-page \.send-btn \{ width: 44px !important; height: 44px !important;/);
  assert.match(chatBox, /:not\(\.is-vscode-plugin\) \.chat-composer-panel \.send-btn \{\s*width: 44px !important;\s*height: 44px !important;/);
  assert.doesNotMatch(chatBox, /\.send-btn \{[^}]*width: 58px/, 'no breakpoint may enlarge send past the upload button');
});
