import assert from 'node:assert/strict';
import test from 'node:test';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Module, { createRequire } from 'node:module';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

const dom = new JSDOM('<!doctype html><body><div id="root"></div></body>', { url: 'http://localhost/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.Node = dom.window.Node;
globalThis.HTMLElement = dom.window.HTMLElement;

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const filename = fileURLToPath(new URL('./toolchain-run.fixture.cjs', import.meta.url));
async function load(entry) {
  const compiled = await build({
    entryPoints: [fileURLToPath(new URL(entry, import.meta.url))],
    bundle: true, platform: 'node', format: 'cjs', write: false, packages: 'external',
    define: { 'import.meta.env': '{"BASE_URL":"/","DEV":false}' },
    plugins: [{ name: 'styles', setup(builder) {
      builder.onResolve({ filter: /\.(less|css)$/ }, args => ({ path: args.path, namespace: 'styles' }));
      builder.onLoad({ filter: /.*/, namespace: 'styles' }, () => ({ contents: '', loader: 'js' }));
    } }],
  });
  const fixture = new Module(filename);
  fixture.filename = filename;
  fixture.paths = Module._nodeModulePaths(dirname(filename));
  fixture.require = createRequire(filename);
  fixture._compile(compiled.outputFiles[0].text, filename);
  return fixture.exports;
}

const Card = (await load('../src/components/chat/ToolchainRunCard.tsx')).default;
const store = await load('../src/vscode/toolchainRuns.ts');
const { toolchainStatusLabel } = await load('../src/components/chat/toolchainRun.ts');

async function render(element) {
  const root = createRoot(document.getElementById('root'));
  await act(async () => root.render(element));
  return root;
}

const pendingRun = {
  runId: 'r1', approvalId: 'a1', pending: true, status: 'awaiting_approval', command: 'npm run test',
  cwd: '/vscode-extension', scripts: [{ name: 'pretest', body: 'node pre.js' }, { name: 'test', body: 'node --test tests/*.test.cjs' }],
  scriptSource: 'vscode-extension/package.json › scripts.test', effects: ['将执行项目中的代码'], deadline: Date.now() + 9 * 60_000,
};

test('approval card shows the real command and script, focuses 搁置, and routes every decision', async () => {
  const calls = [];
  const root = await render(React.createElement(Card, {
    run: pendingRun,
    onShown: () => calls.push('shown'), onApprove: () => calls.push('approve'),
    onSkip: () => calls.push('skip'), onStopRound: () => calls.push('stop'),
  }));
  const card = document.querySelector('.toolchain-approval-card');
  assert.equal(card.querySelector('.toolchain-approval-title').textContent, '此令待你过目');
  assert.equal(card.querySelector('.toolchain-status-tag').textContent, '待施行');
  assert.equal(card.querySelector('.toolchain-approval-command code').textContent, 'npm run test');
  assert.match(card.textContent, /令文原貌/);
  assert.match(card.textContent, /node --test tests\/\*\.test\.cjs/);
  assert.match(card.textContent, /将执行项目中的代码/);
  assert.match(card.textContent, /后未允准，自动搁置/);
  assert.equal(document.activeElement.textContent, '搁置');
  const buttons = [...card.querySelectorAll('button')];
  await act(async () => buttons.find(b => b.textContent === '施行').click());
  await act(async () => buttons.find(b => b.textContent === '搁置').click());
  await act(async () => buttons.find(b => b.textContent === '就此收笔').click());
  await act(async () => card.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  assert.deepEqual(calls, ['shown', 'approve', 'skip', 'stop', 'skip']);
  await act(async () => root.unmount());
});

test('answering disables both decisions so a command cannot be approved twice', async () => {
  const root = await render(React.createElement(Card, { run: { ...pendingRun, answering: true } }));
  for (const button of document.querySelectorAll('.toolchain-approval-actions button')) assert.equal(button.disabled, true);
  await act(async () => root.unmount());
});

test('status rows use the 施行 words, show summary/location and offer 止令 only while running', async () => {
  const expected = {
    running: '正施行', completed: '已施行', user_cancelled: '未施行', approval_timeout: '逾时未施', timed_out: '逾时而止',
    cancelled: '中道而止', plan_changed: '内容有异', not_enabled: '此令未开', rejected: '不可施行', workspace_untrusted: '未得信任',
  };
  for (const [status, word] of Object.entries(expected)) assert.equal(toolchainStatusLabel({ status }).label, word);
  assert.equal(toolchainStatusLabel({ status: 'failed', diagnostics: { failed: 2 } }).label, '见疏漏');
  assert.equal(toolchainStatusLabel({ status: 'failed' }).label, '未施成');

  let aborted = 0;
  let root = await render(React.createElement(Card, { run: { runId: 'r', status: 'running', command: 'vitest run', startedAt: Date.now() }, onAbort: () => { aborted += 1; } }));
  const abort = document.querySelector('.toolchain-row-abort');
  assert.equal(abort.textContent, '止令');
  await act(async () => abort.click());
  assert.equal(aborted, 1);
  await act(async () => root.unmount());

  root = await render(React.createElement(Card, { run: {
    runId: 'f', status: 'failed', command: 'npm run test', summary: '48 项中失败 2 项',
    diagnostics: { failed: 2, items: [{ file: 'tests/git.test.cjs', line: 42 }] },
  } }));
  const row = document.querySelector('.toolchain-run-row');
  assert.ok(row.classList.contains('tone-fail'));
  assert.equal(row.querySelector('.toolchain-status-tag').textContent, '见疏漏');
  assert.match(row.textContent, /48 项中失败 2 项/);
  assert.equal(row.querySelector('.toolchain-row-location').textContent, 'tests/git.test.cjs:42');
  assert.equal(row.querySelector('button'), null);
  await act(async () => root.unmount());
});

test('store accepts validated extension messages and answers each approval once', async () => {
  const posted = [];
  store.resetToolchainRunsForTest((message) => { posted.push(message); return true; });
  store.acceptToolchainMessage({ type: 'gor.toolchain', kind: 'update', update: { runId: 'r1', status: 'awaiting_approval', sessionId: 's1', command: 'npm run test' } });
  store.acceptToolchainMessage({ type: 'gor.toolchain', kind: 'approval', request: { ...pendingRun, sessionId: 's1', runId: 'r1', approvalId: 'a1' } });
  store.acceptToolchainMessage({ type: 'gor.toolchain', kind: 'update', update: { runId: 'r1', status: 'bogus' } });
  store.acceptToolchainMessage({ type: 'other', kind: 'update', update: { runId: 'x', status: 'running' } });
  let runs = store.getToolchainRuns();
  assert.equal(runs.length, 1);
  assert.equal(runs[0].pending, true);
  assert.equal(runs[0].scripts.length, 2);

  let host;
  function Probe({ messages }) {
    host = store.useVscodeToolchainRuns('s1', messages, () => posted.push('stop-round'));
    return null;
  }
  const streaming = [{ id: 'u', role: 'user', content: 'x' }, { id: 'm1', role: 'assistant', content: '', isStreaming: true }];
  const root = await render(React.createElement(Probe, { messages: streaming }));
  assert.equal(store.getToolchainRuns()[0].messageId, 'm1');
  assert.equal(host.runsFor({ id: 'm1', role: 'assistant', isStreaming: true }).length, 1);
  assert.equal(host.runsFor({ id: 'other', role: 'assistant', isStreaming: false }).length, 0);

  const run = store.getToolchainRuns()[0];
  host.onShown(run);
  host.onApprove(run);
  host.onApprove(store.getToolchainRuns()[0]);
  assert.deepEqual(posted, [
    { type: 'gor.toolchainApprovalShown', approvalId: 'a1' },
    { type: 'gor.toolchainApprovalAnswer', approvalId: 'a1', answer: 'approve' },
  ]);

  store.acceptToolchainMessage({ type: 'gor.toolchain', kind: 'update', update: { runId: 'r1', status: 'completed', summary: '3 项全部通过' } });
  await act(async () => root.render(React.createElement(Probe, { messages: [streaming[0], { ...streaming[1], isStreaming: false }] })));
  runs = store.getToolchainRuns();
  assert.equal(runs[0].pending, false);
  assert.equal(runs[0].status, 'completed');
  // 流式结束后仍按 messageId 留在原消息，不会跑到新消息里
  assert.equal(host.runsFor({ id: 'm1', role: 'assistant', isStreaming: false }).length, 1);
  assert.equal(host.runsFor({ id: 'm2', role: 'assistant', isStreaming: true }).length, 0);

  // 其他会话的施行不会绑定到当前消息
  store.acceptToolchainMessage({ type: 'gor.toolchain', kind: 'approval', request: { runId: 'r2', approvalId: 'a2', sessionId: 'other', command: 'x' } });
  assert.equal(host.runsFor({ id: 'm9', role: 'assistant', isStreaming: true }).length, 0);

  host.onStopRound({ ...store.getToolchainRuns()[1], pending: true });
  assert.deepEqual(posted.slice(-2), [{ type: 'gor.toolchainApprovalAnswer', approvalId: 'a2', answer: 'stop' }, 'stop-round']);
  host.onAbort({ runId: 'r1' });
  assert.deepEqual(posted.at(-1), { type: 'gor.toolchainCancel', runId: 'r1' });
  await act(async () => root.unmount());
});

test('message bubble renders 施行 cards only when the host provides the capability', async () => {
  const { MessageBubble, ToolchainRunsContext, FeedbackProvider } = await load('./toolchain-bubble.entry.ts');
  const message = { id: 'm1', role: 'assistant', content: '', isStreaming: true };
  const bubble = React.createElement(FeedbackProvider, null, React.createElement(MessageBubble, { message }));
  let root = await render(bubble);
  assert.equal(document.querySelector('.toolchain-approval-card, .toolchain-run-row'), null);
  await act(async () => root.unmount());
  const hostValue = {
    runsFor: () => [pendingRun], onShown() {}, onApprove() {}, onSkip() {}, onStopRound() {}, onAbort() {},
  };
  root = await render(React.createElement(ToolchainRunsContext.Provider, { value: hostValue }, bubble));
  assert.ok(document.querySelector('.toolchain-approval-card'));
  await act(async () => root.unmount());
});

test('background dev server row shows its local URL, opens it and can be stopped', async () => {
  assert.equal(toolchainStatusLabel({ status: 'background' }).label, '常驻施行');
  assert.equal(toolchainStatusLabel({ status: 'stopped' }).label, '已收令');
  const calls = [];
  const root = await render(React.createElement(Card, {
    run: { runId: 'dev', status: 'background', command: 'npm run dev', url: 'http://localhost:5173/', summary: '已在后台运行' },
    onAbort: () => calls.push('abort'), onOpenUrl: () => calls.push('open'),
  }));
  const row = document.querySelector('.toolchain-run-row');
  assert.ok(row.classList.contains('tone-running'));
  assert.match(row.textContent, /后台运行中/);
  await act(async () => row.querySelector('.toolchain-row-url').click());
  await act(async () => row.querySelector('.toolchain-row-abort').click());
  assert.deepEqual(calls, ['open', 'abort']);
  await act(async () => root.unmount());
});

test('store keeps only local URLs and asks the extension to open them', async () => {
  const posted = [];
  store.resetToolchainRunsForTest((message) => { posted.push(message); return true; });
  store.acceptToolchainMessage({ type: 'gor.toolchain', kind: 'update', update: { runId: 'd1', status: 'background', sessionId: 's', url: 'http://localhost:5173/' } });
  store.acceptToolchainMessage({ type: 'gor.toolchain', kind: 'update', update: { runId: 'd2', status: 'background', sessionId: 's', url: 'https://evil.example.com/' } });
  const [local, remote] = store.getToolchainRuns();
  assert.equal(local.url, 'http://localhost:5173/');
  assert.equal(remote.url, undefined);
  let host;
  function Probe() { host = store.useVscodeToolchainRuns('s', [], () => undefined); return null; }
  const root = await render(React.createElement(Probe));
  host.onOpenUrl(local);
  host.onOpenUrl({ runId: 'x', status: 'background', url: 'https://evil.example.com/' });
  assert.deepEqual(posted, [{ type: 'gor.toolchainOpenUrl', url: 'http://localhost:5173/' }]);
  await act(async () => root.unmount());
});
