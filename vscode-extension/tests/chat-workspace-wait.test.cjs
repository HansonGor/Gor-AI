const assert = require('node:assert/strict');
const { once } = require('node:events');
const http = require('node:http');
const Module = require('node:module');
const test = require('node:test');
const { WebSocketServer } = require('ws');

// 后端重启时插件会重新登记工作区：这几秒内发出的消息要等登记完成再带上工作区 ID，最多等 5 秒。
let httpBaseUrl = 'http://127.0.0.1:1';
const vscodeMock = {
  Uri: { joinPath: () => ({}) },
  extensions: { getExtension: () => undefined },
  window: { registerWebviewViewProvider: () => ({ dispose() {} }), showWarningMessage: async () => undefined },
  workspace: {
    workspaceFolders: [{ name: 'test-workspace', uri: { toString: () => 'file:///test-workspace' } }],
    getConfiguration: () => ({ get: (key, fallback) => (key === 'httpBaseUrl' ? httpBaseUrl : fallback) }),
    isTrusted: true,
    textDocuments: [],
  },
};
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') return vscodeMock;
  return originalLoad.call(this, request, parent, isMain);
};
const { ChatView } = require('../out/chatPanel.js');
const { GorConnection } = require('../out/connection.js');
Module._load = originalLoad;

const output = { appendLine() {} };

/** 记录 /api/chat 收到的请求体，立即以 done 结束流。 */
async function chatServer() {
  const bodies = [];
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      bodies.push({ at: Date.now(), body: JSON.parse(body) });
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.end('data: {"type":"done"}\n\n');
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  httpBaseUrl = `http://127.0.0.1:${server.address().port}`;
  return { server, bodies };
}

async function waitFor(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const send = (view, requestId) => view.handleMessage({ type: 'sendMessage', requestId, sessionId: 'session-1', message: '跑一下测试' });

test('a message sent while the workspace is re-registering waits and carries the workspace id', async (t) => {
  const { server, bodies } = await chatServer();
  t.after(() => server.close());
  let workspaceId;
  let release;
  const view = ChatView.register({}, output, () => workspaceId, () => new Promise((resolve) => { release = resolve; }));
  t.after(() => view.dispose());
  const sentAt = Date.now();
  await send(view, 'r1');
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(bodies.length, 0, '登记完成前不发出');
  workspaceId = 'vscode-abc';
  release('vscode-abc');
  await waitFor(() => bodies.length === 1);
  assert.equal(bodies[0].body.workspaceId, 'vscode-abc');
  assert.ok(bodies[0].at - sentAt >= 100);
});

test('a registered workspace is sent immediately; a timed-out wait still sends without an id', async (t) => {
  const { server, bodies } = await chatServer();
  t.after(() => server.close());
  const waits = [];
  let workspaceId = 'vscode-ready';
  const view = ChatView.register({}, output, () => workspaceId, async (timeoutMs) => { waits.push(timeoutMs); return undefined; });
  t.after(() => view.dispose());
  await send(view, 'r1');
  await waitFor(() => bodies.length === 1);
  assert.equal(bodies[0].body.workspaceId, 'vscode-ready');
  assert.deepEqual(waits, [], '已登记时不等待');
  workspaceId = undefined;
  await send(view, 'r2');
  await waitFor(() => bodies.length === 2);
  assert.equal('workspaceId' in bodies[1].body, false);
  assert.deepEqual(waits, [5000]);
});

test('cancelling while waiting for the workspace sends nothing', async (t) => {
  const { server, bodies } = await chatServer();
  t.after(() => server.close());
  let release;
  const view = ChatView.register({}, output, () => undefined, () => new Promise((resolve) => { release = resolve; }));
  t.after(() => view.dispose());
  await send(view, 'r1');
  await view.handleMessage({ type: 'cancelSend', requestId: 'r1' });
  release('vscode-late');
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(bodies.length, 0);
});

test('waitForWorkspace resolves on re-registration after a server restart, and times out otherwise', async (t) => {
  const wss = new WebSocketServer({ port: 0 });
  await once(wss, 'listening');
  let registrations = 0;
  let register = true;
  wss.on('connection', (socket) => socket.on('message', () => {
    if (!register) return;
    registrations += 1;
    socket.send(JSON.stringify({ type: 'workspace_registered', workspaceId: `vscode-${registrations}` }));
  }));
  const connection = new GorConnection(`ws://127.0.0.1:${wss.address().port}`, output, () => undefined);
  t.after(() => { connection.dispose(); wss.close(); });
  await connection.connect();
  assert.equal(await connection.waitForWorkspace(2000), 'vscode-1');
  assert.equal(await connection.waitForWorkspace(1), 'vscode-1', '已登记时立即返回');

  // 模拟后端重启：断开后插件约 1 秒后重连并重新登记
  for (const client of wss.clients) client.terminate();
  await waitFor(() => connection.workspaceId === undefined);
  const started = Date.now();
  assert.equal(await connection.waitForWorkspace(5000), 'vscode-2');
  assert.ok(Date.now() - started < 5000);

  // 服务端不再登记：等满时限返回 undefined
  register = false;
  for (const client of wss.clients) client.terminate();
  await waitFor(() => connection.workspaceId === undefined);
  assert.equal(await connection.waitForWorkspace(200), undefined);

  // 释放：dispose 时等待中的调用立即结束
  const pending = connection.waitForWorkspace(5000);
  connection.dispose();
  assert.equal(await pending, undefined);
});

test('waiting for the workspace reconnects at once instead of sitting out the back-off delay', async (t) => {
  const serve = (port) => {
    const wss = new WebSocketServer({ port });
    wss.on('connection', (socket) => socket.on('message', () => socket.send(JSON.stringify({ type: 'workspace_registered', workspaceId: 'vscode-back' }))));
    return wss;
  };
  let wss = serve(0);
  await once(wss, 'listening');
  const port = wss.address().port;
  const connection = new GorConnection(`ws://127.0.0.1:${port}`, output, () => undefined);
  t.after(() => { connection.dispose(); wss.close(); });
  await connection.connect();
  await waitFor(() => connection.workspaceId === 'vscode-back');
  // 后端停机约 3.5 秒：重连连续失败，退避间隔涨到 4 秒以上
  for (const client of wss.clients) client.terminate();
  await new Promise((resolve) => wss.close(resolve));
  await new Promise((resolve) => setTimeout(resolve, 3500));
  wss = serve(port);
  await once(wss, 'listening');
  const started = Date.now();
  assert.equal(await connection.waitForWorkspace(5000), 'vscode-back');
  assert.ok(Date.now() - started < 1000, `应立即重连，实际等了 ${Date.now() - started}ms`);
});
