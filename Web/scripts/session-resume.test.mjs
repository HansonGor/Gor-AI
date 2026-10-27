import assert from 'node:assert/strict';
import test from 'node:test';
import Module, { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

const filename = fileURLToPath(new URL('./session-resume.fixture.cjs', import.meta.url));
const compiled = await build({
  entryPoints: [fileURLToPath(new URL('../src/hooks/useSession.ts', import.meta.url))],
  bundle: true, platform: 'node', format: 'cjs', write: false, packages: 'external',
  define: { 'import.meta.env': '{}' },
  plugins: [{ name: 'session-services', setup(builder) {
    builder.onResolve({ filter: /(?:api\/chat|utils\/clientMode|components\/ui\/feedback)$/ }, args => ({ path: args.path, namespace: 'services' }));
    builder.onLoad({ filter: /.*/, namespace: 'services' }, args => ({ loader: 'js', contents:
      args.path.endsWith('api/chat') ? 'export const getSessions=(...a)=>globalThis.services.list(...a); export const createSession=(...a)=>globalThis.services.create(...a); export const getSessionMessages=async()=>[]; export const deleteSession=async()=>{};' :
      args.path.endsWith('clientMode') ? 'export const getChatClientMode=()=>globalThis.services.mode;' :
      'export const useFeedback=()=>({notify:globalThis.services.notify});'
    }));
  } }],
});
const fixture = new Module(filename);
fixture.filename = filename;
fixture.paths = Module._nodeModulePaths(dirname(filename));
fixture.require = createRequire(filename);
fixture._compile(compiled.outputFiles[0].text, filename);
const { useSession } = fixture.exports;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

async function initialize({ mode = 'web', stored, query = '', fail = false, failTimes = 0, failStatus, empty = false, twice = false } = {}) {
  const dom = new JSDOM('<div id="root"></div>', { url: `http://localhost/#/chat${query}` });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.localStorage = dom.window.localStorage;
  const namespace = mode === 'web' ? 'default' : `default:${mode}`;
  if (stored) localStorage.setItem(`gor-last-session:${namespace}`, stored);
  localStorage.setItem(`gor-last-session:${mode === 'vscode' ? 'default' : 'default:vscode'}`, 'other-host');
  let creates = 0, lists = 0, userId, hook;
  const notices = [];
  globalThis.services = {
    mode, notify: (...args) => notices.push(args),
    list: async id => {
      userId = id; lists += 1;
      if (fail || lists <= failTimes) throw Object.assign(new Error('暂时无法连接 Gor 服务'), failStatus ? { status: failStatus } : {});
      return empty ? [] : [
      { id: 'older', updated_at: '2020-01-01' }, { id: 'latest', updated_at: '2020-02-01' },
    ]; },
    create: async () => { creates++; return { id: 'new' }; },
  };
  // HashRouter 把历史位置记在 history.state.idx；改写网址里的 sessionId 时必须保留，否则返回按钮会消失
  window.history.replaceState({ idx: 1, key: 'k' }, '', window.location.href);
  function Probe() { hook = useSession(); return null; }
  const root = createRoot(document.getElementById('root'));
  await act(async () => root.render(React.createElement(Probe)));
  // twice：模拟开发模式 StrictMode 把初始化 effect 连跑两次
  await act(async () => { await (twice ? Promise.all([hook.initSession(), hook.initSession()]) : hook.initSession()); });
  const result = { id: hook.sessionId, creates, lists, userId, notices, hash: window.location.hash, historyState: window.history.state };
  await act(async () => root.unmount());
  dom.window.close();
  return result;
}

for (const mode of ['web', 'vscode', 'desktop']) {
  test(`${mode}: resumes previous-day latest session without creating one`, async () => {
    const result = await initialize({ mode });
    assert.equal(result.id, 'latest');
    assert.equal(result.creates, 0);
    assert.equal(result.userId, mode === 'web' ? 'default' : `default:${mode}`);
  });
  test(`${mode}: recent selection survives reload; explicit valid link wins`, async () => {
    assert.equal((await initialize({ mode, stored: 'older' })).id, 'older');
    assert.equal((await initialize({ mode, stored: 'older', query: '?sessionId=latest' })).id, 'latest');
    assert.equal((await initialize({ mode, stored: 'deleted', query: '?sessionId=missing' })).id, 'latest');
  });
}
test('list failure does not silently create a chat; empty successful list does', async () => {
  const result = await initialize({ fail: true });
  assert.equal(result.id, null);
  assert.equal(result.creates, 0);
  assert.equal(result.notices.length, 1);
  assert.equal((await initialize({ empty: true })).creates, 1);
});

test('空列表时并发初始化（StrictMode 连跑两次）只新建一个会话', async () => {
  const result = await initialize({ mode: 'desktop', empty: true, twice: true });
  assert.equal(result.creates, 1);
  assert.equal(result.id, 'new');
});

test('写入 sessionId 时保留路由的历史位置（返回上一页依赖它）', async () => {
  const result = await initialize({ mode: 'web' });
  assert.match(result.hash, /sessionId=latest/);
  assert.deepEqual(result.historyState, { idx: 1, key: 'k' });
});

test('初始化遇到临时失败会自动重试，成功后不弹「初始化失败」', async () => {
  const result = await initialize({ failTimes: 1 });
  assert.equal(result.lists, 2);
  assert.equal(result.id, 'latest');
  assert.deepEqual(result.notices, []);
});

test('一直失败时只提示一次并写明原因；无权访问（4xx）不重试', async () => {
  const failed = await initialize({ fail: true });
  assert.equal(failed.lists, 3, '首次加两次重试');
  assert.equal(failed.notices.length, 1);
  assert.match(failed.notices[0][0], /初始化失败：暂时无法连接 Gor 服务/);
  const denied = await initialize({ fail: true, failStatus: 401 });
  assert.equal(denied.lists, 1);
  assert.equal(denied.notices.length, 1);
});
