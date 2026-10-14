import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import Module, { createRequire } from 'node:module';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import less from 'less';
import postcss from 'postcss';

// Compile the real shared component in memory; do not write a generated fixture.
const filename = fileURLToPath(new URL('./code-diff-ui.fixture.cjs', import.meta.url));
const compiled = await build({
  entryPoints: [fileURLToPath(new URL('../src/components/chat/ProjectChanges.tsx', import.meta.url))],
  bundle: true, platform: 'node', format: 'cjs', write: false, packages: 'external',
  plugins: [{ name: 'test-styles', setup(builder) {
    builder.onResolve({ filter: /\.(css|less)$/ }, (args) => ({ path: args.path, namespace: 'test-styles' }));
    builder.onLoad({ filter: /.*/, namespace: 'test-styles' }, () => ({ contents: '', loader: 'js' }));
  } }],
});
const fixture = new Module(filename);
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>');
globalThis.window = dom.window;
globalThis.document = dom.window.document;
for (const name of ['HTMLElement', 'Element', 'Node', 'DocumentFragment', 'HTMLInputElement', 'MutationObserver', 'CustomEvent', 'Event', 'KeyboardEvent']) globalThis[name] = dom.window[name];
globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
fixture.filename = filename;
fixture.paths = Module._nodeModulePaths(dirname(filename));
fixture.require = createRequire(filename);
fixture._compile(compiled.outputFiles[0].text, filename);
const ProjectChanges = fixture.exports.default;
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

test('real Unified UI expands and recollapses retained lines without changing raw Diff', async () => {
  const root = createRoot(document.getElementById('root'));
  const context = Array.from({ length: 24 }, (_, i) => ` unchanged-${i}`).join('\n');
  const raw = `--- a/App.jsx\n+++ b/App.jsx\n@@ -1,26 +1,26 @@\n-old\n+new\n${context}\n-old2\n+new2\n`;
  const changes = Object.freeze([Object.freeze({ path: '/src/App.jsx', diff: raw })]);
  await act(async () => root.render(React.createElement(ProjectChanges, { changes, title: '修改了 1 个文件', label: '变更' })));
  assert.ok(document.querySelector('table.diff-unified'));
  assert.equal(document.querySelector('table.diff-split'), null);
  assert.equal(document.querySelectorAll('.diff-line').length, 10);
  assert.equal(document.querySelector('.diff-line').querySelectorAll('.code-diff-gutter').length, 1);
  const button = document.querySelector('.code-diff-fold button');
  assert.match(button.textContent, /··· 省略 18 行/);
  assert.equal(button.getAttribute('aria-expanded'), 'false');
  await act(async () => button.click());
  assert.equal(document.querySelectorAll('.diff-line').length, 28);
  assert.equal(button.getAttribute('aria-expanded'), 'true');
  await act(async () => button.click());
  assert.equal(document.querySelectorAll('.diff-line').length, 10);
  assert.equal(document.querySelector('.code-diff-original'), null);
  assert.equal(changes[0].diff, raw);
  // A new revision must reset expansion state without a raw-text disclosure.
  await act(async () => button.click());
  const nextRaw = raw.replace('+new\n', '+updated\n');
  await act(async () => root.render(React.createElement(ProjectChanges, {
    changes: [{ path: '/src/App.jsx', diff: nextRaw }], title: '修改了 1 个文件', label: '变更', restored: true,
  })));
  assert.equal(document.querySelector('.code-diff-fold button').getAttribute('aria-expanded'), 'false');
  assert.equal(document.querySelector('.code-diff-original'), null);
  await act(async () => root.unmount());
});

test('mode switch preserves folded data and renders old/new gutters in Split', async () => {
  const root = createRoot(document.getElementById('root'));
  const raw = '--- a/x\n+++ b/x\n@@ -12,2 +15,2 @@\n context\n-old\n+new\n';
  const changes = Object.freeze([Object.freeze({ path: 'x', diff: raw })]);
  await act(async () => root.render(React.createElement(ProjectChanges, { changes, title: '变更', label: '变更' })));
  const buttons = document.querySelectorAll('.code-diff-modes button');
  assert.equal(buttons[0].getAttribute('aria-pressed'), 'true');
  await act(async () => buttons[1].click());
  assert.ok(document.querySelector('.diff-split'));
  assert.equal(buttons[1].getAttribute('aria-pressed'), 'true');
  assert.equal(document.querySelectorAll('.code-diff-side-labels span').length, 2);
  const gutters = document.querySelector('.diff-line').querySelectorAll('.code-diff-gutter');
  assert.equal(gutters.length, 2);
  assert.equal(gutters[0].firstElementChild.textContent, '12');
  assert.equal(gutters[1].firstElementChild.textContent, '15');
  assert.equal(changes[0].diff, raw);
  await act(async () => buttons[0].click());
  assert.ok(document.querySelector('.diff-unified'));
  assert.equal(document.querySelector('.code-diff-side-labels'), null);
  assert.equal(document.querySelector('.diff-line').querySelectorAll('.code-diff-gutter').length, 1);
  await act(async () => root.unmount());
});

test('new and deleted files still have two sides in Split without fabricated source', async () => {
  const root = createRoot(document.getElementById('root'));
  for (const raw of [
    '--- /dev/null\n+++ b/x\n@@ -0,0 +1,1 @@\n+new\n',
    '--- a/x\n+++ /dev/null\n@@ -1,1 +0,0 @@\n-old\n',
  ]) {
    await act(async () => root.render(React.createElement(ProjectChanges, { changes: [{ path: 'x', diff: raw }], title: '变更', label: '变更' })));
    await act(async () => document.querySelectorAll('.code-diff-modes button')[1].click());
    assert.ok(document.querySelector('.diff-split'));
    assert.equal(document.querySelectorAll('.code-diff-gutter').length, 1);
    assert.equal(document.querySelectorAll('.diff-line').length, 1);
    assert.equal(document.querySelector('.code-diff-original'), null);
  }
  await act(async () => root.unmount());
});

test('fallback retains truncated data; missing context has no misleading expand button', async () => {
  const root = createRoot(document.getElementById('root'));
  const raw = '--- a/x\n+++ b/x\n@@ -12,1 +12,1 @@\n-a\n+b\n@@ -40,1 +40,1 @@\n-c\n+d\n';
  await act(async () => root.render(React.createElement(ProjectChanges, {
    changes: [{ path: 'x', diff: raw }], title: '变更', label: '变更',
  })));
  assert.match(document.querySelector('.code-diff-fold').textContent, /省略 27 行.*未随 Diff 提供/);
  assert.equal(document.querySelector('.code-diff-fold button'), null);
  const truncated = raw + '... diff truncated ...';
  await act(async () => root.render(React.createElement(ProjectChanges, {
    changes: [{ path: 'x', diff: truncated }], title: '变更', label: '变更',
  })));
  assert.equal(document.querySelector('pre').textContent, truncated);
  await act(async () => root.unmount());
});

test('mobile Diff styles wrap long code, constrain tables and keep stable px typography', async () => {
  const path = fileURLToPath(new URL('../src/components/chat/CodeDiff.less', import.meta.url));
  const { css } = await less.render(await readFile(path, 'utf8'), { filename: path });
  const sheet = postcss.parse(css);
  const values = (selector) => {
    const result = {};
    sheet.walkRules(selector, (rule) => rule.walkDecls((decl) => { result[decl.prop] = decl.value; }));
    return result;
  };
  assert.equal(values('.code-diff .diff')['table-layout'], 'fixed');
  assert.equal(values('.code-diff .diff-code')['white-space'], 'pre-wrap');
  assert.equal(values('.code-diff .diff-code')['overflow-wrap'], 'anywhere');
  assert.equal(values('.code-diff')['max-width'], '100%');
  assert.equal(values('.code-diff .diff')['font-size'], '12px');
  assert.equal(values('.code-diff .diff-gutter')['text-align'], 'left');
  assert.equal(values('.code-diff .diff-unified .diff-gutter-col:first-child')['width'], '0');
  assert.equal(values('.code-diff .diff-gutter-col:first-child')['width'], undefined);
  assert.equal(values('.project-changes-toolbar')['flex-wrap'], 'wrap');
});

test('Web and plugin share the same dark Diff context canvas while edit rows keep semantic colors', async () => {
  const componentPath = fileURLToPath(new URL('../src/components/chat/CodeDiff.less', import.meta.url));
  const chatPath = fileURLToPath(new URL('../src/pages/chat/chat.less', import.meta.url));
  const [{ css: componentCss }, { css: chatCss }] = await Promise.all([
    less.render(await readFile(componentPath, 'utf8'), { filename: componentPath }),
    less.render(await readFile(chatPath, 'utf8'), { filename: chatPath }),
  ]);
  const componentSheet = postcss.parse(componentCss);
  const chatSheet = postcss.parse(chatCss);
  const value = (sheet, selector, property) => {
    let found;
    sheet.walkRules(selector, rule => rule.walkDecls(property, decl => { found = decl.value; }));
    return found;
  };
  assert.equal(value(componentSheet, '.code-diff', '--diff-background-color'), '#252d47');
  assert.equal(value(componentSheet, '.code-diff', '--diff-code-insert-background-color'), '#2c493d');
  assert.equal(value(componentSheet, '.code-diff', '--diff-code-delete-background-color'), '#463140');
  assert.equal(value(chatSheet, '.chat-page:not(.is-vscode-plugin):not(.theme-light) .code-diff', '--diff-background-color'), undefined);
  assert.equal(value(componentSheet, '.theme-light .code-diff', '--diff-background-color'), '#f2f4fa');
});

test('batch button colors follow native disabled state with a restrained enabled-only hover', async () => {
  const path = fileURLToPath(new URL('../src/components/chat/ProjectChanges.less', import.meta.url));
  const { css } = await less.render(await readFile(path, 'utf8'), { filename: path });
  const sheet = postcss.parse(css);
  const values = selector => {
    const result = {};
    sheet.walkRules(selector, rule => rule.walkDecls(decl => { result[decl.prop] = decl.value; }));
    return result;
  };
  const button = '.project-changes.project-changes .project-changes-actions button';
  let desktop, narrow;
  sheet.walkRules(button, rule => {
    const declarations = Object.fromEntries(rule.nodes.filter(node => node.type === 'decl').map(node => [node.prop, node.value]));
    if (rule.parent.type === 'atrule') narrow = declarations;
    else desktop = declarations;
  });
  assert.equal(desktop.height, '44px');
  assert.equal(desktop['font-size'], '15px');
  assert.equal(desktop['line-height'], '22px');
  assert.equal(narrow['font-size'], '14px');
  assert.equal(values(button).background.toLowerCase(), '#29344f');
  assert.equal(values(button).border.toLowerCase(), '1px solid #526080');
  assert.equal(values(button).color.toLowerCase(), '#d9d2f2');
  assert.equal(values(button).transition, 'background-color 150ms ease');
  assert.equal(values(`${button}:disabled`).background.toLowerCase(), '#202a42');
  assert.equal(values(`${button}:disabled`)['border-color'].toLowerCase(), '#34405a');
  assert.equal(values(`${button}:disabled`).color.toLowerCase(), '#7986a0');
  assert.deepEqual(Object.keys(values(`${button}:not(:disabled):hover`)), ['background']);
  assert.equal(values(`${button} > svg`).color, 'inherit');
  let singleBackground;
  sheet.walkRules(rule => {
    if (rule.selectors.includes('.project-changes.project-changes .project-change-action')) {
      rule.walkDecls('background', decl => { singleBackground = decl.value; });
    }
  });
  assert.equal(singleBackground, 'transparent');
});

test('one group toolbar controls all files; summaries own path and counts without duplicate headers', async () => {
  const root = createRoot(document.getElementById('root'));
  const raw = '--- a/x\n+++ b/x\n@@ -1,1 +1,1 @@\n-old\n+new\n';
  const changes = Object.freeze(['x', 'y'].map((path) => Object.freeze({ path, diff: raw })));
  await act(async () => root.render(React.createElement(ProjectChanges, { changes, title: '两个文件', label: '变更' })));
  assert.equal(document.querySelectorAll('.code-diff-modes').length, 1);
  assert.ok(document.querySelector('.project-changes-toolbar .code-diff-modes'));
  assert.equal(document.querySelectorAll('.code-diff-header').length, 0);
  assert.equal(document.querySelectorAll('summary .code-diff-stats').length, 2);
  assert.equal(document.querySelectorAll('summary .code-diff-path').length, 2);
  const details = document.querySelectorAll('.project-change');
  details[0].open = true;
  const buttons = document.querySelectorAll('.code-diff-modes button');
  await act(async () => buttons[1].click());
  assert.equal(document.querySelectorAll('.diff-split').length, 2);
  assert.equal(details[0].open, true);
  assert.equal(details[1].open, false);
  await act(async () => buttons[0].click());
  assert.equal(document.querySelectorAll('.diff-unified').length, 2);
  assert.equal(changes[0].diff, raw);
  await act(async () => root.unmount());
});

test('Unified-only capability removes mode controls and overrides an existing Split selection', async () => {
  const root = createRoot(document.getElementById('root'));
  const changes = [{ path: 'x', diff: '--- a/x\n+++ b/x\n@@ -1,1 +1,1 @@\n-old\n+new\n' }];
  const props = { changes, title: '变更', label: '变更' };
  await act(async () => root.render(React.createElement(ProjectChanges, props)));
  await act(async () => document.querySelectorAll('.code-diff-modes button')[1].click());
  assert.ok(document.querySelector('.diff-split'));
  await act(async () => root.render(React.createElement(ProjectChanges, { ...props, allowSplit: false })));
  assert.equal(document.querySelector('.code-diff-modes'), null);
  assert.equal(document.querySelector('.diff-split'), null);
  assert.ok(document.querySelector('.diff-unified'));
  await act(async () => root.unmount());
});

test('screenshot summary renders display states and keeps actions unavailable without a real ChangeSet', async () => {
  const root = createRoot(document.getElementById('root'));
  const raw = '--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n';
  const changes = Object.freeze([
    Object.freeze({ path: '/src/App.jsx', diff: raw, displayStatus: 'pending' }),
    Object.freeze({ path: '/index.html', diff: raw, displayStatus: 'pending' }),
    Object.freeze({ path: '/src/utils.ts', diff: raw, displayStatus: 'changed' }),
    Object.freeze({ path: '/src/styles.css', diff: raw, displayStatus: 'reverted' }),
  ]);
  await act(async () => root.render(React.createElement(ProjectChanges, { changes, title: '旧标题', label: '变更', allowSplit: false })));
  assert.equal(document.querySelector('.project-changes-title').textContent, '此番落笔 · 四卷留痕');
  assert.equal(document.querySelector('.project-changes-status-counts').textContent, '2 待落笔 · 1 已落笔 · 1 已复原');
  assert.equal(document.querySelector('.project-changes-accept').textContent, '一并落笔 (2)');
  assert.equal(document.querySelector('.project-changes-revert').textContent, '一并复原 (1)');
  assert.equal(document.querySelectorAll('.project-change-action').length, 3);
  assert.equal(document.querySelectorAll('.project-change-complete').length, 1);
  assert.equal(document.querySelector('.project-change:last-child button'), null);
  for (const button of document.querySelectorAll('.project-changes-actions button, .project-change-action')) {
    assert.equal(button.disabled, true);
    await act(async () => button.click());
  }
  assert.equal(changes[0].displayStatus, 'pending');
  assert.equal(changes[0].diff, raw);
  assert.equal(document.querySelectorAll('details').length, 4);
  assert.equal(document.querySelectorAll('table.diff-unified').length, 4);
  assert.equal(document.querySelector('.project-changes p'), null);
  assert.equal(document.querySelector('.project-changes hr'), null);
  await act(async () => root.unmount());
});

test('single undo calls the API only for applied files and changes status only after refreshed ChangeSet', async () => {
  const root = createRoot(document.getElementById('root'));
  let status = 'applied';
  let undoCalls = 0;
  let reads = 0;
  const client = {
    async getChangeSet(id) {
      reads++;
      return { id, sessionId: 's', roundId: 'r', sealed: true,
        projectRef: { project_id: 'p', provider: 'vscode', root: null },
        files: [{ id: 'f1', path: '/src/App.jsx', status }] };
    },
    async undoFile(id, fileId) { undoCalls++; assert.equal(id, 'cs'); assert.equal(fileId, 'f1'); status = 'reverted';
      return { success: true, changeSetId: id, results: [{ fileId, path: '/src/App.jsx', success: true }] }; },
    async undoChangeSet() { throw new Error('unexpected batch undo'); },
  };
  const notices = [];
  const props = { changes: [{ path: '/src/App.jsx', diff: '--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n' }],
    title: '变更', label: '变更', changeSetId: 'cs', changeClient: client, onNotify: (...args) => notices.push(args) };
  await act(async () => root.render(React.createElement(ProjectChanges, props)));
  await act(async () => { await Promise.resolve(); });
  const undo = document.querySelector('.project-change-action');
  assert.equal(undo.disabled, false);
  const details = document.querySelector('.project-change');
  assert.equal(details.open, false);
  await act(async () => undo.click());
  assert.equal(undoCalls, 0);
  assert.equal(document.querySelector('.undo-confirm-title').textContent, '是否复原此番改动？');
  assert.equal(document.querySelector('.undo-confirm-description').textContent, '将此番复原至落笔前的版本。');
  assert.equal(document.querySelector('.undo-confirm-cancel').textContent, '暂且保留');
  assert.equal(document.querySelector('.undo-confirm-submit').textContent, '复归如初');
  assert.equal(document.querySelector('.undo-confirm-path').textContent, '/src/App.jsx');
  await act(async () => document.querySelector('.undo-confirm-submit').click());
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  assert.equal(undoCalls, 1);
  assert.equal(details.open, false, 'undo must not expand the Diff');
  assert.ok(reads >= 2);
  assert.match(document.querySelector('.project-changes-status-counts').textContent, /1 已复原/);
  assert.equal(document.querySelector('.project-change-action'), null);
  assert.deepEqual(notices.at(-1), ['文件已复原。', 'success']);
  await act(async () => root.unmount());
});

test('batch undo disables during request, refreshes partial results, and reports failed paths', async () => {
  const root = createRoot(document.getElementById('root'));
  const states = new Map([['/a.ts', 'applied'], ['/b.ts', 'applied'], ['/c.ts', 'pending']]);
  let batchCalls = 0;
  let release;
  const client = {
    async getChangeSet(id) { return { id, sessionId: 's', roundId: 'r', sealed: true,
      projectRef: { project_id: 'p', provider: 'preview', root: null },
      files: [...states].map(([path, status], index) => ({ id: `f${index}`, path, status })) }; },
    async undoFile() { throw new Error('unexpected file undo'); },
    async undoChangeSet() { batchCalls++; await new Promise((resolve) => { release = resolve; });
      states.set('/a.ts', 'reverted');
      return { success: false, changeSetId: 'cs', results: [
        { fileId: 'f0', path: '/a.ts', success: true }, { fileId: 'f1', path: '/b.ts', success: false, code: 'HASH_CONFLICT' },
      ] }; },
  };
  const notices = [];
  const changes = [...states.keys()].map((path) => ({ path, diff: '--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n' }));
  await act(async () => root.render(React.createElement(ProjectChanges, { changes, title: '变更', label: '变更',
    changeSetId: 'cs', changeClient: client, onNotify: (...args) => notices.push(args) })));
  await act(async () => { await Promise.resolve(); });
  const batch = document.querySelector('.project-changes-revert');
  assert.match(batch.textContent, /一并复原 \(2\)/);
  await act(async () => batch.click());
  assert.equal(batchCalls, 0);
  assert.equal(document.querySelector('.undo-confirm-path'), null);
  assert.equal(document.querySelector('.undo-confirm-title').textContent, '此番笔墨，是否悉数收回？');
  assert.equal(document.querySelector('.undo-confirm-description').textContent, '共涉 2 卷，皆将复归落笔前的模样。');
  await act(async () => document.querySelector('.undo-confirm-submit').click());
  assert.equal(batch.disabled, true);
  assert.equal(document.querySelector('.undo-confirm-submit').disabled, true);
  assert.equal(document.querySelector('.undo-confirm-cancel').disabled, true);
  assert.equal(document.querySelector('.undo-confirm-close').disabled, true);
  await act(async () => document.activeElement.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  assert.ok(document.querySelector('[role="alertdialog"]'), 'Escape cannot close an executing undo');
  await act(async () => document.querySelector('.undo-confirm-submit').click());
  await act(async () => batch.click());
  assert.equal(batchCalls, 1);
  await act(async () => release());
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  assert.match(document.querySelector('.project-changes-status-counts').textContent, /1 已落笔/);
  assert.match(document.querySelector('.project-changes-status-counts').textContent, /1 已复原/);
  assert.deepEqual(notices.at(-1), ['复原未完全完成：/b.ts（内容有异）', 'error']);
  await act(async () => root.unmount());
});

test('successful batch undo reports the restored file count in 卷', async () => {
  const root = createRoot(document.getElementById('root'));
  const client = {
    async getChangeSet(id) { return { id, sealed: true, files: [
      { id: 'f1', path: '/one.ts', status: 'applied' }, { id: 'f2', path: '/two.ts', status: 'applied' },
    ] }; },
    async undoFile() { throw new Error('unexpected single undo'); },
    async undoChangeSet() { return { success: true, changeSetId: 'cs', results: [
      { fileId: 'f1', path: '/one.ts', success: true }, { fileId: 'f2', path: '/two.ts', success: true },
    ] }; },
  };
  const notices = [];
  await act(async () => root.render(React.createElement(ProjectChanges, { changes: [
    { path: '/one.ts' }, { path: '/two.ts' },
  ], title: '变更', label: '变更', changeSetId: 'cs', changeClient: client, onNotify: (...args) => notices.push(args) })));
  await act(async () => { await Promise.resolve(); });
  await act(async () => document.querySelector('.project-changes-revert').click());
  await act(async () => document.querySelector('.undo-confirm-submit').click());
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  assert.deepEqual(notices.at(-1), ['已复原2卷。', 'success']);
  await act(async () => root.unmount());
});

test('cancel, close and Escape dismiss single/batch confirmation without any undo call', async () => {
  const root = createRoot(document.getElementById('root'));
  let calls = 0;
  const client = {
    async getChangeSet(id) { return { id, sealed: true, files: [{ id: 'f', path: '/react-demo/src/App.jsx', status: 'applied' }] }; },
    async undoFile() { calls++; }, async undoChangeSet() { calls++; },
  };
  await act(async () => root.render(React.createElement(ProjectChanges, { changes: [{ path: '/react-demo/src/App.jsx' }], title: '变更', label: '变更', changeSetId: 'cs', changeClient: client })));
  for (const trigger of ['.project-change-action', '.project-changes-revert']) {
    for (const dismiss of ['.undo-confirm-cancel', '.undo-confirm-close', 'Escape']) {
      await act(async () => document.querySelector(trigger).click());
      assert.ok(document.querySelector('[role="alertdialog"]'));
      await act(async () => {
        if (dismiss === 'Escape') document.activeElement.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        else document.querySelector(dismiss).click();
      });
      assert.equal(document.querySelector('[role="alertdialog"]'), null);
      assert.equal(calls, 0);
    }
  }
  await act(async () => root.unmount());
});

test('undo modal styles stay scoped, use glass and constrain narrow paths and buttons', async () => {
  const path = fileURLToPath(new URL('../src/components/chat/UndoConfirmModal.less', import.meta.url));
  const { css } = await less.render(await readFile(path, 'utf8'), { filename: path });
  assert.match(css, /backdrop-filter: blur\(22px\)/);
  assert.match(css, /max-width: 560px/);
  assert.match(css, /overflow-wrap: anywhere/);
  assert.match(css, /grid-template-columns: minmax\(0, 1fr\) minmax\(0, 1fr\)/);
  assert.match(css, /@media \(max-width: 480px\)/);
  assert.match(css, /\.undo-confirm-modal\.undo-confirm-modal \.undo-confirm-close\s*\{[^}]*z-index: 2;/);
  assert.match(css, /\.undo-confirm-modal\.undo-confirm-modal \.undo-confirm-visual\s*\{[^}]*pointer-events: none;/);
});

test('batch and per-file undo stay disabled when the ChangeSet has no applied files', async () => {
  const root = createRoot(document.getElementById('root'));
  const client = {
    async getChangeSet(id) { return { id, sessionId: 's', roundId: 'r', sealed: true,
      projectRef: { project_id: 'p', provider: 'preview', root: null },
      files: [{ id: 'f1', path: '/pending.ts', status: 'pending' }, { id: 'f2', path: '/done.ts', status: 'reverted' }] }; },
    async undoFile() { throw new Error('must not call undo'); },
    async undoChangeSet() { throw new Error('must not call undo'); },
  };
  const changes = [{ path: '/pending.ts' }, { path: '/done.ts' }];
  await act(async () => root.render(React.createElement(ProjectChanges, { changes, title: '变更', label: '变更', changeSetId: 'cs', changeClient: client })));
  await act(async () => { await Promise.resolve(); });
  assert.equal(document.querySelector('.project-changes-revert').disabled, true);
  assert.equal(document.querySelectorAll('.project-change-action').length, 1);
  assert.equal(document.querySelector('.project-change-action').disabled, true);
  assert.equal(document.querySelectorAll('.project-change-complete').length, 1);
  assert.match(document.querySelector('.project-changes-status-counts').textContent, /0 已落笔/);
  await act(async () => root.unmount());
});

test('summary skin keeps theme, compact rows, 180ms chevrons and mobile actions side by side', async () => {
  const path = fileURLToPath(new URL('../src/components/chat/ProjectChanges.less', import.meta.url));
  const { css } = await less.render(await readFile(path, 'utf8'), { filename: path });
  assert.match(css, /background: #1c2439/);
  assert.match(css, /border-radius: 14px/);
  assert.match(css, /padding: 16px/);
  assert.match(css, /grid-template-columns: minmax\(0, 1fr\) minmax\(0, 1fr\)/);
  assert.match(css, /color: #f0c96f/);
  assert.match(css, /color: #9fd5b4/);
  assert.match(css, /color: #8995b1/);
  assert.match(css, /@media \(max-width: 480px\)/);
  assert.match(css, /transition: transform 180ms ease/);
  assert.match(css, /transform: rotate\(90deg\)/);
});

test('file badges follow extensions; left arrow, badge and info toggle independently and multiple files stay open', async () => {
  const root = createRoot(document.getElementById('root'));
  const changes = ['a.jsx', 'b.tsx', 'c.html', 'd.css', 'e.js', 'f.ts'].map((path) => ({ path }));
  await act(async () => root.render(React.createElement(ProjectChanges, { changes, title: '变更', label: '变更' })));
  const rows = [...document.querySelectorAll('.project-change')];
  assert.ok(rows.every((row) => !row.open));
  assert.deepEqual([...document.querySelectorAll('.project-change-badge')].map((badge) => badge.textContent), ['JSX', 'TSX', 'HTML', 'CSS', 'JS', 'TS']);
  for (const selector of ['.project-change-chevron', '.project-change-badge', '.project-change-copy']) {
    await act(async () => rows[0].querySelector(selector).dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })));
  }
  assert.equal(rows[0].open, true);
  await act(async () => rows[1].querySelector('.project-change-copy').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })));
  assert.equal(rows[1].open, true);
  assert.equal(rows[0].open, true);
  await act(async () => root.unmount());
});

test('review acceptance uses real client callback, blocks repeated clicks and refreshes confirmed state', async () => {
  const root = createRoot(document.getElementById('root'));
  let status = 'pending', calls = 0, release;
  const client = {
    async getChangeSet(id) { return { id, sealed: true, files: [{ id: 'f', path: '/a.ts', status }] }; },
    async applyFile(id, fileId) {
      assert.equal(fileId, 'f'); calls++;
      await new Promise(resolve => { release = resolve; });
      status = 'applied';
      return { success: true, results: [{ fileId, path: '/a.ts', success: true }] };
    },
    async applyChangeSet() { throw new Error('unexpected batch'); },
    async undoFile() {}, async undoChangeSet() {},
  };
  await act(async () => root.render(React.createElement(ProjectChanges, {
    changes: [{ path: '/a.ts' }], title: '变更', label: '变更', changeSetId: 'cs', changeClient: client,
  })));
  const button = document.querySelector('.project-change-action');
  assert.equal(button.textContent, '落笔');
  await act(async () => button.click());
  await act(async () => button.click());
  assert.equal(calls, 1);
  assert.equal(document.querySelector('.project-change').open, false);
  assert.match(document.querySelector('.project-change-status').textContent, /正落笔/);
  await act(async () => release());
  assert.match(document.querySelector('.project-change-status').textContent, /已落笔/);
  assert.equal(document.querySelector('.project-change-action').textContent, '复原');
  await act(async () => root.unmount());
});

test('batch acceptance reports partial failures and uses confirmed per-file statuses only', async () => {
  const root = createRoot(document.getElementById('root'));
  const notices = [];
  let completed = false;
  const client = {
    async getChangeSet(id) { return { id, sealed: true, files: [
      { id: 'a', path: '/a.ts', status: completed ? 'applied' : 'pending' },
      { id: 'b', path: '/b.ts', status: completed ? 'failed' : 'pending' },
    ] }; },
    async applyFile() { throw new Error('unexpected single'); },
    async applyChangeSet() { completed = true; return { success: false, results: [
      { fileId: 'a', path: '/a.ts', success: true }, { fileId: 'b', path: '/b.ts', success: false, code: 'FILE_SAVE_FAILED' },
    ] }; },
    async undoFile() {}, async undoChangeSet() {},
  };
  await act(async () => root.render(React.createElement(ProjectChanges, {
    changes: [{ path: '/a.ts' }, { path: '/b.ts' }], title: '变更', label: '变更', changeSetId: 'cs', changeClient: client,
    onNotify: (...args) => notices.push(args),
  })));
  assert.match(document.querySelector('.project-changes-accept').textContent, /一并落笔 \(2\)/);
  await act(async () => document.querySelector('.project-changes-accept').click());
  assert.deepEqual([...document.querySelectorAll('.project-change-status')].map(x => x.textContent), ['已落笔', '未落成']);
  assert.equal(document.querySelector('.project-changes-accept').disabled, true);
  assert.deepEqual(notices.at(-1), ['/b.ts（保存失败）', 'error']);
  await act(async () => root.unmount());
});
