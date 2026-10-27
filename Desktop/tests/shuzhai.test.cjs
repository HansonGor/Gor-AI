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

test('新建空白项目：建好空文件夹后设为书斋；同名非空文件夹不覆盖；取消不切换', async () => {
  const parent = tempDir();
  const { made, create } = fakeConnections();
  let answer;
  const { svc } = service({ chooseNewProjectPath: async () => answer, createConnection: create });
  try {
    assert.equal((await svc.createProject()).reason, 'cancelled');
    answer = path.join(parent, '新项目');
    const created = await svc.createProject();
    assert.equal(created.ok, true, created.reason);
    assert.equal(created.state.folder.name, '新项目');
    assert.deepEqual(fs.readdirSync(answer), [], '新项目是空文件夹');
    assert.equal(made.length, 1);

    fs.writeFileSync(path.join(answer, 'keep.txt'), 'x');
    const again = await svc.createProject();
    assert.equal(again.ok, false);
    assert.match(again.reason, /已存在且不为空/);
    assert.equal(fs.readFileSync(path.join(answer, 'keep.txt'), 'utf8'), 'x', '不覆盖已有文件');

    answer = path.join(parent, 'missing-parent', 'x');
    assert.match((await svc.createProject()).reason, /所在的文件夹不存在/);
  } finally {
    svc.dispose();
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test('拖入的文件夹经同样的校验后设为书斋', async () => {
  const dir = tempDir();
  const { create } = fakeConnections();
  const { svc } = service({ createConnection: create });
  try {
    const opened = await svc.openDropped(dir);
    assert.equal(opened.ok, true);
    assert.equal(opened.state.folder.path, fs.realpathSync(dir));
    assert.equal((await svc.openDropped(os.homedir())).ok, false, '拖入整个用户目录同样被拒绝');
    assert.equal((await svc.openDropped('')).ok, false, '不是用户拖入的文件对象时 preload 传空路径');
  } finally {
    svc.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('施行卡片：页面展示并回答后返回答复；页面没展示时退回系统确认框', async () => {
  const { ToolchainRelay, isLocalDevUrl } = require('../out/toolchainRelay.js');
  const sent = [];
  const opened = [];
  const cancelled = [];
  let accept = true;
  const relay = new ToolchainRelay((message) => { sent.push(message); return accept; }, (url) => opened.push(url), (runId) => cancelled.push(runId));
  const request = (id) => ({ approvalId: id, runId: `run-${id}`, kind: 'file', toolchain: 'file', action: 'delete_file', command: '删除文件 /a', cwd: '/', level: 2,
    reason: 'destructive', allowRemember: false, effects: [], deadline: Date.now() + 60_000 });

  const answered = relay.requestApproval(request('a1'), new AbortController().signal);
  assert.equal(sent[0].kind, 'approval');
  relay.handlePageMessage({ type: 'gor.toolchainApprovalShown', approvalId: 'a1' });
  relay.handlePageMessage({ type: 'gor.toolchainApprovalAnswer', approvalId: 'a1', answer: 'approve', message: '新的说明' });
  assert.deepEqual(await answered, { answer: 'approve', message: '新的说明' });

  const unknown = relay.requestApproval(request('a2'), new AbortController().signal);
  relay.handlePageMessage({ type: 'gor.toolchainApprovalShown', approvalId: 'a2' });
  relay.handlePageMessage({ type: 'gor.toolchainApprovalAnswer', approvalId: 'a2', answer: 'rm -rf' });
  assert.equal(await unknown, 'skip', '不认识的回答一律按「搁置」处理');

  const notShown = await relay.requestApproval(request('a3'), new AbortController().signal);
  assert.equal(notShown, undefined, '页面 1.5 秒内没展示卡片：交给系统确认框');
  assert.equal(sent.at(-1).kind, 'withdrawn');

  accept = false;
  assert.equal(await relay.requestApproval(request('a4'), new AbortController().signal), undefined, '没有窗口：立即交给系统确认框');

  accept = true;
  const controller = new AbortController();
  const aborted = relay.requestApproval(request('a5'), controller.signal);
  controller.abort();
  assert.equal(await aborted, 'cancelled');

  relay.handlePageMessage({ type: 'gor.toolchainCancel', runId: 'run-9' });
  relay.handlePageMessage({ type: 'gor.toolchainOpenUrl', url: 'http://localhost:5173/' });
  relay.handlePageMessage({ type: 'gor.toolchainOpenUrl', url: 'https://evil.example.com/' });
  assert.deepEqual(cancelled, ['run-9']);
  assert.deepEqual(opened, ['http://localhost:5173/'], '只打开本机地址');
  assert.equal(isLocalDevUrl('http://user:pw@localhost:3000/'), false);
});

test('书斋服务的审阅：页面能展示时用施行卡片，否则用系统确认框', async () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'gone.txt'), 'x');
  const pageMessages = [];
  const modals = [];
  let svc;
  ({ svc } = service({
    chooseFolder: async () => dir,
    createConnection: fakeConnections().create,
    trashItem: async (fsPath) => fs.rmSync(fsPath),
    showWarningModal: async (message, detail, actions) => { modals.push(detail); return actions[0]; },
    sendToolchain: (message) => {
      pageMessages.push(message);
      if (message.kind === 'approval') {
        setTimeout(() => {
          svc.toolchain.handlePageMessage({ type: 'gor.toolchainApprovalShown', approvalId: message.request.approvalId });
          svc.toolchain.handlePageMessage({ type: 'gor.toolchainApprovalAnswer', approvalId: message.request.approvalId, answer: 'approve' });
        }, 20);
      }
      return true;
    },
  }));
  try {
    await svc.pickFolder();
    const { WorkspaceRequestHandler } = require('@gor/workspace-core');
    const handler = new WorkspaceRequestHandler({ appendLine() {} });
    let response;
    await handler.handle({ type: 'workspace_request', requestId: 'r', workspaceId: 'w', method: 'project.deleteFile', params: { path: '/gone.txt', approvalMode: 'auto' } },
      'w', (value) => { response = value; return true; });
    assert.equal(response.success, true, JSON.stringify(response.error));
    assert.ok(pageMessages.some((message) => message.kind === 'approval'), '审阅发给了聊天页');
    assert.deepEqual(modals, [], '页面回答了就不弹系统确认框');
    assert.equal(fs.existsSync(path.join(dir, 'gone.txt')), false);
  } finally {
    svc.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function remoteConnections() {
  const made = [];
  const create = (url, output, onStatus, onRequest, describe, onServerMessage) => {
    const connection = {
      url, describe, onServerMessage, sent: [], announced: [], disposed: false, workspaceId: 'desktop-1',
      connect: async () => { onStatus('connected'); connection.announced.push(describe()); },
      send(message) { connection.sent.push(message); return true; },
      reannounce() { connection.announced.push(describe()); return true; },
      dispose() { connection.disposed = true; },
    };
    made.push(connection);
    return connection;
  };
  return { made, create };
}

async function deleteViaHandler(fileName) {
  const { WorkspaceRequestHandler } = require('@gor/workspace-core');
  const handler = new WorkspaceRequestHandler({ appendLine() {} });
  let response;
  await handler.handle({ type: 'workspace_request', requestId: 'r', workspaceId: 'w', method: 'project.deleteFile', params: { path: `/${fileName}`, approvalMode: 'auto' } },
    'w', (value) => { response = value; return true; });
  return response;
}

test('遥斋：登记带凭证与开关，审阅转给网页并接受网页的回答，断开设备与关开关即拒绝', async () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'a.txt'), 'x');
  fs.writeFileSync(path.join(dir, 'b.txt'), 'x');
  const { made, create } = remoteConnections();
  const modals = [];
  let token = 'tok-1';
  const { svc, deps } = service({
    chooseFolder: async () => dir,
    createConnection: create,
    getAuthToken: () => token,
    deviceName: 'Gor-PC',
    trashItem: async (fsPath) => fs.rmSync(fsPath),
    showWarningModal: async (message, detail, actions) => { modals.push(detail); return undefined; },
    sendToolchain: () => false, // 本机页面在云笺，展示不了卡片
  });
  try {
    await svc.restore();
    await svc.pickFolder();
    const connection = made[0];
    const first = connection.announced.at(-1);
    assert.equal(first.authToken, 'tok-1');
    assert.equal(first.deviceName, 'Gor-PC');
    assert.equal(first.folderPath, fs.realpathSync(dir));
    assert.equal(first.remoteAllowed, false, '默认不允许遥控');
    assert.match(first.deviceId, /^[\w-]{8,}$/);
    assert.equal(JSON.parse(fs.readFileSync(deps.storePath, 'utf8')).deviceId, first.deviceId, '设备标识持久保存');

    const state = await svc.setRemoteAllowed(true);
    assert.equal(state.remote.allowed, true);
    assert.equal(connection.announced.at(-1).remoteAllowed, true, '开关变化后重新登记');
    assert.equal(JSON.parse(fs.readFileSync(deps.storePath, 'utf8')).remoteAllowed, true);

    connection.onServerMessage({ type: 'remote_status', available: true, clients: [{ id: 'phone', label: 'iPhone · Safari', lastActive: 1 }] });
    assert.deepEqual(svc.state.remote, { allowed: true, available: true, clients: [{ id: 'phone', label: 'iPhone · Safari', lastActive: 1 }] });

    // 网页回答：审阅经连接转出，网页先展示再允许
    const pendingA = deleteViaHandler('a.txt');
    for (let i = 0; i < 50 && !connection.sent.some((m) => m.type === 'remote_toolchain' && m.message.kind === 'approval'); i += 1) await new Promise((r) => setTimeout(r, 10));
    const approval = connection.sent.find((m) => m.type === 'remote_toolchain' && m.message.kind === 'approval').message.request;
    connection.onServerMessage({ type: 'remote_page_message', message: { type: 'gor.toolchainOpenUrl', url: 'http://localhost:1' } });
    connection.onServerMessage({ type: 'remote_page_message', message: { type: 'gor.toolchainApprovalShown', approvalId: approval.approvalId } });
    connection.onServerMessage({ type: 'remote_page_message', message: { type: 'gor.toolchainApprovalAnswer', approvalId: approval.approvalId, answer: 'approve' } });
    const responseA = await pendingA;
    assert.equal(responseA.success, true, JSON.stringify(responseA.error));
    assert.equal(fs.existsSync(path.join(dir, 'a.txt')), false);
    assert.deepEqual(modals, [], '网页回答了就不弹系统确认框');
    assert.ok(connection.sent.some((m) => m.type === 'remote_toolchain' && m.message.kind === 'update'), '施行状态也转给网页');

    // 关掉开关：未回答的审阅一律拒绝，不删文件
    const pendingB = deleteViaHandler('b.txt');
    for (let i = 0; i < 50 && connection.sent.filter((m) => m.type === 'remote_toolchain' && m.message.kind === 'approval').length < 2; i += 1) await new Promise((r) => setTimeout(r, 10));
    const second = connection.sent.filter((m) => m.type === 'remote_toolchain' && m.message.kind === 'approval')[1].message.request;
    connection.onServerMessage({ type: 'remote_page_message', message: { type: 'gor.toolchainApprovalShown', approvalId: second.approvalId } });
    await svc.setRemoteAllowed(false);
    const responseB = await pendingB;
    assert.equal(responseB.success, false);
    assert.equal(fs.existsSync(path.join(dir, 'b.txt')), true);
    assert.deepEqual(svc.state.remote.clients, []);
    connection.onServerMessage({ type: 'remote_page_message', message: { type: 'gor.toolchainApprovalAnswer', approvalId: 'x', answer: 'approve' } });

    // 断开设备
    await svc.setRemoteAllowed(true);
    connection.onServerMessage({ type: 'remote_clients', clients: [{ id: 'phone', label: 'iPhone', lastActive: 2 }, { id: 'pc', label: 'Chrome', lastActive: 1 }] });
    svc.disconnectRemote('phone');
    assert.deepEqual(connection.sent.at(-1), { type: 'remote_disconnect', clientId: 'phone' });
    assert.deepEqual(svc.state.remote.clients.map((c) => c.id), ['pc']);
    svc.disconnectRemote('unknown');
    assert.deepEqual(connection.sent.at(-1), { type: 'remote_disconnect', clientId: 'phone' }, '不认识的设备不发');

    // 退出登录：凭证变了就重新登记，不再带凭证
    const before = connection.announced.length;
    svc.refreshAuth();
    assert.equal(connection.announced.length, before, '凭证没变不重复登记');
    token = null;
    svc.refreshAuth();
    assert.equal(connection.announced.length, before + 1);
    assert.equal('authToken' in connection.announced.at(-1), false);
  } finally {
    svc.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('旧版 shuzhai.json 没有设备标识：启动后补上标识，仍保留并重开当前书斋', async () => {
  const dir = tempDir();
  const storePath = path.join(tempDir(), 'shuzhai.json');
  const real = fs.realpathSync(dir);
  fs.writeFileSync(storePath, JSON.stringify({ current: real, recent: [{ path: real, name: path.basename(real), openedAt: 1 }] }));
  const { made, create } = remoteConnections();
  const { svc } = service({ storePath, createConnection: create });
  try {
    const state = await svc.restore();
    assert.equal(state.folder.path, real);
    const stored = JSON.parse(fs.readFileSync(storePath, 'utf8'));
    assert.equal(stored.current, real, '不丢当前书斋');
    assert.match(stored.deviceId, /^[\w-]{8,}$/);
    assert.equal(stored.remoteAllowed, false);
    assert.equal(made[0].announced.at(-1).deviceId, stored.deviceId, '登记用的就是保存的标识');
  } finally {
    svc.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('遥斋开启时：没有网页在线也转发审阅，并一直等回答，不退回系统确认框', async () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'c.txt'), 'x');
  const { made, create } = remoteConnections();
  const modals = [];
  const { svc } = service({
    chooseFolder: async () => dir, createConnection: create, getAuthToken: () => 'tok',
    trashItem: async (fsPath) => fs.rmSync(fsPath),
    showWarningModal: async (message, detail, actions) => { modals.push(detail); return undefined; },
    sendToolchain: () => false,
  });
  try {
    await svc.restore();
    await svc.pickFolder();
    await svc.setRemoteAllowed(true);
    const connection = made[0];
    connection.onServerMessage({ type: 'remote_status', available: true, clients: [] });
    const pending = deleteViaHandler('c.txt');
    for (let i = 0; i < 50 && !connection.sent.some((m) => m.type === 'remote_toolchain' && m.message.kind === 'approval'); i += 1) await new Promise((r) => setTimeout(r, 10));
    const approval = connection.sent.find((m) => m.type === 'remote_toolchain' && m.message.kind === 'approval');
    assert.ok(approval, '没有网页在线也转发，稍后打开的设备由服务端补上卡片');
    await new Promise((r) => setTimeout(r, 1700));
    assert.deepEqual(modals, [], '超过本机展示等待时间也不弹系统确认框');
    connection.onServerMessage({ type: 'remote_page_message', message: { type: 'gor.toolchainApprovalAnswer', approvalId: approval.message.request.approvalId, answer: 'approve' } });
    assert.equal((await pending).success, true);
    assert.equal(fs.existsSync(path.join(dir, 'c.txt')), false);
  } finally {
    svc.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('遥斋：断线时清空遥控设备；重新登记后把仍在等待的审阅再转给网页', async () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'd.txt'), 'x');
  const made = [];
  const create = (url, output, onStatus, onRequest, describe, onServerMessage) => {
    const connection = {
      onStatus, onServerMessage, sent: [], workspaceId: 'desktop-1',
      connect: async () => { onStatus('connected'); },
      send(message) { connection.sent.push(message); return true; },
      reannounce() { return true; },
      dispose() {},
    };
    made.push(connection);
    return connection;
  };
  const { svc } = service({ chooseFolder: async () => dir, createConnection: create, getAuthToken: () => 'tok', sendToolchain: () => false,
    trashItem: async (fsPath) => fs.rmSync(fsPath) });
  try {
    await svc.restore();
    await svc.pickFolder();
    await svc.setRemoteAllowed(true);
    const connection = made[0];
    connection.onServerMessage({ type: 'remote_status', available: true, clients: [{ id: 'phone', label: 'iPhone', lastActive: 1 }] });
    const pending = deleteViaHandler('d.txt');
    for (let i = 0; i < 50 && !connection.sent.some((m) => m.type === 'remote_toolchain' && m.message.kind === 'approval'); i += 1) await new Promise((r) => setTimeout(r, 10));
    connection.onStatus('disconnected');
    assert.deepEqual(svc.state.remote.clients, [], '断线时不再显示遥控设备');
    assert.equal(svc.state.remote.available, false);
    connection.sent.length = 0;
    connection.onStatus('connected');
    connection.onServerMessage({ type: 'remote_status', available: true, clients: [] });
    const resent = connection.sent.filter((m) => m.type === 'remote_toolchain' && m.message.kind === 'approval');
    assert.equal(resent.length, 1, '重新登记后再转一遍');
    connection.onServerMessage({ type: 'remote_page_message', message: { type: 'gor.toolchainApprovalAnswer', approvalId: resent[0].message.request.approvalId, answer: 'approve' } });
    assert.equal((await pending).success, true);
  } finally {
    svc.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
