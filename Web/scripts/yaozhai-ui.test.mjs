import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Module, { createRequire } from 'node:module';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

const filename = fileURLToPath(new URL('./yaozhai.fixture.cjs', import.meta.url));
const compiled = await build({
  stdin: { contents: `
    export { default as ShuzhaiPanel } from '../src/components/desktop/ShuzhaiPanel';
    export { default as YaozhaiPanel } from '../src/components/remote/YaozhaiPanel';
    export { default as YaozhaiWelcome } from '../src/components/remote/YaozhaiWelcome';
    export { default as YaozhaiModeChip } from '../src/components/remote/YaozhaiModeChip';
    export * as runtime from '../src/remote/remoteRuntime';
    export { readSyncEvents } from '../src/api/sync';
    export { getChatClientMode } from '../src/utils/clientMode';
    export { getToolchainRuns, resetToolchainRunsForTest, useVscodeToolchainRuns } from '../src/vscode/toolchainRuns';
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
const {
  ShuzhaiPanel, YaozhaiPanel, YaozhaiWelcome, YaozhaiModeChip, runtime, readSyncEvents, getChatClientMode,
  getToolchainRuns, resetToolchainRunsForTest, useVscodeToolchainRuns,
} = fixture.exports;

const dom = new JSDOM('<!doctype html><body><div id="root"></div></body>', { url: 'http://gor.test/#/chat' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.Node = dom.window.Node;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
Object.defineProperty(globalThis, 'localStorage', { value: dom.window.localStorage, configurable: true, writable: true });

const pc = { remoteId: 'remote-pc', deviceName: 'Gor-PC', name: 'my-app', path: 'D:\\work\\my-app', online: true, remoteAllowed: true };
const laptop = { remoteId: 'remote-laptop', deviceName: 'Laptop', name: 'blog', path: 'D:\\blog', online: true, remoteAllowed: false };
const office = { remoteId: 'remote-office', deviceName: 'Office-PC', name: 'api', path: 'D:\\api', online: false, remoteAllowed: true };

async function mount(element) {
  const root = createRoot(document.getElementById('root'));
  await act(async () => root.render(element));
  return root;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function fakeFetch(routes) {
  const calls = [];
  const impl = async (url, init = {}) => {
    calls.push({ url, method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : undefined });
    const handler = routes[`${init.method ?? 'GET'} ${url}`] ?? routes[url];
    const [status, body] = handler ? handler() : [404, { detail: 'not found' }];
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  };
  return { calls, impl };
}

function sseFetch(events) {
  return async () => new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), {
    status: 200, headers: { 'Content-Type': 'text/event-stream' },
  });
}

function resetDocument() {
  runtime.resetYaozhaiRuntimeForTests();
  resetToolchainRunsForTest();
  localStorage.clear();
  const root = document.documentElement;
  root.dataset.gorClientMode = 'web';
  delete root.dataset.gorDesktop;
  delete root.dataset.gorRemote;
}

test('书斋弹层：允许网页遥控的开关、正在遥控的设备与断开；不接开关时不显示这一节', async () => {
  const calls = [];
  const state = {
    folder: { path: 'D:\\work\\my-app', name: 'my-app' }, recent: [{ path: 'D:\\work\\my-app', name: 'my-app', openedAt: 1 }],
    connection: 'connected', workspaceId: 'desktop-1',
    remote: { allowed: true, available: true, clients: [{ id: 'phone', label: 'iPhone · Safari', lastActive: Date.now() - 120_000 }] },
  };
  const props = {
    mode: 'shuzhai', state, onSwitchMode() {}, onPickFolder() {}, onOpenRecent() {}, onReveal() {}, onCloseFolder() {},
    onToggleRemote: (value) => calls.push(['toggle', value]), onDisconnectRemote: (id) => calls.push(['kick', id]),
  };
  let root = await mount(React.createElement(ShuzhaiPanel, props));
  assert.match(document.querySelector('.shuzhai-card-status').textContent, /已连接 · 1 台设备在遥控/);
  await act(async () => document.querySelector('.shuzhai-card').click());
  const toggle = document.querySelector('[role="switch"]');
  assert.equal(toggle.getAttribute('aria-checked'), 'true');
  assert.match(document.querySelector('.shuzhai-remote').textContent, /允许网页遥控此书斋/);
  assert.match(document.querySelector('.shuzhai-remote-client').textContent, /iPhone · Safari.*2 分钟前活动/);
  await act(async () => document.querySelector('.shuzhai-remote-disconnect').click());
  await act(async () => toggle.click());
  assert.deepEqual(calls, [['kick', 'phone'], ['toggle', false]]);
  root.unmount();

  root = await mount(React.createElement(ShuzhaiPanel, { ...props, onToggleRemote: undefined, state: { ...state, remote: undefined } }));
  assert.match(document.querySelector('.shuzhai-card-status').textContent, /^已连接$/);
  await act(async () => document.querySelector('.shuzhai-card').click());
  assert.equal(document.querySelector('[role="switch"]'), null);
  root.unmount();
});

test('书斋未登录：开关打开后提示需要登录网页才能遥控', async () => {
  const state = { folder: { path: 'D:\\a', name: 'a' }, recent: [], connection: 'connected', workspaceId: 'd', remote: { allowed: true, available: false, clients: [] } };
  const root = await mount(React.createElement(ShuzhaiPanel, {
    mode: 'shuzhai', state, onSwitchMode() {}, onPickFolder() {}, onOpenRecent() {}, onReveal() {}, onCloseFolder() {}, onToggleRemote() {},
  }));
  await act(async () => document.querySelector('.shuzhai-card').click());
  assert.match(document.querySelector('.shuzhai-remote').textContent, /登录后，网页才能遥控此书斋/);
  root.unmount();
});

test('遥斋切换器与电脑列表：在线可选，未开远程与离线置灰；未登录不能切到遥斋', async () => {
  const calls = [];
  const props = {
    mode: 'yaozhai', workspaces: [pc, laptop, office], selected: pc, loaded: true, error: null, signedIn: true,
    onSwitchMode: (mode) => calls.push(['mode', mode]), onSelect: (id) => calls.push(['select', id]), onRefresh: () => calls.push(['refresh']),
  };
  let root = await mount(React.createElement(YaozhaiPanel, props));
  const options = [...document.querySelectorAll('[role="radio"]')];
  assert.deepEqual(options.map((item) => item.textContent), ['云笺', '遥斋']);
  const card = document.querySelector('.shuzhai-card');
  assert.match(card.textContent, /Gor-PC · my-app/);
  assert.match(card.textContent, /在线 · 远程已允许/);
  await act(async () => card.click());
  const items = [...document.querySelectorAll('.yaozhai-computer')];
  assert.deepEqual(items.map((item) => item.className.match(/is-(online|blocked|offline)/)[1]), ['online', 'blocked', 'offline']);
  assert.match(items[1].textContent, /未开远程/);
  assert.equal(items[1].disabled, true);
  assert.equal(items[2].disabled, true);
  await act(async () => options[0].click());
  assert.deepEqual(calls, [['mode', 'yunjian']]);
  root.unmount();

  root = await mount(React.createElement(YaozhaiPanel, { ...props, mode: 'yunjian', selected: null, signedIn: false }));
  assert.equal(document.querySelectorAll('[role="radio"]')[1].disabled, true, '未登录不能进入遥斋');
  assert.equal(document.querySelector('.shuzhai-card'), null);
  root.unmount();
});

test('遥控书斋空状态与窄屏图标：说明原因并列出可遥控的书斋', async () => {
  const picked = [];
  let root = await mount(React.createElement(YaozhaiWelcome, {
    workspaces: [pc, laptop], selected: laptop, loaded: true, error: null, signedIn: true, onSelect: (id) => picked.push(id), onRefresh() {},
  }));
  assert.match(document.querySelector('.shuzhai-welcome-desc').textContent, /Laptop 还没有允许网页遥控/);
  const choices = [...document.querySelectorAll('.shuzhai-welcome-recent .shuzhai-recent')];
  assert.equal(choices.length, 1);
  await act(async () => choices[0].click());
  assert.deepEqual(picked, ['remote-pc']);
  root.unmount();

  root = await mount(React.createElement(YaozhaiModeChip, { mode: 'yaozhai', selected: office, onOpen() {} }));
  const chip = document.querySelector('.shuzhai-mode-chip');
  assert.match(chip.className, /is-disconnected/);
  assert.match(chip.getAttribute('aria-label'), /遥斋 · Office-PC · api，离线/);
  root.unmount();
});

test('设备名称取自系统与浏览器', () => {
  assert.equal(runtime.deviceLabel('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit Version/18.0 Mobile Safari/604.1'), 'iPhone · Safari');
  assert.equal(runtime.deviceLabel('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0 Safari/537.36 Edg/130.0'), 'Windows · Edge');
  assert.equal(runtime.deviceLabel('Mozilla/5.0 (Linux; Android 15) Chrome/130.0 Mobile Safari/537.36'), 'Android · Chrome');
});

test('浏览器默认云笺：不安装遥斋；桌面应用中也不安装', () => {
  resetDocument();
  runtime.installYaozhaiRuntime({ fetchImpl: async () => { throw new Error('不应请求'); } });
  assert.equal(runtime.isYaozhaiActive(), false);
  assert.equal(getChatClientMode(), 'web');

  resetDocument();
  localStorage.setItem(runtime.WEB_MODE_KEY, 'yaozhai');
  document.documentElement.dataset.gorDesktop = 'true';
  runtime.installYaozhaiRuntime({ fetchImpl: async () => { throw new Error('不应请求'); } });
  assert.equal(runtime.isYaozhaiActive(), false, '桌面应用自己有书斋，不遥控');
});

test('遥斋：按书斋会话发送、自动选第一台可遥控的电脑、只带遥斋 ID 与设备标识', async () => {
  resetDocument();
  localStorage.setItem(runtime.WEB_MODE_KEY, 'yaozhai');
  const { calls, impl } = fakeFetch({
    '/api/remote/workspaces': () => [200, { success: true, workspaces: [laptop, pc, office] }],
    'POST /api/remote/workspaces/remote-pc/attach': () => [200, { success: true }],
  });
  runtime.installYaozhaiRuntime({ fetchImpl: impl });
  await tick(); await tick();
  assert.equal(getChatClientMode(), 'desktop', '会话、请求都按书斋处理');
  assert.equal(document.documentElement.dataset.gorRemote, 'true');
  assert.equal(document.documentElement.dataset.gorWorkspaceId, undefined, '浏览器不知道真实工作区 ID');
  assert.equal(localStorage.getItem(runtime.YAOZHAI_SELECTED_KEY), 'remote-pc', '跳过未开远程的电脑');
  const context = runtime.getRemoteRequestContext();
  assert.equal(context.remoteWorkspaceId, 'remote-pc');
  assert.match(context.remoteDeviceId, /^[\w-]{8,}$/);
  assert.equal(localStorage.getItem(runtime.YAOZHAI_DEVICE_KEY), context.remoteDeviceId, '设备标识记在本机');
  const attach = calls.find((call) => call.url.endsWith('/attach'));
  assert.equal(attach.body.deviceId, context.remoteDeviceId);
  assert.ok(attach.body.label, '带上设备名称，电脑上显示谁在遥控');
});

test('遥斋施行卡片：只收当前书斋的审阅，回答转给电脑；被断开时提示原因', async () => {
  resetDocument();
  localStorage.setItem(runtime.WEB_MODE_KEY, 'yaozhai');
  localStorage.setItem(runtime.YAOZHAI_SELECTED_KEY, 'remote-pc');
  let kicked = false;
  const { calls, impl } = fakeFetch({
    '/api/remote/workspaces': () => [200, { success: true, workspaces: [pc] }],
    'POST /api/remote/workspaces/remote-pc/attach': () => (kicked ? [403, { detail: 'Gor-PC 已断开这台设备的遥控。' }] : [200, { success: true }]),
    'POST /api/remote/workspaces/remote-pc/toolchain': () => [200, { success: true }],
  });
  runtime.installYaozhaiRuntime({ fetchImpl: impl });
  await tick(); await tick();
  const deviceId = runtime.getRemoteRequestContext().remoteDeviceId;
  const request = { runId: 'run-1', approvalId: 'ap-1', sessionId: 's1', kind: 'file', command: '删除 src/legacy', cwd: 'D:\\work\\my-app', reason: 'destructive', effects: [], deadline: Date.now() + 60_000 };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = sseFetch([
    { type: 'remote_toolchain', remoteId: 'remote-other', message: { type: 'gor.toolchain', kind: 'approval', request: { ...request, runId: 'run-x', approvalId: 'ap-x' } } },
    { type: 'remote_toolchain', remoteId: 'remote-pc', message: { type: 'gor.toolchain', kind: 'approval', request } },
  ]);
  try {
    await readSyncEvents('default:desktop', () => {}, new AbortController().signal);
  } finally {
    globalThis.fetch = originalFetch;
  }
  const runs = getToolchainRuns();
  assert.deepEqual(runs.map((run) => run.runId), ['run-1'], '别的书斋的审阅不显示');
  assert.equal(runs[0].reason, 'destructive');

  // 卡片的回答经接口转给电脑（与插件、书斋同一套消息）
  let host;
  const cards = await mount(React.createElement(() => { host = useVscodeToolchainRuns('s1', [], () => {}); return null; }));
  await act(async () => { host.onShown(runs[0]); host.onApprove(runs[0]); });
  await tick();
  const posted = calls.filter((call) => call.url.endsWith('/toolchain')).map((call) => call.body);
  assert.deepEqual(posted, [
    { deviceId, message: { type: 'gor.toolchainApprovalShown', approvalId: 'ap-1' } },
    { deviceId, message: { type: 'gor.toolchainApprovalAnswer', approvalId: 'ap-1', answer: 'approve' } },
  ]);
  cards.unmount();

  globalThis.fetch = sseFetch([
    { type: 'remote_revoked', remoteId: 'remote-pc', deviceId: 'someone-else', reason: 'kicked' },
  ]);
  try { await readSyncEvents('default:desktop', () => {}, new AbortController().signal); } finally { globalThis.fetch = originalFetch; }
  let seen;
  const probe = await mount(React.createElement(() => { seen = runtime.useYaozhaiState(); return null; }));
  assert.equal(seen.error, null, '断开的是别的设备，不提示');
  kicked = true;
  globalThis.fetch = sseFetch([{ type: 'remote_revoked', remoteId: 'remote-pc', deviceId, reason: 'kicked' }]);
  try { await act(async () => { await readSyncEvents('default:desktop', () => {}, new AbortController().signal); await tick(); await tick(); }); } finally { globalThis.fetch = originalFetch; }
  assert.match(seen.error, /Gor-PC 已断开这台设备的遥控/);
  assert.equal(seen.revoked, true, '被断开后挡住输入框');
  probe.unmount();
});

test('切换模式记住选择、回到新章并重载', () => {
  resetDocument();
  let reloaded = 0;
  const target = {
    location: { href: 'http://gor.test/#/chat?sessionId=s1', reload: () => { reloaded += 1; } },
    history: { replaceState: (_state, _title, url) => { target.location.href = url; } },
  };
  runtime.switchWebMode('yaozhai', target);
  assert.equal(localStorage.getItem(runtime.WEB_MODE_KEY), 'yaozhai');
  assert.equal(target.location.href, 'http://gor.test/#/chat');
  assert.equal(reloaded, 1);
  runtime.switchWebMode('yaozhai', target);
  assert.equal(reloaded, 1, '已是遥斋不重载');
});

test('后打开的设备：登记遥控时补上仍在等待的审阅卡片，已有的不重复', async () => {
  resetDocument();
  localStorage.setItem(runtime.WEB_MODE_KEY, 'yaozhai');
  localStorage.setItem(runtime.YAOZHAI_SELECTED_KEY, 'remote-pc');
  const request = { runId: 'run-late', approvalId: 'ap-late', sessionId: 's1', kind: 'command', command: 'npm run hello', cwd: '/', reason: 'review', effects: [], deadline: Date.now() + 60_000 };
  const { impl } = fakeFetch({
    '/api/remote/workspaces': () => [200, { success: true, workspaces: [pc] }],
    'POST /api/remote/workspaces/remote-pc/attach': () => [200, { success: true, pendingApprovals: [{ type: 'gor.toolchain', kind: 'approval', request }] }],
  });
  runtime.installYaozhaiRuntime({ fetchImpl: impl });
  for (let i = 0; i < 5; i += 1) await tick();
  const runs = getToolchainRuns();
  assert.deepEqual(runs.map((run) => [run.runId, run.pending, run.reason]), [['run-late', true, 'review']]);
  await runtime.refreshYaozhai();
  for (let i = 0; i < 5; i += 1) await tick();
  assert.equal(getToolchainRuns().length, 1, '心跳再次登记不重复添加');
});

after(() => runtime.resetYaozhaiRuntimeForTests());
