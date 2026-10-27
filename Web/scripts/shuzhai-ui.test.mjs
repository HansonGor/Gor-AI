import assert from 'node:assert/strict';
import test from 'node:test';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Module, { createRequire } from 'node:module';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

const filename = fileURLToPath(new URL('./shuzhai.fixture.cjs', import.meta.url));
const compiled = await build({
  stdin: { contents: `
    export { default as ShuzhaiPanel } from '../src/components/desktop/ShuzhaiPanel';
    export { default as ShuzhaiWelcome } from '../src/components/desktop/ShuzhaiWelcome';
    export * as runtime from '../src/desktop/desktopRuntime';
    export * as clientMode from '../src/utils/clientMode';
    export { default as ShuzhaiModeChip } from '../src/components/desktop/ShuzhaiModeChip';
    export { getToolchainRuns, resetToolchainRunsForTest } from '../src/vscode/toolchainRuns';
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
const { ShuzhaiPanel, ShuzhaiWelcome, ShuzhaiModeChip, runtime, clientMode, getToolchainRuns, resetToolchainRunsForTest } = fixture.exports;

const dom = new JSDOM('<!doctype html><body><div id="root"></div><button id="outside">outside</button></body>', { url: 'http://gor.test/#/chat?sessionId=s1' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.Node = dom.window.Node;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
Object.defineProperty(globalThis, 'localStorage', { value: dom.window.localStorage, configurable: true, writable: true });

const folder = { path: 'D:\\Projects\\Gor', name: 'Gor' };
const recent = [{ ...folder, openedAt: Date.now() }, { path: 'D:\\Projects\\Notes', name: 'Notes', openedAt: Date.now() - 86_400_000 }];
const connected = { folder, recent, connection: 'connected', workspaceId: 'vscode-desk' };

async function mount(element) {
  const root = createRoot(document.getElementById('root'));
  await act(async () => root.render(element));
  return root;
}

function handlers() {
  const calls = [];
  return {
    calls,
    props: {
      onSwitchMode: (mode) => calls.push(['mode', mode]),
      onPickFolder: () => calls.push(['pick']),
      onOpenRecent: (path) => calls.push(['recent', path]),
      onReveal: () => calls.push(['reveal']),
      onCloseFolder: () => calls.push(['close']),
    },
  };
}

test('切换器显示云笺与书斋，云笺模式下没有书斋卡片', async () => {
  const { calls, props } = handlers();
  const root = await mount(React.createElement(ShuzhaiPanel, { mode: 'yunjian', state: connected, ...props }));
  const options = [...document.querySelectorAll('[role="radiogroup"][aria-label="工作模式"] [role="radio"]')];
  assert.deepEqual(options.map((item) => item.textContent), ['云笺', '书斋']);
  assert.equal(options[0].getAttribute('aria-checked'), 'true');
  assert.equal(document.querySelector('.shuzhai-card'), null);
  await act(async () => options[0].click());
  assert.deepEqual(calls, [], '点当前模式不切换');
  await act(async () => options[1].click());
  assert.deepEqual(calls, [['mode', 'shuzhai']]);
  root.unmount();
});

test('书斋卡片显示名称、路径与连接状态，弹出最近列表与操作', async () => {
  const { calls, props } = handlers();
  const root = await mount(React.createElement(ShuzhaiPanel, { mode: 'shuzhai', state: connected, ...props }));
  const card = document.querySelector('.shuzhai-card');
  assert.match(card.className, /is-connected/);
  assert.equal(card.getAttribute('aria-label'), '书斋：Gor，已连接');
  assert.match(card.textContent, /Gor.*D:\\Projects\\Gor.*已连接/);
  await act(async () => card.click());
  const dialog = document.querySelector('[role="dialog"][aria-label="选择书斋"]');
  assert.ok(dialog);
  const items = [...dialog.querySelectorAll('.shuzhai-recent')];
  assert.equal(items.length, 2);
  assert.equal(items[0].getAttribute('aria-current'), 'true');
  assert.match(items[0].textContent, /当前/);
  await act(async () => items[0].click());
  assert.deepEqual(calls, [], '点当前书斋不重开');
  await act(async () => card.click());
  await act(async () => document.querySelectorAll('.shuzhai-recent')[1].click());
  assert.deepEqual(calls, [['recent', 'D:\\Projects\\Notes']]);
  assert.equal(document.querySelector('.shuzhai-popover'), null, '选择后关闭弹层');
  for (const [label, expected] of [['打开文件夹…', 'pick'], ['在资源管理器中显示', 'reveal'], ['收起书斋', 'close']]) {
    await act(async () => card.click());
    const action = [...document.querySelectorAll('.shuzhai-action')].find((item) => item.textContent === label);
    await act(async () => action.click());
    assert.deepEqual(calls.at(-1), [expected]);
  }
  await act(async () => card.click());
  await act(async () => document.getElementById('outside').dispatchEvent(new dom.window.PointerEvent('pointerdown', { bubbles: true })));
  assert.equal(document.querySelector('.shuzhai-popover'), null, '点外面关闭');
  root.unmount();
});

test('断线显示「未连接 · 重连中」；未择书斋时卡片直接选文件夹', async () => {
  const { calls, props } = handlers();
  let root = await mount(React.createElement(ShuzhaiPanel, { mode: 'shuzhai', state: { ...connected, connection: 'disconnected' }, ...props }));
  assert.match(document.querySelector('.shuzhai-card').textContent, /未连接 · 重连中/);
  root.unmount();
  root = await mount(React.createElement(ShuzhaiPanel, { mode: 'shuzhai', state: { folder: null, recent, connection: 'idle', workspaceId: null }, ...props }));
  const empty = document.querySelector('.shuzhai-card.is-empty');
  assert.match(empty.textContent, /未择书斋/);
  await act(async () => empty.click());
  assert.deepEqual(calls, [['pick']]);
  root.unmount();
});

test('「择一书斋」空状态：打开文件夹、最近的书斋与失败原因', async () => {
  const calls = [];
  const root = await mount(React.createElement(ShuzhaiWelcome, {
    recent, error: '不能把整个磁盘设为书斋，请选择具体的项目文件夹。',
    onPickFolder: () => calls.push('pick'), onOpenRecent: (path) => calls.push(path),
  }));
  assert.equal(document.querySelector('h2').textContent, '择一书斋');
  assert.match(document.querySelector('[role="alert"]').textContent, /整个磁盘/);
  const recentButtons = [...document.querySelectorAll('.shuzhai-welcome-recent .shuzhai-recent')];
  assert.deepEqual(recentButtons.map((item) => item.querySelector('.shuzhai-recent-time').textContent), ['今天', '昨天']);
  await act(async () => document.querySelector('.shuzhai-welcome-primary').click());
  await act(async () => recentButtons[1].click());
  assert.deepEqual(calls, ['pick', 'D:\\Projects\\Notes']);
  root.unmount();
});

function fakeBridge(initial) {
  let listener;
  return {
    emit: (state) => listener?.(state),
    bridge: {
      getState: async () => initial,
      pickFolder: async () => ({ ok: true, state: initial }),
      openRecent: async () => ({ ok: true, state: initial }),
      close: async () => initial,
      reveal: async () => true,
      onState: (next) => { listener = next; return () => {}; },
    },
  };
}

test('浏览器中没有桥接：保持 web，不显示书斋', () => {
  runtime.resetDesktopRuntimeForTests();
  document.documentElement.dataset.gorClientMode = 'web';
  runtime.installDesktopRuntime({});
  assert.equal(runtime.isDesktopApp(), false);
  assert.equal(runtime.getDesktopMode(), null);
  assert.equal(clientMode.getChatClientMode(), 'web');
});

test('桌面端按上次选择进入书斋：clientMode 为 desktop，登记完成后才带工作区 ID', async () => {
  runtime.resetDesktopRuntimeForTests();
  document.documentElement.dataset.gorClientMode = 'web';
  delete document.documentElement.dataset.gorWorkspaceId;
  localStorage.setItem(runtime.DESKTOP_MODE_KEY, 'shuzhai');
  const fake = fakeBridge({ folder, recent, connection: 'connecting', workspaceId: null });
  runtime.installDesktopRuntime({ gorDesktop: { shuzhai: fake.bridge } });
  assert.equal(runtime.getDesktopMode(), 'shuzhai');
  assert.equal(clientMode.getChatClientMode(), 'desktop');
  assert.equal(clientMode.isWorkspaceClientMode(), true);
  assert.deepEqual(clientMode.projectClientContext('desktop', 'vscode-desk'), { clientMode: 'desktop', workspaceId: 'vscode-desk' });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(document.documentElement.dataset.gorWorkspaceId, undefined, '还在连接时不带工作区');

  const waiting = runtime.waitForShuzhaiWorkspace(1000);
  fake.emit(connected);
  assert.equal(await waiting, 'vscode-desk');
  assert.equal(document.documentElement.dataset.gorWorkspaceId, 'vscode-desk');

  fake.emit({ ...connected, connection: 'disconnected', workspaceId: null });
  assert.equal(document.documentElement.dataset.gorWorkspaceId, undefined, '断线后不再带旧的工作区 ID');
  fake.emit({ folder: null, recent, connection: 'idle', workspaceId: null });
  assert.equal(await runtime.waitForShuzhaiWorkspace(1000), undefined, '没有书斋时立即返回');
});

test('切换模式记住选择、回到新章并重载', () => {
  runtime.resetDesktopRuntimeForTests();
  document.documentElement.dataset.gorClientMode = 'web';
  localStorage.removeItem(runtime.DESKTOP_MODE_KEY);
  runtime.installDesktopRuntime({ gorDesktop: { shuzhai: fakeBridge(connected).bridge } });
  assert.equal(runtime.getDesktopMode(), 'yunjian');
  const replaced = [];
  let reloads = 0;
  const target = {
    location: { href: 'http://gor.test/#/chat?sessionId=s1', reload: () => { reloads += 1; } },
    history: { replaceState: (_state, _title, url) => replaced.push(url) },
  };
  runtime.switchDesktopMode('shuzhai', target);
  assert.equal(localStorage.getItem(runtime.DESKTOP_MODE_KEY), 'shuzhai');
  assert.deepEqual(replaced, ['http://gor.test/#/chat'], '不把云笺的会话带进书斋');
  assert.equal(reloads, 1);
  runtime.switchDesktopMode('shuzhai', target);
  assert.equal(reloads, 1, '已经是书斋时不重复重载');
  runtime.switchDesktopMode('yunjian', target);
  assert.equal(localStorage.getItem(runtime.DESKTOP_MODE_KEY), 'yunjian');
  assert.equal(clientMode.getChatClientMode(), 'web');
});


test('新建空白项目入口与拖入提示；弹层里也能新建', async () => {
  const calls = [];
  let root = await mount(React.createElement(ShuzhaiWelcome, {
    recent: [], onPickFolder: () => calls.push('pick'), onOpenRecent: () => {}, onCreateProject: () => calls.push('create'),
  }));
  const create = [...document.querySelectorAll('button')].find((item) => item.textContent === '新建空白项目');
  assert.ok(create);
  assert.match(document.querySelector('.shuzhai-welcome-hint').textContent, /拖进窗口/);
  await act(async () => create.click());
  assert.deepEqual(calls, ['create']);
  root.unmount();

  const { calls: panelCalls, props } = handlers();
  root = await mount(React.createElement(ShuzhaiPanel, { mode: 'shuzhai', state: connected, ...props, onCreateProject: () => panelCalls.push(['create']) }));
  await act(async () => document.querySelector('.shuzhai-card').click());
  const action = [...document.querySelectorAll('.shuzhai-action')].find((item) => item.textContent === '新建空白项目');
  await act(async () => action.click());
  assert.deepEqual(panelCalls, [['create']]);
  root.unmount();
});

test('书斋收起后已有消息的会话显示提示条：重开最近的书斋或打开文件夹', async () => {
  const calls = [];
  const root = await mount(React.createElement(ShuzhaiWelcome, {
    compact: true, recent, onPickFolder: () => calls.push('pick'), onOpenRecent: (item) => calls.push(item),
  }));
  const notice = document.querySelector('.shuzhai-notice');
  assert.match(notice.textContent, /书斋已收起/);
  const buttons = [...notice.querySelectorAll('button')];
  assert.deepEqual(buttons.map((item) => item.textContent), ['重开「Gor」', '打开文件夹…']);
  await act(async () => buttons[0].click());
  await act(async () => buttons[1].click());
  assert.deepEqual(calls, [folder.path, 'pick']);
  assert.equal(document.querySelector('.shuzhai-welcome'), null, '提示条不显示大空状态');
  root.unmount();
});

test('窄窗口模式图标：只显示图标，书斋名与状态在读屏标签里', async () => {
  let opened = 0;
  let root = await mount(React.createElement(ShuzhaiModeChip, { mode: 'shuzhai', state: connected, onOpen: () => { opened += 1; } }));
  const chip = document.querySelector('.shuzhai-mode-chip');
  assert.equal(chip.getAttribute('aria-label'), '当前模式：书斋 · Gor，打开侧栏切换');
  assert.match(chip.className, /is-connected/);
  await act(async () => chip.click());
  assert.equal(opened, 1);
  root.unmount();
  root = await mount(React.createElement(ShuzhaiModeChip, { mode: 'shuzhai', state: { folder: null, recent: [], connection: 'idle', workspaceId: null }, onOpen: () => {} }));
  assert.match(document.querySelector('.shuzhai-mode-chip').className, /is-empty/);
  assert.match(document.querySelector('.shuzhai-mode-chip').getAttribute('aria-label'), /未择书斋/);
  root.unmount();
});

test('书斋模式接上施行卡片通道：审阅消息进入卡片存储，回答经桥接回传；云笺不接', async () => {
  resetToolchainRunsForTest();
  runtime.resetDesktopRuntimeForTests();
  document.documentElement.dataset.gorClientMode = 'web';
  localStorage.setItem(runtime.DESKTOP_MODE_KEY, 'shuzhai');
  let listener;
  const sent = [];
  const fake = fakeBridge(connected);
  fake.bridge.toolchain = { send: async (message) => { sent.push(message); }, onMessage: (next) => { listener = next; return () => {}; } };
  runtime.installDesktopRuntime({ gorDesktop: { shuzhai: fake.bridge } });
  assert.equal(typeof listener, 'function');
  listener({ type: 'gor.toolchain', kind: 'approval', request: { runId: 'r1', approvalId: 'a1', sessionId: 's1', command: '删除文件 /a', kind: 'file', reason: 'destructive', deadline: Date.now() + 1000 } });
  const runs = getToolchainRuns();
  assert.equal(runs.length, 1);
  assert.equal(runs[0].pending, true);
  assert.equal(runs[0].reason, 'destructive');

  resetToolchainRunsForTest();
  runtime.resetDesktopRuntimeForTests();
  document.documentElement.dataset.gorClientMode = 'web';
  localStorage.setItem(runtime.DESKTOP_MODE_KEY, 'yunjian');
  let yunjianListener;
  const yunjian = fakeBridge(connected);
  yunjian.bridge.toolchain = { send: async () => {}, onMessage: (next) => { yunjianListener = next; return () => {}; } };
  runtime.installDesktopRuntime({ gorDesktop: { shuzhai: yunjian.bridge } });
  assert.equal(yunjianListener, undefined, '云笺不接收施行消息，主进程会退回系统确认框');
});
