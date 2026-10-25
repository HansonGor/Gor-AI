import assert from 'node:assert/strict';
import test from 'node:test';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Module, { createRequire } from 'node:module';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';

const filename = fileURLToPath(new URL('./account-ui.fixture.cjs', import.meta.url));
const compiled = await build({
  stdin: { contents: `
    export { default as AccountMenu } from '../src/components/account/AccountMenu';
    export { default as AuthDialog, validateAuthForm } from '../src/components/account/AuthDialog';
    export { getAuthState, login, logout, register, loadCurrentUser } from '../src/user/auth';
    export { getUserNickname } from '../src/user/profile';
    export { installVscodeWebviewRuntime } from '../src/vscode/vscodeRuntime';
    export { default as AppAvatar } from '../src/components/AppAvatar';
    export { uploadAccountAvatar, migrateLegacyAvatar } from '../src/user/avatar';
    export { consumeOpenFirstSession, reloadForIdentityChange } from '../src/user/auth';
    export { default as AccountControl } from '../src/components/account/AccountControl';
    export { FeedbackProvider } from '../src/components/ui/feedback';
  `, resolveDir: dirname(filename), loader: 'ts' },
  bundle: true, platform: 'node', format: 'cjs', write: false, packages: 'external',
  // AppAvatar 经 config 读取 Vite 注入的环境变量，Node 下补上测试所需的值
  define: { 'import.meta.env': JSON.stringify({ BASE_URL: '/', DEV: false, PROD: true, MODE: 'test' }) },
  plugins: [{ name: 'styles', setup(builder) {
    builder.onResolve({ filter: /\.less$/ }, args => ({ path: args.path, namespace: 'styles' }));
    builder.onLoad({ filter: /.*/, namespace: 'styles' }, () => ({ contents: '', loader: 'js' }));
  } }],
});
// DOM 要在加载 React 与组件前就位：react-dom 与 Radix 都在模块加载时探测 DOM 能力
// （输入事件支持、layout effect），晚了表单 onChange 与弹窗 Portal 都不工作。
const dom = new JSDOM('<!doctype html><body><div id="root"></div><button id="outside">outside</button></body>', { url: 'http://gor.test/#/chat?sessionId=s1', pretendToBeVisual: true });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
for (const key of ['navigator', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'MutationObserver',
  'Node', 'HTMLElement', 'Event', 'CustomEvent', 'KeyboardEvent', 'FocusEvent', 'PointerEvent', 'MouseEvent', 'Image',
  'localStorage', 'sessionStorage', 'Element']) {
  Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true, writable: true });
}
const { default: React, act } = await import('react');
const { createRoot } = await import('react-dom/client');

const fixture = new Module(filename);
fixture.filename = filename;
fixture.paths = Module._nodeModulePaths(dirname(filename));
fixture.require = createRequire(filename);
fixture._compile(compiled.outputFiles[0].text, filename);
const { AccountMenu, AuthDialog, validateAuthForm, getAuthState, login, logout, register, loadCurrentUser, getUserNickname,
  installVscodeWebviewRuntime, AppAvatar, uploadAccountAvatar, migrateLegacyAvatar, consumeOpenFirstSession, reloadForIdentityChange, AccountControl, FeedbackProvider } = fixture.exports;

const USER = { id: 'acc-1', email: 'a@example.com', nickname: '樺' };

async function mount(element) {
  const root = createRoot(document.getElementById('root'));
  await act(async () => root.render(element));
  return root;
}

function mockFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const { status = 200, body = {} } = handler(String(url), init) ?? {};
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  };
  return calls;
}

test('signed-out menu offers 登录 and 注册; signed-in menu offers 个人资料 and 退出登录', async () => {
  const actions = [];
  const props = { onLogin: () => actions.push('login'), onRegister: () => actions.push('register'),
    onProfile: () => actions.push('profile'), onLogout: () => actions.push('logout'),
    avatar: React.createElement('span', { className: 'menu-avatar-slot' }) };
  const root = await mount(React.createElement(AccountMenu, { user: null, ...props }));
  const trigger = document.querySelector('.conversation-settings');
  assert.equal(trigger.getAttribute('aria-expanded'), 'false');
  await act(async () => trigger.click());
  const items = () => [...document.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent);
  assert.deepEqual(items(), ['登录', '注册']);
  assert.equal(document.querySelector('.account-menu-identity').textContent, '未登录', '未登录时不再显示说明文字');
  assert.ok(document.querySelector('.account-menu-identity .menu-avatar-slot'), '菜单头像由外部传入（与侧栏共用组件）');
  await act(async () => document.querySelectorAll('[role="menuitem"]')[1].click());
  assert.deepEqual(actions, ['register']);
  assert.equal(document.querySelector('[role="menu"]'), null, '选择后关闭菜单');

  await act(async () => root.render(React.createElement(AccountMenu, { user: USER, ...props })));
  await act(async () => trigger.click());
  assert.deepEqual(items(), ['个人资料', '退出登录']);
  assert.match(document.querySelector('.account-menu-identity').textContent, /樺.*a@example\.com/);
  assert.ok(document.querySelector('.account-menu-item.is-danger').textContent.includes('退出登录'));
  await act(async () => document.querySelector('.account-menu-item.is-danger').click());
  assert.deepEqual(actions, ['register', 'logout']);

  await act(async () => trigger.click());
  await act(async () => document.getElementById('outside').dispatchEvent(new dom.window.PointerEvent('pointerdown', { bubbles: true })));
  assert.equal(document.querySelector('[role="menu"]'), null, '点击外部关闭');
  await act(async () => root.unmount());
});

test('form validation mirrors the server rules', () => {
  const form = { nickname: '樺', email: 'a@example.com', password: 'abc12345', confirm: 'abc12345' };
  assert.equal(validateAuthForm('register', form), null);
  assert.equal(validateAuthForm('register', { ...form, nickname: '  ' }), '请填写昵称');
  assert.equal(validateAuthForm('register', { ...form, nickname: 'x'.repeat(21) }), '昵称需为 1 到 20 个字');
  assert.equal(validateAuthForm('register', { ...form, email: 'nope' }), '请输入有效的邮箱地址');
  assert.equal(validateAuthForm('register', { ...form, password: 'abcdefgh', confirm: 'abcdefgh' }), '密码需同时包含字母和数字');
  assert.equal(validateAuthForm('register', { ...form, password: 'ab1', confirm: 'ab1' }), '密码需为 8 到 128 位');
  assert.equal(validateAuthForm('register', { ...form, confirm: 'abc12346' }), '两次输入的密码不一致');
  // 登录不校验密码强度，只要求填写
  assert.equal(validateAuthForm('login', { ...form, password: 'x', confirm: '' }), null);
  assert.equal(validateAuthForm('login', { ...form, password: '' }), '请输入密码');
});

test('dialog blocks invalid input, shows server errors inline and switches between 登录 and 注册', async () => {
  const submitted = [];
  let mode = 'login';
  const renderDialog = (root) => root.render(React.createElement(AuthDialog, {
    mode,
    onModeChange: (next) => { mode = next; renderDialog(root); },
    onLogin: async (...args) => { submitted.push(['login', ...args]); throw new Error('邮箱或密码不正确'); },
    onRegister: async (...args) => { submitted.push(['register', ...args]); },
  }));
  const root = createRoot(document.getElementById('root'));
  await act(async () => renderDialog(root));
  const dialog = () => document.querySelector('.auth-dialog');
  assert.equal(dialog().querySelector('.auth-dialog-title').textContent, '登录');
  assert.equal(dialog().querySelector('.auth-dialog-submit').textContent, '登录');
  assert.equal(dialog().textContent.includes('忘记密码'), false, '暂不提供找回密码');
  assert.equal(dialog().querySelector('[data-slot="alert-dialog-description"], .auth-dialog-subtitle')?.className.includes('sr-only') ?? true, true,
    '标题下不显示说明文字（只保留给读屏的隐藏描述）');
  assert.equal(dialog().textContent.includes('会话可在'), false);

  const setInput = async (input, value) => {
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set;
    await act(async () => { setter.call(input, value); input.dispatchEvent(new dom.window.Event('input', { bubbles: true })); });
  };
  await act(async () => dialog().querySelector('form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })));
  assert.equal(dialog().querySelector('[role="alert"]').textContent, '请输入有效的邮箱地址');
  assert.equal(submitted.length, 0);

  const [email, password] = dialog().querySelectorAll('input:not([type="checkbox"])');
  await setInput(email, ' a@example.com ');
  assert.equal(dialog().querySelector('[role="alert"]'), null, '修改输入后清除提示');
  await setInput(password, 'wrong');
  await act(async () => dialog().querySelector('form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })));
  assert.deepEqual(submitted[0], ['login', 'a@example.com', 'wrong', true]);
  assert.equal(dialog().querySelector('[role="alert"]').textContent, '邮箱或密码不正确');

  await act(async () => dialog().querySelector('.auth-dialog-switch button').click());
  assert.equal(dialog().querySelector('.auth-dialog-title').textContent, '注册');
  assert.equal(dialog().querySelector('.auth-dialog-submit').textContent, '注册并登录');
  const fields = dialog().querySelectorAll('input');
  assert.equal(fields.length, 4);
  assert.equal(fields[1].value, 'a@example.com', '切换时保留邮箱（email 输入框自身会去掉首尾空格）');
  assert.equal(fields[2].value, '', '切换时清空密码');
  await setInput(fields[0], '樺');
  await setInput(fields[2], 'abc12345');
  await setInput(fields[3], 'abc12345');
  await act(async () => dialog().querySelector('form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })));
  assert.deepEqual(submitted[1], ['register', '樺', 'a@example.com', 'abc12345']);
  await act(async () => root.unmount());
});

test('auth store follows login, register, logout and /me; the nickname follows the account', async () => {
  const calls = mockFetch((url) => {
    if (url === '/api/auth/me') return { body: { success: true, user: USER } };
    if (url === '/api/auth/login') return { body: { success: true, user: USER } };
    if (url === '/api/auth/register') return { status: 409, body: { detail: '该邮箱已注册，请直接登录' } };
    if (url === '/api/auth/logout') return { body: { success: true } };
    return { status: 404 };
  });
  assert.equal(getAuthState().status, 'loading');
  assert.equal(getUserNickname(), '你');
  await loadCurrentUser();
  assert.deepEqual(getAuthState(), { status: 'ready', user: USER });
  assert.equal(getUserNickname(), '樺');

  await logout();
  assert.equal(getAuthState().user, null);
  await login('a@example.com', 'abc12345', false);
  assert.deepEqual(JSON.parse(calls.at(-1).init.body), { email: 'a@example.com', password: 'abc12345', remember: false });
  assert.equal(calls.at(-1).init.credentials, 'same-origin');
  assert.equal(getAuthState().user.id, 'acc-1');
  await assert.rejects(register('樺', 'a@example.com', 'abc12345'), /该邮箱已注册/);
  assert.equal(getAuthState().user.id, 'acc-1', '注册失败不改变当前登录状态');
});

test('logout clears local state even when the server is unreachable; /me failure means signed out', async () => {
  globalThis.fetch = async () => { throw new TypeError('network down'); };
  await assert.rejects(logout());
  assert.equal(getAuthState().user, null);
  await loadCurrentUser();
  assert.deepEqual(getAuthState(), { status: 'ready', user: null });
});

test('avatar frame: default and view-only when signed out, editable only with a save handler', async () => {
  const root = await mount(React.createElement(AppAvatar, { className: 'footer-avatar', editable: true }));
  assert.ok(document.querySelector('.app-avatar-view'), '未登录仍可放大查看');
  assert.equal(document.querySelector('.app-avatar-edit'), null, '未登录不显示编辑按钮');
  assert.equal(document.querySelector('.app-avatar-file'), null);
  await act(async () => root.render(React.createElement(AppAvatar, { className: 'footer-avatar', editable: true, onSaveAvatar: async () => {} })));
  assert.ok(document.querySelector('.app-avatar-edit'), '登录后显示编辑按钮');
  assert.equal(document.querySelector('.app-avatar-edit').getAttribute('aria-label'), '修改头像');
  await act(async () => root.unmount());
});

test('uploading an avatar saves it to the account and bumps the version in the auth state', async () => {
  const calls = mockFetch((url, init) => {
    if (url === '/api/auth/login') return { body: { success: true, user: USER } };
    if (url === '/api/auth/avatar' && init.method === 'PUT') return { body: { success: true, user: { ...USER, avatarVersion: 42 } } };
    return { status: 404 };
  });
  await login('a@example.com', 'abc12345', true);
  const image = new Blob(['PNG'], { type: 'image/png' });
  await uploadAccountAvatar(image);
  const put = calls.find((call) => call.init.method === 'PUT');
  assert.equal(put.init.body, image);
  assert.equal(put.init.headers['Content-Type'], 'image/png');
  assert.equal(getAuthState().user.avatarVersion, 42);

  mockFetch(() => ({ status: 415, body: { detail: '请上传 PNG、JPG、WebP 或 GIF 图片' } }));
  await assert.rejects(uploadAccountAvatar(new Blob(['x'])), /请上传 PNG/);
});

test('a pre-account local avatar migrates once to an account that has none', async () => {
  localStorage.clear();
  localStorage.setItem('gor-custom-avatar', 'data:image/png;base64,UE5H');
  let uploads = 0;
  mockFetch((url, init) => {
    if (url.startsWith('data:')) return { body: {} };
    if (url === '/api/auth/avatar' && init.method === 'PUT') { uploads += 1; return { body: { success: true, user: { ...USER, avatarVersion: 7 } } }; }
    return { status: 404 };
  });
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => (String(url).startsWith('data:')
    ? new Response(new Blob(['PNG'], { type: 'image/png' })) : realFetch(url, init));
  await migrateLegacyAvatar({ ...USER, avatarVersion: 3 });
  assert.equal(uploads, 0, '账号已有头像时不迁移');
  await migrateLegacyAvatar(null);
  assert.equal(uploads, 0, '未登录不迁移');
  await migrateLegacyAvatar(USER);
  assert.equal(uploads, 1);
  assert.equal(localStorage.getItem('gor-avatar-migrated'), 'acc-1');
  assert.equal(localStorage.getItem('gor-custom-avatar'), 'data:image/png;base64,UE5H', '不删除本机原图');
  await migrateLegacyAvatar({ ...USER, id: 'acc-2' });
  assert.equal(uploads, 1, '同一浏览器只迁移一次');
});

test('after signing in, session init skips the last-used session exactly once', () => {
  localStorage.setItem('gor-open-first-session', '1');
  assert.equal(consumeOpenFirstSession(), true);
  assert.equal(consumeOpenFirstSession(), false);
});

test('clicking 未登录 in the sidebar opens the login dialog, except while a reply is generating', async () => {
  mockFetch((url) => (url === '/api/auth/me' ? { body: { success: true, user: null } } : { body: { success: true } }));
  await logout();
  const render = (busy) => React.createElement(FeedbackProvider, null, React.createElement(AccountControl, { busy }));
  const root = await mount(render(true));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  const link = document.querySelector('.account-signin-link');
  assert.ok(link, '未登录时显示可点击的「未登录」');
  assert.equal(link.textContent, '未登录');
  await act(async () => link.click());
  assert.equal(document.querySelector('.auth-dialog'), null, '回复生成中不打开');
  await act(async () => root.render(render(false)));
  await act(async () => document.querySelector('.account-signin-link').click());
  assert.equal(document.querySelector('.auth-dialog .auth-dialog-title')?.textContent, '登录');
  await act(async () => root.unmount());
});

// 放在最后：安装插件运行时会替换全局 fetch 并把页面标记为插件模式。
test('plugin webview waits for the stored token, sends it as Bearer and persists a new one via the extension', async () => {
  const TOKEN = 'abcDEF123_-abcDEF123_-abcDEF123_-abcDEF12';
  for (const [name, content] of [['gor-api-base', 'http://127.0.0.1:3001'], ['gor-assets-base', 'vscode-resource://media/chat/']]) {
    const meta = document.createElement('meta');
    meta.name = name;
    meta.content = content;
    document.head.append(meta);
  }
  const posted = [];
  window.acquireVsCodeApi = () => ({ postMessage: (message) => posted.push(message) });
  const network = [];
  window.fetch = async (input, init = {}) => {
    network.push({ url: String(input), headers: new dom.window.Headers(init.headers) });
    const path = new URL(String(input)).pathname;
    const body = path === '/api/auth/login' ? { success: true, user: USER, token: TOKEN } : { success: true, sessions: [] };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  installVscodeWebviewRuntime();
  globalThis.fetch = window.fetch;
  assert.ok(posted.some((message) => message.type === 'gor.authTokenRequest'));

  // 扩展交回凭证之前，会话列表请求挂起等待，避免按未登录读到 default:vscode
  const pending = fetch('/api/chat/sessions?userId=default%3Avscode');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(network.length, 0);
  window.dispatchEvent(new dom.window.MessageEvent('message', { data: { type: 'gor.authToken', token: TOKEN } }));
  await pending;
  assert.equal(network[0].url, 'http://127.0.0.1:3001/api/chat/sessions?userId=default%3Avscode');
  assert.equal(network[0].headers.get('authorization'), `Bearer ${TOKEN}`);
  assert.equal(network[0].headers.get('x-gor-client'), 'vscode');

  // 登录：新凭证交给扩展写入 SecretStorage，确认写入后才算完成
  let settled = false;
  const signingIn = login('a@example.com', 'abc12345', true).then(() => { settled = true; });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(posted.at(-1), { type: 'gor.saveAuthToken', token: TOKEN });
  assert.equal(settled, false, '等待扩展确认写入');
  window.dispatchEvent(new dom.window.MessageEvent('message', { data: { type: 'gor.authTokenSaved' } }));
  await signingIn;
  assert.equal(getAuthState().user.id, 'acc-1');

  // 插件里不能让页面自己 location.reload()（Webview 会黑屏），改为请扩展重新设置内容
  const before = window.location.href;
  reloadForIdentityChange(true);
  assert.deepEqual(posted.at(-1), { type: 'gor.reloadWebview' });
  assert.equal(window.location.href, before, '页面自身不改地址、不重载');
  assert.equal(consumeOpenFirstSession(), true, '重载后仍进入第一个会话');
});
