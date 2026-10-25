const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  APP_ORIGIN, contentTypeFor, createApiForwarder, isApiPath, isAppUrl, isInAppUrl, resolveApiBase, resolveDevServerUrl, resolveStaticFile,
} = require('../out/protocol.js');

test('dev mode only accepts a local Web dev server and treats its pages as in-app', () => {
  assert.equal(resolveDevServerUrl('http://localhost:5173/'), 'http://localhost:5173');
  assert.equal(resolveDevServerUrl(' http://127.0.0.1:5173/#/chat '), 'http://127.0.0.1:5173');
  assert.equal(resolveDevServerUrl('http://[::1]:5173'), 'http://[::1]:5173');
  for (const value of [undefined, '', 'https://gor.example.com', 'http://192.168.1.5:5173', 'file:///C:/x', 'http://user:pw@localhost:5173', 'nope']) {
    assert.equal(resolveDevServerUrl(value), null, String(value));
  }
  const dev = 'http://localhost:5173';
  assert.equal(isInAppUrl('http://localhost:5173/#/chat?sessionId=s1', dev), true, '开发模式下重载开发服务器页面不能被当作外链拦截');
  assert.equal(isInAppUrl('app://gor/#/chat', dev), true);
  assert.equal(isInAppUrl('http://localhost:5174/', dev), false);
  assert.equal(isInAppUrl('https://example.com/', dev), false);
  assert.equal(isInAppUrl('http://localhost:5173/', null), false, '正式模式不认开发服务器');
});

test('in-app URLs are recognised in the Node main process (where app: has origin "null")', () => {
  assert.equal(new URL('app://gor/#/chat').origin, 'null', '前提：Node 下自定义协议的 origin 是 "null"');
  for (const url of ['app://gor/', 'app://gor/#/chat', 'app://gor/#/chat?sessionId=s1', 'APP://GOR/index.html', 'app://gor/preview-runtime.html?runtime=r1']) {
    assert.equal(isAppUrl(url), true, url);
  }
  for (const url of ['app://evil/', 'app://gor.evil.com/', 'app://user:pw@gor/', 'https://gor/', 'http://localhost:5173/', 'file:///C:/x.html', 'not a url']) {
    assert.equal(isAppUrl(url), false, url);
  }
});
const { createTokenStore } = require('../out/tokenStore.js');

const TOKEN = 'abcDEF123_-abcDEF123_-abcDEF123_-abcDEF12';

function memoryTokens(initial = null) {
  const calls = [];
  let token = initial;
  return {
    calls,
    get: () => token,
    set: (next, persist) => { token = next; calls.push(['set', next, persist]); },
    clear: () => { token = null; calls.push(['clear']); },
  };
}

function backend(handler) {
  const calls = [];
  const fetchImpl = async (input, init) => {
    calls.push({ url: input, init, headers: new Headers(init.headers) });
    return handler(input, init);
  };
  return { calls, fetchImpl };
}

const appRequest = (pathname, init) => new Request(`${APP_ORIGIN}${pathname}`, init);

test('static files resolve inside the Web build only', () => {
  const root = path.resolve('/srv/web');
  assert.equal(resolveStaticFile(root, '/'), path.join(root, 'index.html'), '根路径是 index.html（hash 路由）');
  assert.equal(resolveStaticFile(root, '/assets/app.js'), path.join(root, 'assets', 'app.js'));
  assert.equal(resolveStaticFile(root, '/images/gor%20avatar.png'), path.join(root, 'images', 'gor avatar.png'));
  for (const escape of ['/../secret.txt', '/%2e%2e/secret.txt', '/assets/..%2f..%2fsecret', '/a\\..\\..\\b', '/x%00.js', '/%E0%A4%A']) {
    assert.equal(resolveStaticFile(root, escape), null, escape);
  }
  assert.equal(contentTypeFor('esbuild.wasm'), 'application/wasm', 'esbuild-wasm 需要 application/wasm');
  assert.match(contentTypeFor('index.HTML'), /^text\/html/);
  assert.match(contentTypeFor('app.js'), /^text\/javascript/);
  assert.equal(isApiPath('/api/chat'), true);
  assert.equal(isApiPath('/apix'), false);
});

test('API requests are forwarded with the desktop client header and bearer token, never page cookies', async () => {
  const tokens = memoryTokens(TOKEN);
  const { calls, fetchImpl } = backend(() => Response.json({ success: true, sessions: [] }));
  const forward = createApiForwarder({ apiBase: 'http://127.0.0.1:3001/ignored/path', tokens, fetchImpl });
  const response = await forward(appRequest('/api/chat/sessions?userId=default', {
    headers: { Cookie: 'gor_auth=page', Origin: APP_ORIGIN, Authorization: 'Bearer forged', 'X-Gor-Client': 'vscode', Accept: 'application/json' },
  }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { success: true, sessions: [] });
  assert.equal(calls[0].url, 'http://127.0.0.1:3001/api/chat/sessions?userId=default', '保留查询参数，后端地址只取源');
  assert.equal(calls[0].headers.get('authorization'), `Bearer ${TOKEN}`, '只用主进程保存的凭证');
  assert.equal(calls[0].headers.get('x-gor-client'), 'desktop');
  assert.equal(calls[0].headers.get('cookie'), null);
  assert.equal(calls[0].headers.get('origin'), null);
  assert.equal(calls[0].headers.get('accept'), 'application/json');
});

test('login keeps the token in the main process, honours 记住我, and strips it from the page response', async () => {
  for (const [remember, persist] of [[true, true], [false, false], [undefined, false]]) {
    const tokens = memoryTokens();
    const { calls, fetchImpl } = backend(() => Response.json({ success: true, user: { id: 'acc-1' }, token: TOKEN }));
    const forward = createApiForwarder({ apiBase: 'http://127.0.0.1:3001', tokens, fetchImpl });
    const body = JSON.stringify({ email: 'a@example.com', password: 'abc12345', ...(remember === undefined ? {} : { remember }) });
    const response = await forward(appRequest('/api/auth/login', { method: 'POST', body, headers: { 'Content-Type': 'application/json' } }));
    assert.deepEqual(await response.json(), { success: true, user: { id: 'acc-1' } }, '页面拿不到凭证');
    assert.deepEqual(tokens.calls, [['set', TOKEN, persist]]);
    assert.equal(new TextDecoder().decode(calls[0].init.body), body, '请求体原样转发');
  }
  const tokens = memoryTokens();
  const { fetchImpl } = backend(() => Response.json({ success: true, user: { id: 'acc-1' }, token: TOKEN }));
  await createApiForwarder({ apiBase: 'http://127.0.0.1:3001', tokens, fetchImpl })(appRequest('/api/auth/register', { method: 'POST', body: '{}' }));
  assert.deepEqual(tokens.calls, [['set', TOKEN, true]], '注册即登录，与后端一致按记住处理');
});

test('failed login leaves the token untouched and passes the error through', async () => {
  const tokens = memoryTokens(TOKEN);
  const { fetchImpl } = backend(() => Response.json({ detail: '邮箱或密码不正确' }, { status: 401 }));
  const response = await createApiForwarder({ apiBase: 'http://127.0.0.1:3001', tokens, fetchImpl })(
    appRequest('/api/auth/login', { method: 'POST', body: '{"remember":true}' }));
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { detail: '邮箱或密码不正确' });
  assert.deepEqual(tokens.calls, []);
});

test('logout clears the local token; /me reporting no user clears a stale token', async () => {
  const tokens = memoryTokens(TOKEN);
  const { fetchImpl } = backend((url) => Response.json(url.endsWith('/me') ? { success: true, user: null } : { success: true }));
  const forward = createApiForwarder({ apiBase: 'http://127.0.0.1:3001', tokens, fetchImpl });
  await forward(appRequest('/api/auth/logout', { method: 'POST' }));
  assert.deepEqual(tokens.calls, [['clear']]);

  const stale = memoryTokens(TOKEN);
  const staleForward = createApiForwarder({ apiBase: 'http://127.0.0.1:3001', tokens: stale, fetchImpl });
  const me = await staleForward(appRequest('/api/auth/me'));
  assert.deepEqual(await me.json(), { success: true, user: null });
  assert.deepEqual(stale.calls, [['clear']]);
});

test('streaming responses pass through unbuffered and decoded-encoding headers are dropped', async () => {
  const encoder = new TextEncoder();
  let pushSecond;
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('data: {"type":"token"}\n\n'));
      pushSecond = () => { controller.enqueue(encoder.encode('data: {"type":"done"}\n\n')); controller.close(); };
    },
  });
  const { fetchImpl } = backend(() => new Response(stream, {
    headers: { 'Content-Type': 'text/event-stream', 'Content-Encoding': 'gzip', 'Set-Cookie': 'x=1', 'X-Request-Id': 'r1' },
  }));
  const response = await createApiForwarder({ apiBase: 'http://127.0.0.1:3001', tokens: memoryTokens(), fetchImpl })(
    appRequest('/api/chat', { method: 'POST', body: '{"sessionId":"s1"}' }));
  assert.equal(response.headers.get('content-type'), 'text/event-stream');
  assert.equal(response.headers.get('content-encoding'), null);
  assert.equal(response.headers.get('set-cookie'), null);
  assert.equal(response.headers.get('x-request-id'), 'r1');
  const reader = response.body.getReader();
  const first = await reader.read();
  assert.match(new TextDecoder().decode(first.value), /token/, '第一段在流结束前就能读到');
  pushSecond();
  const rest = await reader.read();
  assert.match(new TextDecoder().decode(rest.value), /done/);
});

test('an unreachable backend returns a readable 502; 204 responses carry no body', async () => {
  const down = createApiForwarder({ apiBase: 'http://127.0.0.1:3001', tokens: memoryTokens(), fetchImpl: async () => { throw new Error('ECONNREFUSED'); } });
  const failed = await down(appRequest('/api/auth/me'));
  assert.equal(failed.status, 502);
  assert.equal((await failed.json()).detail, '无法连接 Gor 服务，请确认后端已启动');

  const { fetchImpl } = backend(() => new Response(null, { status: 204 }));
  const empty = await createApiForwarder({ apiBase: 'http://127.0.0.1:3001', tokens: memoryTokens(), fetchImpl })(appRequest('/api/chat/session/s1', { method: 'DELETE' }));
  assert.equal(empty.status, 204);
});

test('API base comes from env, then config, then the local default; only plain http(s) origins', () => {
  assert.equal(resolveApiBase('https://gor.example.com/app', 'http://other:1'), 'https://gor.example.com');
  assert.equal(resolveApiBase(undefined, 'http://10.0.0.5:3001'), 'http://10.0.0.5:3001');
  assert.equal(resolveApiBase('ftp://x', 'javascript:alert(1)'), 'http://localhost:3001');
  assert.equal(resolveApiBase('http://user:pass@host', undefined), 'http://localhost:3001', '不接受带账号密码的地址');
});

test('token store encrypts on disk, keeps 不记住 in memory only, and never writes plaintext', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gor-desktop-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'auth-token.bin');
  const cipher = { available: () => true, encrypt: (text) => Buffer.from(`enc:${text}`), decrypt: (data) => data.toString().replace(/^enc:/, '') };

  const store = createTokenStore(file, cipher);
  await store.set(TOKEN, true);
  assert.equal(fs.readFileSync(file, 'utf8'), `enc:${TOKEN}`);
  const reloaded = createTokenStore(file, cipher);
  await reloaded.load();
  assert.equal(reloaded.get(), TOKEN, '重启后仍保持登录');

  await store.set(TOKEN, false);
  assert.equal(fs.existsSync(file), false, '不记住时不落盘');
  assert.equal(store.get(), TOKEN);
  await store.clear();
  assert.equal(store.get(), null);

  const noCrypto = createTokenStore(file, { ...cipher, available: () => false });
  await noCrypto.set(TOKEN, true);
  assert.equal(fs.existsSync(file), false, '系统加密不可用时只放内存');
  assert.equal(noCrypto.get(), TOKEN);
});
