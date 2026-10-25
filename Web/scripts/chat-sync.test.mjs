import assert from 'node:assert/strict';
import test from 'node:test';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Module, { createRequire } from 'node:module';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';

const filename = fileURLToPath(new URL('./chat-sync.fixture.cjs', import.meta.url));
const compiled = await build({
  stdin: { contents: `
    export { applyRemoteRunEvent, remoteRunMessages, startRemoteRun } from '../src/utils/remoteRun';
    export { useChatSync } from '../src/hooks/useChatSync';
    export { sendChatMessage, cancelChatRun } from '../src/api/chat';
  `, resolveDir: dirname(filename), loader: 'ts' },
  bundle: true, platform: 'node', format: 'cjs', write: false, packages: 'external',
  define: { 'import.meta.env': JSON.stringify({ BASE_URL: '/', DEV: false, PROD: true, MODE: 'test' }) },
  plugins: [{ name: 'styles', setup(builder) {
    builder.onResolve({ filter: /\.less$/ }, args => ({ path: args.path, namespace: 'styles' }));
    builder.onLoad({ filter: /.*/, namespace: 'styles' }, () => ({ contents: '', loader: 'js' }));
  } }],
});

// DOM 要在加载 React 前就位
const dom = new JSDOM('<!doctype html><body><div id="root"></div></body>', { url: 'http://gor.test/#/chat' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
for (const key of ['navigator', 'Node', 'HTMLElement', 'Event', 'MutationObserver']) {
  Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true, writable: true });
}
const { default: React, act } = await import('react');
const { createRoot } = await import('react-dom/client');

const fixture = new Module(filename);
fixture.filename = filename;
fixture.paths = Module._nodeModulePaths(dirname(filename));
fixture.require = createRequire(filename);
fixture._compile(compiled.outputFiles[0].text, filename);
const { applyRemoteRunEvent, remoteRunMessages, startRemoteRun, useChatSync, sendChatMessage, cancelChatRun } = fixture.exports;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 可控的推送流：push 一条事件、end 结束连接 */
function controllableStream() {
  const encoder = new TextEncoder();
  let controller;
  const stream = new ReadableStream({ start(value) { controller = value; } });
  return {
    stream,
    push: (event) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`)),
    end: () => controller.close(),
  };
}

test('remote run reducer ignores duplicate sequence numbers and builds text and thinking', () => {
  let run = startRemoteRun({ runId: 'r1', sessionId: 's1', assistantMessageId: 'a1', userMessage: { content: '你好' } });
  run = applyRemoteRunEvent(run, 1, { type: 'token', content: '你' });
  run = applyRemoteRunEvent(run, 2, { type: 'token', content: '好' });
  const same = applyRemoteRunEvent(run, 2, { type: 'token', content: '重复' });
  assert.equal(same, run, '补齐与实时推送重叠的序号被忽略');
  run = applyRemoteRunEvent(run, 3, { type: 'thinking_start', roundId: 'round-1', title: '思考' });
  assert.equal(run.content, '你好');
  assert.equal(run.thinkingTrace.rounds.length, 1);

  const fresh = remoteRunMessages(run, [{ id: 'm0', role: 'assistant', content: '上一轮' }]);
  assert.deepEqual(fresh.map((message) => [message.role, message.content]), [['user', '你好'], ['assistant', '你好']]);
  assert.equal(fresh[1].isStreaming, true);
  const loaded = remoteRunMessages(run, [{ id: 'm1', role: 'user', content: '你好' }]);
  assert.deepEqual(loaded.map((message) => message.role), ['assistant'], '历史里已有这条提问时不重复显示');
});

test('sync hook shows other devices\' replies, skips its own, reloads before clearing, and refreshes sessions', async () => {
  const streams = [];
  globalThis.fetch = async (url) => {
    assert.match(String(url), /^\/api\/sync\/events\?userId=default$/);
    const stream = controllableStream();
    streams.push(stream);
    return new Response(stream.stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  };
  const calls = { sessions: 0, deleted: 0, finished: [], preview: [] };
  let state;
  let releaseReload;
  function Harness() {
    state = useChatSync('default', 's1', {
      onSessionsChanged: () => { calls.sessions += 1; },
      onCurrentSessionDeleted: () => { calls.deleted += 1; },
      onRemoteRunFinished: (sessionId) => { calls.finished.push(sessionId); return new Promise((resolve) => { releaseReload = resolve; }); },
      onPreviewChanged: (sessionId) => calls.preview.push(sessionId),
      isLocalAssistant: (id) => id === 'mine',
    });
    return null;
  }
  const root = createRoot(document.getElementById('root'));
  await act(async () => root.render(React.createElement(Harness)));
  await act(async () => sleep(10));
  const first = streams[0];

  await act(async () => {
    first.push({ type: 'hello', namespace: 'default' });
    first.push({ type: 'run_started', runId: 'own', sessionId: 's1', assistantMessageId: 'mine', userMessage: { content: '我发的' } });
    first.push({ type: 'run_event', runId: 'own', sessionId: 's1', seq: 1, event: { type: 'token', content: 'x' } });
    first.push({ type: 'run_started', runId: 'r2', sessionId: 's1', assistantMessageId: 'phone', userMessage: { content: '手机发的' } });
    first.push({ type: 'run_event', runId: 'r2', sessionId: 's1', seq: 1, event: { type: 'token', content: '回' } });
    first.push({ type: 'run_event', runId: 'r2', sessionId: 's1', seq: 2, event: { type: 'token', content: '复' } });
    await sleep(20);
  });
  assert.equal(state.currentRun?.runId, 'r2', '只显示其他设备的回复');
  assert.equal(state.currentRun.content, '回复');
  assert.equal(calls.sessions, 0, '首次连上不额外刷新');

  await act(async () => {
    first.push({ type: 'run_finished', runId: 'own', sessionId: 's1', status: 'completed' });
    first.push({ type: 'run_finished', runId: 'r2', sessionId: 's1', status: 'completed' });
    await sleep(20);
  });
  assert.deepEqual(calls.finished, ['s1'], '本端自己的回复结束不触发重新拉取');
  assert.equal(state.currentRun?.runId, 'r2', '重新拉取完成前保留临时显示，避免闪烁');
  await act(async () => { releaseReload(); await sleep(10); });
  assert.equal(state.currentRun, null);

  await act(async () => {
    first.push({ type: 'sessions_changed', sessionId: 's9', reason: 'created' });
    first.push({ type: 'sessions_changed', sessionId: 's9', reason: 'updated' });
    first.push({ type: 'preview_changed', sessionId: 's1', revision: 3 });
    first.push({ type: 'sessions_changed', sessionId: 's1', reason: 'deleted' });
    await sleep(400);
  });
  assert.equal(calls.sessions, 1, '短时间内多次变化合并为一次刷新');
  assert.equal(calls.deleted, 1);
  assert.deepEqual(calls.preview, ['s1']);

  // 连接断开（后端重启、手机回到前台）：自动重连，重连后整体刷新一次
  await act(async () => { first.end(); await sleep(1200); });
  assert.equal(streams.length, 2, '断开后自动重连');
  await act(async () => { streams[1].push({ type: 'hello', namespace: 'default' }); await sleep(400); });
  assert.equal(calls.sessions, 2);
  await act(async () => root.unmount());
});

test('send API hands over the run id, shows the server\'s 409 reason, and cancel posts to the run', async () => {
  const requests = [];
  globalThis.fetch = async (url, init = {}) => {
    requests.push({ url: String(url), init });
    if (String(url).includes('/cancel')) return new Response('{"success":true}', { status: 200 });
    return new Response(JSON.stringify({ detail: '另一台设备正在回复这个会话，请等它完成或先停止', runId: 'r1' }), { status: 409 });
  };
  await assert.rejects(
    sendChatMessage({ sessionId: 's1', message: 'hi' }, {}),
    (error) => error.status === 409 && /另一台设备正在回复/.test(error.message),
  );

  const encoder = new TextEncoder();
  globalThis.fetch = async () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('data: {"type":"run","runId":"run-123"}\n\ndata: {"type":"token","content":"ok"}\n\ndata: {"type":"done","status":"completed"}\n\n'));
      controller.close();
    },
  }), { status: 200 });
  const received = [];
  await sendChatMessage({ sessionId: 's1', message: 'hi' }, { onRun: (runId) => received.push(runId), onToken: (token) => received.push(token) });
  assert.deepEqual(received, ['run-123', 'ok']);

  globalThis.fetch = async (url, init = {}) => { requests.push({ url: String(url), init }); return new Response('{}', { status: 404 }); };
  await cancelChatRun('run-123');
  assert.equal(requests.at(-1).url, '/api/chat/runs/run-123/cancel');
  assert.equal(requests.at(-1).init.method, 'POST');
});

test('session ids are valid v4 UUIDs even without crypto.randomUUID (phone over LAN http)', async () => {
  const { build: esbuild } = await import('esbuild');
  const out = await esbuild({ entryPoints: [new URL('../src/utils/uuid.ts', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1')], bundle: true, format: 'esm', write: false, platform: 'neutral' });
  const { createUuid } = await import(`data:text/javascript,${encodeURIComponent(out.outputFiles[0].text)}`);
  const original = globalThis.crypto.randomUUID;
  Object.defineProperty(globalThis.crypto, 'randomUUID', { value: undefined, configurable: true });
  try {
    const ids = new Set(Array.from({ length: 200 }, () => createUuid()));
    assert.equal(ids.size, 200);
    for (const id of ids) assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  } finally {
    Object.defineProperty(globalThis.crypto, 'randomUUID', { value: original, configurable: true });
  }
});
