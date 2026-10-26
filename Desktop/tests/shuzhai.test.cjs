const assert = require('node:assert/strict');
const { once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
// 测试服务端用公共核心自带的 ws（桌面端本身不直接依赖 ws）
const { WebSocketServer } = require(require.resolve('ws', { paths: [path.dirname(require.resolve('@gor/workspace-core'))] }));
const { addRecent, MAX_RECENT, ShuzhaiService, validateFolder, workspaceSocketUrl } = require('../out/shuzhai.js');

function tempDir(prefix = 'gor-shuzhai-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function fakeConnections() {
  const made = [];
  const create = (url, output, onStatus, onRequest, describe) => {
    const connection = {
      url, onStatus, onRequest, describe, disposed: false, workspaceId: undefined,
      connect: async () => { onStatus('connected'); },
      dispose() { this.disposed = true; },
    };
    made.push(connection);
    return connection;
  };
  return { made, create };
}

function service(overrides = {}) {
  const states = [];
  const deps = {
    storePath: path.join(tempDir(), 'shuzhai.json'),
    apiBase: 'http://localhost:3001',
    chooseFolder: async () => undefined,
    trashItem: async () => {},
    showWarningModal: async () => undefined,
    revealPath: () => {},
    onState: (state) => states.push(state),
    log: () => {},
    ...overrides,
  };
  return { svc: new ShuzhaiService(deps), states, deps };
}

test('后端地址换成工作区 WebSocket 地址', () => {
  assert.equal(workspaceSocketUrl('http://localhost:3001'), 'ws://localhost:3001/ws/vscode');
  assert.equal(workspaceSocketUrl('https://gor.example.com'), 'wss://gor.example.com/ws/vscode');
});

test('书斋文件夹校验：拒绝磁盘根、用户目录、系统目录、文件和不存在的路径', async () => {
  const dir = tempDir();
  try {
    const ok = await validateFolder(dir);
    assert.equal(ok.ok, true);
    assert.equal(ok.folder.name, path.basename(dir));
    fs.writeFileSync(path.join(dir, 'a.txt'), 'x');
    for (const value of [path.parse(dir).root, os.homedir(), path.join(dir, 'a.txt'), path.join(dir, 'missing'), 'relative/dir', '', 42]) {
      const result = await validateFolder(value);
      assert.equal(result.ok, false, String(value));
      assert.ok(result.reason);
    }
    if (process.platform === 'win32' && fs.existsSync('C:\\Windows')) {
      assert.match((await validateFolder('C:\\Windows')).reason, /系统目录不能设为书斋/);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('最近列表去重、按时间倒序且有上限', () => {
  let recent = [];
  for (let index = 0; index < MAX_RECENT + 3; index += 1) recent = addRecent(recent, { path: `/p/${index}`, name: `${index}` }, index);
  assert.equal(recent.length, MAX_RECENT);
  assert.equal(recent[0].path, `/p/${MAX_RECENT + 2}`);
  recent = addRecent(recent, { path: `/p/${MAX_RECENT}`, name: 'again' }, 100);
  assert.equal(recent[0].name, 'again');
  assert.equal(recent.filter((item) => item.path === `/p/${MAX_RECENT}`).length, 1);
});

test('经对话框选文件夹后登记为 desktop 书斋并保存；取消与不合适的文件夹不切换', async () => {
  const dir = tempDir();
  const { made, create } = fakeConnections();
  let answer;
  const { svc, deps } = service({ chooseFolder: async () => answer, createConnection: create });
  try {
    assert.deepEqual((await svc.pickFolder()).reason, 'cancelled');
    answer = os.homedir();
    const refused = await svc.pickFolder();
    assert.equal(refused.ok, false);
    assert.equal(made.length, 0);

    answer = dir;
    const opened = await svc.pickFolder();
    assert.equal(opened.ok, true);
    assert.equal(opened.state.folder.path, fs.realpathSync(dir));
    assert.equal(opened.state.connection, 'connected');
    assert.equal(made.length, 1);
    assert.equal(made[0].url, 'ws://localhost:3001/ws/vscode');
    const message = made[0].describe();
    assert.equal(message.client, 'desktop');
    assert.equal(message.workspaceName, path.basename(dir));
    assert.match(message.workspaceFolders[0].uri, /^file:\/\//);
    const stored = JSON.parse(fs.readFileSync(deps.storePath, 'utf8'));
    assert.equal(stored.current, fs.realpathSync(dir));
    assert.equal(stored.recent[0].path, fs.realpathSync(dir));
  } finally {
    svc.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('页面只能重开最近的书斋；换书斋会断开旧登记；收起后保留最近列表', async () => {
  const first = tempDir();
  const second = tempDir();
  const { made, create } = fakeConnections();
  let answer = first;
  const { svc, deps } = service({ chooseFolder: async () => answer, createConnection: create });
  try {
    await svc.pickFolder();
    answer = second;
    await svc.pickFolder();
    assert.equal(made[0].disposed, true, '换书斋时断开旧连接');

    const unknown = await svc.openRecent(os.tmpdir());
    assert.equal(unknown.ok, false);
    assert.match(unknown.reason, /只能打开最近用过的书斋/);

    const back = await svc.openRecent(fs.realpathSync(first));
    assert.equal(back.ok, true);
    assert.equal(back.state.folder.path, fs.realpathSync(first));
    assert.equal(made[1].disposed, true);

    const closed = await svc.close();
    assert.equal(closed.folder, null);
    assert.equal(closed.connection, 'idle');
    assert.equal(made[2].disposed, true);
    assert.equal(closed.recent.length, 2);
    const stored = JSON.parse(fs.readFileSync(deps.storePath, 'utf8'));
    assert.equal(stored.current, undefined);
  } finally {
    svc.dispose();
    fs.rmSync(first, { recursive: true, force: true });
    fs.rmSync(second, { recursive: true, force: true });
  }
});

test('启动时恢复上次的书斋；已不存在的文件夹从最近列表中去掉', async () => {
  const dir = tempDir();
  const gone = path.join(os.tmpdir(), `gor-gone-${Date.now()}`);
  const storeDir = tempDir();
  const storePath = path.join(storeDir, 'shuzhai.json');
  fs.writeFileSync(storePath, JSON.stringify({ current: dir, recent: [{ path: gone, name: 'gone', openedAt: 2 }, { path: dir, name: 'x', openedAt: 1 }] }));
  const { made, create } = fakeConnections();
  const { svc } = service({ storePath, createConnection: create });
  try {
    const state = await svc.restore();
    assert.equal(state.folder.path, fs.realpathSync(dir));
    assert.deepEqual(state.recent.map((item) => item.path), [fs.realpathSync(dir)]);
    assert.equal(made.length, 1);
  } finally {
    svc.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(storeDir, { recursive: true, force: true });
  }
});

test('真实连接：书斋登记后回应服务端的读取请求，删除经确认框后进回收站', async () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'hello.txt'), 'hi from 书斋\n');
  const server = new WebSocketServer({ port: 0 });
  await once(server, 'listening');
  const trashed = [];
  const modals = [];
  const responses = new Map();
  let socket;
  server.on('connection', (value) => {
    socket = value;
    value.on('message', (data) => {
      const message = JSON.parse(data.toString());
      if (message.type === 'workspace_connected') value.send(JSON.stringify({ type: 'workspace_registered', workspaceId: 'vscode-desk' }));
      if (message.type === 'workspace_response') responses.set(message.requestId, message);
    });
  });
  const { svc } = service({
    apiBase: `http://127.0.0.1:${server.address().port}`,
    chooseFolder: async () => dir,
    trashItem: async (fsPath) => { trashed.push(fsPath); fs.rmSync(fsPath); },
    showWarningModal: async (message, detail, actions) => { modals.push({ message, detail }); return actions[0]; },
  });
  const request = async (requestId, method, params) => {
    socket.send(JSON.stringify({ type: 'workspace_request', requestId, workspaceId: 'vscode-desk', method, params }));
    const deadline = Date.now() + 3000;
    while (!responses.has(requestId) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    return responses.get(requestId);
  };
  try {
    await svc.pickFolder();
    const deadline = Date.now() + 3000;
    while (svc.state.workspaceId !== 'vscode-desk' && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(svc.state.workspaceId, 'vscode-desk');
    assert.equal(svc.state.connection, 'connected');

    const read = await request('r1', 'project.readFile', { path: '/hello.txt' });
    assert.equal(read.success, true, JSON.stringify(read.error));
    assert.equal(read.result.content, 'hi from 书斋\n');

    const removed = await request('r2', 'project.deleteFile', { path: '/hello.txt', approvalMode: 'auto' });
    assert.equal(removed.success, true, JSON.stringify(removed.error));
    assert.equal(modals.length, 1);
    assert.match(modals[0].detail, /删除文件 \/hello\.txt/);
    assert.deepEqual(trashed, [path.join(fs.realpathSync(dir), 'hello.txt')]);

    const wrongWorkspace = await new Promise((resolve) => {
      socket.send(JSON.stringify({ type: 'workspace_request', requestId: 'r3', workspaceId: 'other', method: 'project.listFiles', params: {} }));
      const timer = setInterval(() => { if (responses.has('r3')) { clearInterval(timer); resolve(responses.get('r3')); } }, 10);
    });
    assert.equal(wrongWorkspace.error.code, 'WORKSPACE_NOT_FOUND');
  } finally {
    svc.dispose();
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
