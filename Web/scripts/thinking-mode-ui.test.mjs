import assert from 'node:assert/strict';
import test from 'node:test';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Module, { createRequire } from 'node:module';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

const filename = fileURLToPath(new URL('./thinking-mode.fixture.cjs', import.meta.url));
const compiled = await build({
  stdin: { contents: `
    export { default as Selector } from '../src/components/chat/ThinkingModeSelector';
    export { useThinkingMode } from '../src/hooks/useThinkingMode';
    export { useShowThinking, setShowThinking, resetShowThinkingForTests } from '../src/utils/thinkingVisibility';
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
const { Selector, useThinkingMode, useShowThinking, setShowThinking, resetShowThinkingForTests } = fixture.exports;
const dom = new JSDOM('<!doctype html><body><div id="root"></div><button id="outside">outside</button></body>', { url: 'http://gor.test/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.Node = dom.window.Node;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
Object.defineProperty(globalThis, 'localStorage', { value: dom.window.localStorage, configurable: true, writable: true });

async function mount(element) {
  const root = createRoot(document.getElementById('root'));
  await act(async () => root.render(element));
  return root;
}

test('selector defaults to 深思, switches to 随思, closes and returns focus', async () => {
  const changes = [];
  const root = await mount(React.createElement(Selector, { onChange: mode => changes.push(mode) }));
  const trigger = document.querySelector('.thinking-mode-selector .file-edit-mode-trigger');
  assert.equal(trigger.textContent, '深思');
  assert.ok(trigger.querySelector('.lucide-brain'));
  await act(async () => trigger.click());
  const options = document.querySelectorAll('[role="radio"]');
  assert.deepEqual([...options].map(o => o.querySelector('strong').textContent), ['随思', '深思']);
  assert.match(options[0].textContent, /不做深度推理/);
  assert.equal(options[1].getAttribute('aria-checked'), 'true');
  assert.ok(options[0].querySelector('.lucide-lightbulb'));
  await act(async () => options[0].click());
  assert.deepEqual(changes, ['light']);
  assert.equal(trigger.textContent, '随思');
  assert.equal(document.querySelector('[role="dialog"]'), null);
  assert.equal(document.activeElement, trigger);
  await act(async () => root.unmount());
});

test('visibility switch reports changes without closing the popover and marks hidden state on the trigger', async () => {
  const shows = [];
  let root = await mount(React.createElement(Selector, { value: 'deep', showThinking: true, onShowThinkingChange: v => shows.push(v) }));
  let trigger = document.querySelector('.file-edit-mode-trigger');
  assert.equal(trigger.querySelector('.thinking-mode-hidden-mark'), null);
  await act(async () => trigger.click());
  const toggle = document.querySelector('[role="switch"]');
  assert.equal(toggle.getAttribute('aria-checked'), 'true');
  assert.match(toggle.textContent, /显示思考过程/);
  await act(async () => toggle.click());
  assert.deepEqual(shows, [false]);
  assert.ok(document.querySelector('[role="dialog"]'), 'switch must not close the popover');
  await act(async () => root.unmount());

  root = await mount(React.createElement(Selector, { value: 'deep', showThinking: false }));
  trigger = document.querySelector('.file-edit-mode-trigger');
  assert.ok(trigger.querySelector('.thinking-mode-hidden-mark'));
  assert.equal(trigger.getAttribute('aria-label'), '思考方式：深思，已隐藏思考过程');
  await act(async () => trigger.click());
  assert.equal(document.querySelector('[role="switch"]').getAttribute('aria-checked'), 'false');
  await act(async () => root.unmount());
});

test('Escape and outside pointer dismiss without changing the mode', async () => {
  const changes = [];
  const root = await mount(React.createElement(Selector, { value: 'light', onChange: m => changes.push(m) }));
  const trigger = document.querySelector('.file-edit-mode-trigger');
  await act(async () => trigger.click());
  await act(async () => document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape' })));
  assert.equal(document.querySelector('[role="dialog"]'), null);
  assert.equal(document.activeElement, trigger);
  await act(async () => trigger.click());
  await act(async () => document.getElementById('outside').dispatchEvent(new dom.window.Event('pointerdown', { bubbles: true })));
  assert.equal(document.querySelector('[role="dialog"]'), null);
  assert.deepEqual(changes, []);
  await act(async () => root.unmount());
});

function fakeServer(initial = {}, { failRead = false } = {}) {
  const saved = { ...initial };
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const session = decodeURIComponent(url.split('/session/')[1].split('/')[0]);
    calls.push({ url, method: init.method });
    if (failRead && (init.method ?? 'GET') === 'GET') return { ok: false, json: async () => ({}) };
    if (init.method === 'PUT') saved[session] = JSON.parse(init.body).thinkingMode;
    return { ok: true, json: async () => ({ thinkingMode: saved[session] ?? 'deep' }) };
  };
  return { saved, calls };
}

function HookProbe({ sessionId, onError, sink }) {
  sink.current = useThinkingMode(sessionId, onError);
  return null;
}

test('session thinking mode is loaded, saved to the server and frozen at send', async () => {
  const fresh = fakeServer();
  const freshSink = { current: null };
  const freshRoot = await mount(React.createElement(HookProbe, { sessionId: 'new', sink: freshSink }));
  await act(async () => { await freshSink.current.freezeThinkingMode(); });
  assert.equal(freshSink.current.thinkingMode, 'deep', 'new sessions default to 深思');
  assert.equal(fresh.calls.length, 1);
  await act(async () => freshRoot.unmount());

  const server = fakeServer({ s1: 'deep' });
  const sink = { current: null };
  const root = await mount(React.createElement(HookProbe, { sessionId: 's1', sink }));
  await act(async () => { await sink.current.freezeThinkingMode(); });
  assert.equal(sink.current.thinkingMode, 'deep');
  assert.match(server.calls[0].url, /\/api\/chat\/session\/s1\/thinking-mode$/);
  await act(async () => { sink.current.setThinkingMode('light'); await sink.current.freezeThinkingMode(); });
  assert.equal(server.saved.s1, 'light');
  assert.equal(sink.current.thinkingMode, 'light');
  assert.equal(await sink.current.freezeThinkingMode(), 'light');
  await act(async () => root.unmount());
});

test('failed reads fall back to 深思 for sending and report an error', async () => {
  fakeServer({}, { failRead: true });
  const errors = [];
  const sink = { current: null };
  const root = await mount(React.createElement(HookProbe, { sessionId: 's2', sink, onError: m => errors.push(m) }));
  let frozen;
  await act(async () => { frozen = await sink.current.freezeThinkingMode(); });
  assert.equal(frozen, 'deep');
  assert.equal(sink.current.thinkingMode, 'deep');
  assert.deepEqual(errors, ['思考方式保存失败。']);
  await act(async () => root.unmount());
});

function VisibilityProbe({ sink }) {
  sink.current = useShowThinking();
  return null;
}

test('show-thinking preference defaults on, persists, and survives unavailable storage', async () => {
  localStorage.clear();
  resetShowThinkingForTests();
  const sink = { current: null };
  const root = await mount(React.createElement(VisibilityProbe, { sink }));
  assert.equal(sink.current, true);
  await act(async () => setShowThinking(false));
  assert.equal(sink.current, false);
  assert.equal(localStorage.getItem('gor:show-thinking'), 'false');
  resetShowThinkingForTests();
  assert.equal(localStorage.getItem('gor:show-thinking'), 'false');
  await act(async () => setShowThinking(true));
  await act(async () => root.unmount());

  const original = globalThis.localStorage;
  Object.defineProperty(globalThis, 'localStorage', { get() { throw new Error('blocked'); }, configurable: true });
  try {
    resetShowThinkingForTests();
    const blocked = { current: null };
    const r2 = await mount(React.createElement(VisibilityProbe, { sink: blocked }));
    assert.equal(blocked.current, true);
    await act(async () => setShowThinking(false));
    assert.equal(blocked.current, false, 'falls back to in-memory value');
    await act(async () => r2.unmount());
  } finally {
    Object.defineProperty(globalThis, 'localStorage', { value: original, configurable: true, writable: true });
    resetShowThinkingForTests();
  }
});
