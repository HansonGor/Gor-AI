import assert from 'node:assert/strict';
import test from 'node:test';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Module, { createRequire } from 'node:module';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

const filename = fileURLToPath(new URL('./file-edit-mode.fixture.cjs', import.meta.url));
const compiled = await build({
  entryPoints: [fileURLToPath(new URL('../src/components/chat/FileEditModeSelector.tsx', import.meta.url))],
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
const Selector = fixture.exports.default;
const hookBuild = await build({ entryPoints: [fileURLToPath(new URL('../src/hooks/useFileEditMode.ts', import.meta.url))],
  bundle: true, platform: 'node', format: 'cjs', write: false, packages: 'external' });
const hookFixture = new Module(filename);
hookFixture.filename = filename;
hookFixture.paths = fixture.paths;
hookFixture.require = createRequire(filename);
hookFixture._compile(hookBuild.outputFiles[0].text, filename);
const { useFileEditMode } = hookFixture.exports;
const dom = new JSDOM('<!doctype html><body><div id="root"></div><button id="outside">outside</button></body>');
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.Node = dom.window.Node;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

test('shared selector switches local display, preserves selection and returns focus', async () => {
  const root = createRoot(document.getElementById('root'));
  await act(async () => root.render(React.createElement(Selector)));
  const trigger = document.querySelector('.file-edit-mode-trigger');
  assert.equal(trigger.textContent, '即刻落笔');
  assert.ok(trigger.querySelector('.lucide-pencil-line'));
  await act(async () => trigger.click());
  const options = document.querySelectorAll('[role="radio"]');
  // 审阅落笔排在前面，默认仍选中即刻落笔。
  assert.deepEqual([...options].map(o => o.querySelector('strong').textContent), ['审阅落笔', '即刻落笔']);
  assert.equal(options[1].getAttribute('aria-checked'), 'true');
  assert.ok(options[0].querySelector('.lucide-book-open-check'));
  await act(async () => options[0].click());
  assert.equal(trigger.textContent, '审阅落笔');
  assert.equal(document.querySelector('[role="dialog"]'), null);
  assert.equal(document.activeElement, trigger);
  await act(async () => trigger.click());
  assert.equal(document.querySelectorAll('[role="radio"]')[0].getAttribute('aria-checked'), 'true');
  await act(async () => root.unmount());
});

test('Escape and outside pointer dismiss without selecting or notifying the host', async () => {
  const root = createRoot(document.getElementById('root'));
  const selections = [];
  await act(async () => root.render(React.createElement(Selector, { onChange: value => selections.push(value) })));
  const trigger = document.querySelector('.file-edit-mode-trigger');
  await act(async () => trigger.click());
  const options = document.querySelectorAll('[role="radio"]');
  options[0].focus();
  await act(async () => options[0].dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })));
  assert.equal(document.activeElement, options[1]);
  await act(async () => document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  assert.equal(document.querySelector('[role="dialog"]'), null);
  assert.equal(document.activeElement, trigger);
  await act(async () => trigger.click());
  await act(async () => document.getElementById('outside').dispatchEvent(new dom.window.Event('pointerdown', { bubbles: true })));
  assert.equal(document.querySelector('[role="dialog"]'), null);
  assert.equal(trigger.textContent, '即刻落笔');
  assert.deepEqual(selections, []);
  await act(async () => root.unmount());
});

test('controlled selection remains host-owned and callback is called only on explicit selection', async () => {
  const root = createRoot(document.getElementById('root'));
  const selections = [];
  const onChange = value => selections.push(value);
  await act(async () => root.render(React.createElement(Selector, { value: 'review', onChange })));
  const trigger = document.querySelector('.file-edit-mode-trigger');
  await act(async () => trigger.click());
  await act(async () => document.querySelectorAll('[role="radio"]')[1].click());
  assert.deepEqual(selections, ['instant']);
  assert.equal(trigger.textContent, '审阅落笔');
  await act(async () => root.render(React.createElement(Selector, { value: 'instant', onChange })));
  assert.equal(trigger.textContent, '即刻落笔');
  await act(async () => root.unmount());
});

test('global preference is persisted, send freezes mode, failed writes never fall back to auto', async () => {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push([url, options]);
    const mode = options.method === 'GET' ? 'review' : JSON.parse(options.body).editMode;
    return { ok: true, json: async () => ({ editMode: mode }) };
  };
  const root = createRoot(document.getElementById('root'));
  let hook;
  function Host({ id }) { hook = useFileEditMode(id); return null; }
  try {
    await act(async () => root.render(React.createElement(Host, { id: 's' })));
    assert.equal(hook.fileEditMode, 'review');
    const frozen = hook.freezeFileEditMode();
    await act(async () => hook.setFileEditMode('instant'));
    assert.equal(await frozen, 'review');
    assert.equal(await hook.freezeFileEditMode(), 'auto');
    assert.equal(JSON.parse(calls.at(-1)[1].body).editMode, 'auto');
    globalThis.fetch = async () => ({ ok: false });
    await act(async () => hook.setFileEditMode('review'));
    await assert.rejects(hook.freezeFileEditMode());
    assert.equal(hook.fileEditMode, 'instant');
    await act(async () => root.render(React.createElement(Host, { id: 'other' })));
    await assert.rejects(hook.freezeFileEditMode());
  } finally {
    await act(async () => root.unmount());
    globalThis.fetch = original;
  }
});

test('Web and VS Code hosts and different sessions reload the same global mode', async () => {
  const original = globalThis.fetch;
  let saved = 'auto';
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push(options);
    if (options.method === 'PUT') saved = JSON.parse(options.body).editMode;
    return { ok: true, json: async () => ({ editMode: saved }) };
  };
  const root = createRoot(document.getElementById('root'));
  const hosts = {};
  function Host({ name, id }) { hosts[name] = useFileEditMode(id); return null; }
  const render = (webKey, pluginKey, otherKey = 'other') => root.render(React.createElement(React.Fragment, null,
    React.createElement(Host, { key: webKey, name: 'web', id: 'session-a' }),
    React.createElement(Host, { key: pluginKey, name: 'vscode', id: 'session-b' }),
    React.createElement(Host, { key: otherKey, name: 'other', id: 'session-c' })));
  try {
    await act(async () => render('web-1', 'plugin-1'));
    await act(async () => hosts.web.setFileEditMode('review'));
    assert.equal(saved, 'review');
    await act(async () => render('web-1', 'plugin-1', 'other-reloaded'));
    assert.equal(hosts.other.fileEditMode, 'review');
    await act(async () => render('web-1', 'plugin-2'));
    assert.equal(hosts.vscode.fileEditMode, 'review');
    await act(async () => hosts.vscode.setFileEditMode('instant'));
    await act(async () => render('web-2', 'plugin-2', 'other-reloaded-again'));
    assert.equal(hosts.web.fileEditMode, 'instant');
    assert.equal(hosts.other.fileEditMode, 'instant');
    assert.ok(requests.every(options => options.cache === 'no-store'));
  } finally { await act(async () => root.unmount()); globalThis.fetch = original; }
});

test('selection waits for save confirmation; failed saves retain the confirmed mode and block sends', async () => {
  const original = globalThis.fetch;
  let complete;
  globalThis.fetch = async (_url, options) => options.method === 'GET'
    ? { ok: true, json: async () => ({ editMode: 'review' }) }
    : new Promise(resolve => { complete = resolve; });
  const root = createRoot(document.getElementById('root'));
  let hook;
  const errors = [];
  function Host() { hook = useFileEditMode('s', message => errors.push(message)); return null; }
  try {
    await act(async () => root.render(React.createElement(Host)));
    const oldSend = hook.freezeFileEditMode();
    await act(async () => hook.setFileEditMode('instant'));
    const newSend = hook.freezeFileEditMode();
    assert.equal(hook.fileEditModeLoading, true);
    assert.equal(hook.fileEditMode, 'review');
    assert.equal(await oldSend, 'review');
    await act(async () => complete({ ok: false }));
    await assert.rejects(newSend);
    assert.equal(hook.fileEditModeLoading, false);
    assert.equal(hook.fileEditMode, 'review');
    assert.equal(errors.length, 1);
    await act(async () => hook.setFileEditMode('instant'));
    await act(async () => complete({ ok: true, json: async () => ({ editMode: 'auto' }) }));
    assert.equal(hook.fileEditMode, 'instant');
    assert.equal(await hook.freezeFileEditMode(), 'auto');
    assert.equal(hook.fileEditModeLoading, false);
  } finally { await act(async () => root.unmount()); globalThis.fetch = original; }
});

test('a delayed save from a previous session cannot change the current selection', async () => {
  const original = globalThis.fetch;
  let complete;
  globalThis.fetch = async (url, options) => options.method === 'GET'
    ? { ok: true, json: async () => ({ editMode: url.includes('/old/') ? 'review' : 'auto' }) }
    : new Promise(resolve => { complete = resolve; });
  const root = createRoot(document.getElementById('root'));
  let hook;
  function Host({ id }) { hook = useFileEditMode(id); return null; }
  try {
    await act(async () => root.render(React.createElement(Host, { id: 'old' })));
    await act(async () => hook.setFileEditMode('review'));
    await act(async () => root.render(React.createElement(Host, { id: 'new' })));
    await act(async () => complete({ ok: true, json: async () => ({ editMode: 'review' }) }));
    assert.equal(hook.fileEditMode, 'instant');
    assert.equal(await hook.freezeFileEditMode(), 'auto');
    assert.equal(hook.fileEditModeLoading, false);
  } finally { await act(async () => root.unmount()); globalThis.fetch = original; }
});

test('shared selector shows loading and prevents repeat switching until the save finishes', async () => {
  const original = globalThis.fetch;
  let complete;
  let writes = 0;
  globalThis.fetch = async (_url, options) => options.method === 'GET'
    ? { ok: true, json: async () => ({ editMode: 'auto' }) }
    : new Promise(resolve => { writes++; complete = resolve; });
  const root = createRoot(document.getElementById('root'));
  function Host() {
    const mode = useFileEditMode('loading');
    return React.createElement(Selector, { value: mode.fileEditMode,
      loading: mode.fileEditModeLoading, onChange: mode.setFileEditMode });
  }
  try {
    await act(async () => root.render(React.createElement(Host)));
    const trigger = document.querySelector('.file-edit-mode-trigger');
    await act(async () => trigger.click());
    await act(async () => document.querySelectorAll('[role="radio"]')[0].click());
    assert.equal(trigger.disabled, true);
    assert.equal(trigger.getAttribute('aria-busy'), 'true');
    assert.ok(trigger.querySelector('.lucide-loader-circle.animate-spin'));
    assert.equal(trigger.textContent, '即刻落笔');
    await act(async () => trigger.click());
    assert.equal(writes, 1);
    assert.equal(document.querySelector('[role="dialog"]'), null);
    await act(async () => complete({ ok: true, json: async () => ({ editMode: 'review' }) }));
    assert.equal(trigger.disabled, false);
    assert.equal(trigger.textContent, '审阅落笔');
    assert.equal(trigger.querySelector('.animate-spin'), null);
  } finally { await act(async () => root.unmount()); globalThis.fetch = original; }
});
