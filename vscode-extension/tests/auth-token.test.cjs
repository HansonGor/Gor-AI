const assert = require('node:assert/strict');
const { once } = require('node:events');
const http = require('node:http');
const Module = require('node:module');
const test = require('node:test');

// 插件与 Web 共用账号：凭证只存在 SecretStorage，Webview 索取时交回，扩展代发的请求也带上。
let httpBaseUrl = 'http://127.0.0.1:1';
const vscodeMock = {
  Uri: { joinPath: (base, ...parts) => ({ fsPath: require('node:path').join(base?.fsPath ?? '', ...parts) }) },
  window: { registerWebviewViewProvider: () => ({ dispose() {} }) },
  workspace: { getConfiguration: () => ({ get: (key, fallback) => (key === 'httpBaseUrl' ? httpBaseUrl : fallback) }) },
};
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') return vscodeMock;
  return originalLoad.call(this, request, parent, isMain);
};
const { ChatView, isPlausibleAuthToken } = require('../out/chatPanel.js');
Module._load = originalLoad;

const TOKEN = 'abcDEF123_-abcDEF123_-abcDEF123_-abcDEF12';

function memorySecrets(initial) {
  const values = new Map(initial ? [['gor.authToken', initial]] : []);
  return {
    values,
    get: async (key) => values.get(key),
    store: async (key, value) => { values.set(key, value); },
    delete: async (key) => { values.delete(key); },
  };
}

function viewWith(secrets) {
  const view = ChatView.register({}, { appendLine() {} }, () => undefined, async () => undefined, secrets);
  const posted = [];
  view.webview = { postMessage: async (message) => { posted.push(message); } };
  return { view, posted };
}

test('only token_urlsafe-shaped values are accepted', () => {
  assert.equal(isPlausibleAuthToken(TOKEN), true);
  for (const bad of ['', 'short', 'has space in it but long enough', 'a'.repeat(129), 42, null]) {
    assert.equal(isPlausibleAuthToken(bad), false);
  }
});

test('saving, reading back and clearing the token goes through SecretStorage', async (t) => {
  const secrets = memorySecrets();
  const { view, posted } = viewWith(secrets);
  t.after(() => view.dispose());

  await view.handleMessage({ type: 'gor.saveAuthToken', token: TOKEN });
  assert.equal(secrets.values.get('gor.authToken'), TOKEN);
  assert.deepEqual(posted.at(-1), { type: 'gor.authTokenSaved' });

  await view.handleMessage({ type: 'gor.authTokenRequest' });
  assert.deepEqual(posted.at(-1), { type: 'gor.authToken', token: TOKEN });

  await view.handleMessage({ type: 'gor.clearAuthToken' });
  assert.equal(secrets.values.has('gor.authToken'), false);
  await view.handleMessage({ type: 'gor.authTokenRequest' });
  assert.deepEqual(posted.at(-1), { type: 'gor.authToken', token: null });
});

test('a malformed token is never stored and clears the sign-in state instead', async (t) => {
  const secrets = memorySecrets(TOKEN);
  const { view, posted } = viewWith(secrets);
  t.after(() => view.dispose());
  await view.handleMessage({ type: 'gor.saveAuthToken', token: 'not a token' });
  assert.equal(secrets.values.has('gor.authToken'), false);
  assert.deepEqual(posted.at(-1), { type: 'gor.authTokenSaved' });
});

test('requests relayed by the extension carry the stored bearer token', async (t) => {
  const headers = [];
  const server = http.createServer((request, response) => {
    headers.push(request.headers);
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end('{"success":true,"sessions":[]}');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  httpBaseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(() => server.close());

  const { view, posted } = viewWith(memorySecrets(TOKEN));
  t.after(() => view.dispose());
  await view.handleMessage({ type: 'gor.authTokenRequest' });
  await view.handleMessage({ type: 'loadSessions', requestId: 'r1' });
  const deadline = Date.now() + 3000;
  while (!posted.some((message) => message.requestId === 'r1') && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(headers[0].authorization, `Bearer ${TOKEN}`);
  assert.equal(headers[0]['x-gor-client'], 'vscode');
});

test('a sign-in change makes the extension set fresh Webview content instead of the page reloading itself', async (t) => {
  const { view } = viewWith(memorySecrets());
  t.after(() => view.dispose());
  const webview = {
    options: {}, html: '', cspSource: 'vscode-csp',
    asWebviewUri: () => ({ toString: () => 'vscode-resource://media/chat' }),
    onDidReceiveMessage() {}, postMessage: async () => {},
  };
  view.resolveWebviewView({ webview, visible: true, onDidDispose() {} });
  const settle = async (predicate) => {
    const deadline = Date.now() + 3000;
    while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  };
  await settle(() => webview.html.includes('Gor'));
  const first = webview.html;
  assert.ok(first, '面板首次加载聊天页');
  await view.handleMessage({ type: 'gor.reloadWebview' });
  await settle(() => webview.html !== first);
  const second = webview.html;
  assert.notEqual(second, first, '内容必须变化，VS Code 才会真正重新加载');
  assert.ok(second.startsWith(first.split('<!-- reload')[0].slice(0, 200)), '重新加载的是同一个聊天页');
  await new Promise((resolve) => setTimeout(resolve, 5));
  await view.handleMessage({ type: 'gor.reloadWebview' });
  await settle(() => webview.html !== second);
  assert.notEqual(webview.html, second, '连续切换身份也每次都重载');
});
