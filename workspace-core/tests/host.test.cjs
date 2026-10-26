const assert = require('node:assert/strict');
const { once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { WebSocketServer } = require('ws');

const srcDir = path.join(__dirname, '..', 'src');

test('公共核心不直接依赖 vscode 模块', () => {
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.ts') && /from\s+['"]vscode['"]|require\(['"]vscode['"]\)/.test(fs.readFileSync(full, 'utf8'))) {
        offenders.push(path.relative(srcDir, full));
      }
    }
  };
  walk(srcDir);
  assert.deepEqual(offenders, []);
});

test('未配置宿主时给出明确错误', () => {
  const { host } = require('../out/host.js');
  assert.throws(() => host(), /workspace host is not configured/);
});

const core = require('../out/index.js');
const { configureToolchainUi } = require('../out/toolchain/host.js');

function makeWorkspace(files) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gor-core-'));
  for (const [relative, content] of Object.entries(files)) {
    const full = path.join(rootDir, relative);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return rootDir;
}

function install(rootDir, extra = {}) {
  const trashed = [];
  core.setWorkspaceHost(core.createNodeWorkspaceHost({
    folders: () => [{ path: rootDir }],
    trashItem: async (fsPath) => { trashed.push(fsPath); fs.rmSync(fsPath, { recursive: true }); },
    ...extra,
  }));
  configureToolchainUi({ requestApproval: async () => 'approve', update() {}, output() {} });
  const handler = new core.WorkspaceRequestHandler({ appendLine() {} });
  const call = async (method, params = {}) => {
    let response;
    await handler.handle({ type: 'workspace_request', requestId: `${method}-${Math.random()}`, workspaceId: 'w1', method, params },
      'w1', (value) => { response = value; return true; });
    return response;
  };
  return { call, trashed };
}

test('本机宿主：列出、读取、搜索、补丁、版本冲突、新建、删除与路径越界', async () => {
  const rootDir = makeWorkspace({
    'src/app.js': "const title = 'old';\nmodule.exports = title;\n",
    'node_modules/skip.js': 'title ignored',
    '.env': 'SECRET=1',
  });
  try {
    const { call, trashed } = install(rootDir);

    const listed = await call('project.listFiles');
    assert.equal(listed.success, true);
    assert.deepEqual(listed.result.files, ['/src/app.js']);
    assert.equal(listed.result.rootName, path.basename(rootDir));

    const read = await call('project.readFile', { path: '/src/app.js' });
    assert.equal(read.success, true);
    assert.match(read.result.content, /'old'/);
    const again = await call('project.readFile', { path: '/src/app.js' });
    assert.equal(again.result.fileVersion, read.result.fileVersion, '内容没变时版本号保持不变');

    const searched = await call('project.searchCode', { query: 'title' });
    assert.deepEqual(searched.result.results.map((item) => item.path), ['/src/app.js']);

    const patched = await call('project.patchFile', { path: '/src/app.js', oldText: "'old'", newText: "'new'", expectedFileVersion: read.result.fileVersion });
    assert.equal(patched.success, true, JSON.stringify(patched.error));
    assert.match(patched.result.diff, /\+const title = 'new';/);
    assert.equal(fs.readFileSync(path.join(rootDir, 'src', 'app.js'), 'utf8'), "const title = 'new';\nmodule.exports = title;\n");
    const afterPatch = await call('project.readFile', { path: '/src/app.js' });
    assert.equal(afterPatch.result.fileVersion, patched.result.fileVersion, '保存后重新读取仍是修改后的版本');

    const stale = await call('project.patchFile', { path: '/src/app.js', oldText: "'new'", newText: "'x'", expectedFileVersion: read.result.fileVersion });
    assert.equal(stale.error.code, 'VERSION_CONFLICT');

    const created = await call('project.createFile', { path: '/src/extra.js', content: 'export {};\n' });
    assert.equal(created.success, true, JSON.stringify(created.error));
    assert.equal(fs.readFileSync(path.join(rootDir, 'src', 'extra.js'), 'utf8'), 'export {};\n');
    assert.equal((await call('project.createFile', { path: '/src/extra.js', content: 'again' })).error.code, 'FILE_ALREADY_EXISTS');
    assert.equal((await call('project.createFile', { path: '/missing/dir/a.js', content: 'x' })).error.code, 'DIRECTORY_NOT_FOUND');

    const dir = await call('project.createDirectory', { path: '/docs' });
    assert.equal(dir.success, true, JSON.stringify(dir.error));
    assert.equal(fs.statSync(path.join(rootDir, 'docs')).isDirectory(), true);

    const removed = await call('project.deleteFile', { path: '/src/extra.js', approvalMode: 'auto' });
    assert.equal(removed.success, true, JSON.stringify(removed.error));
    assert.deepEqual(trashed, [path.join(rootDir, 'src', 'extra.js')], '删除走系统回收站');
    assert.equal(fs.existsSync(path.join(rootDir, 'src', 'extra.js')), false);
    assert.equal((await call('project.readFile', { path: '/src/extra.js' })).error.code, 'FILE_NOT_FOUND');

    assert.equal((await call('project.readFile', { path: '/../outside.txt' })).error.code, 'INVALID_PATH');
    assert.equal((await call('project.readFile', { path: '/.env' })).error.code, 'INVALID_PATH');
    assert.equal((await call('project.readFile', { path: 'C:/Windows/win.ini' })).error.code, 'INVALID_PATH');
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test('本机宿主：保留 CRLF 与 UTF-8 BOM，读取行范围，批量补丁一次写入', async () => {
  const rootDir = makeWorkspace({
    'a.txt': '\uFEFFline1\r\nline2\r\nline3\r\n',
    'b.txt': 'one\ntwo\n',
  });
  try {
    const { call } = install(rootDir);
    const range = await call('project.readFile', { path: '/a.txt', startLine: 2, endLine: 3 });
    assert.equal(range.success, true, JSON.stringify(range.error));
    assert.equal(range.result.content, 'line2\r\nline3\r\n', '与 VS Code 一致：范围到下一行行首，含行尾换行');
    assert.equal(range.result.totalLines, 4);

    const batch = await call('project.applyPatches', { patches: [
      { path: '/a.txt', oldText: 'line2', newText: 'LINE2' },
      { path: '/b.txt', oldText: 'two', newText: 'TWO' },
    ] });
    assert.equal(batch.success, true, JSON.stringify(batch.error));
    assert.equal(fs.readFileSync(path.join(rootDir, 'a.txt'), 'utf8'), '\uFEFFline1\r\nLINE2\r\nline3\r\n');
    assert.equal(fs.readFileSync(path.join(rootDir, 'b.txt'), 'utf8'), 'one\nTWO\n');

    const missing = await call('project.applyPatches', { patches: [
      { path: '/b.txt', oldText: 'one', newText: 'ONE' },
      { path: '/a.txt', oldText: 'not here', newText: 'x' },
    ] });
    assert.equal(missing.error.code, 'PATCH_TARGET_NOT_FOUND');
    assert.equal(fs.readFileSync(path.join(rootDir, 'b.txt'), 'utf8'), 'one\nTWO\n', '任一补丁失败时整批不写');
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test('本机宿主：外部改动会刷新内容并递增版本，旧版本的修改被拒绝', async () => {
  const rootDir = makeWorkspace({ 'note.md': 'v1\n' });
  try {
    const { call } = install(rootDir);
    const first = await call('project.readFile', { path: '/note.md' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    fs.writeFileSync(path.join(rootDir, 'note.md'), 'v2 changed outside\n');
    const second = await call('project.readFile', { path: '/note.md' });
    assert.equal(second.result.content, 'v2 changed outside\n');
    assert.ok(second.result.fileVersion > first.result.fileVersion);
    const stale = await call('project.writeFile', { path: '/note.md', content: 'agent\n', expectedFileVersion: first.result.fileVersion });
    assert.equal(stale.error.code, 'VERSION_CONFLICT');
    assert.equal(fs.readFileSync(path.join(rootDir, 'note.md'), 'utf8'), 'v2 changed outside\n');
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test('本机宿主：变更快照与撤销还原到修改前内容', async () => {
  const rootDir = makeWorkspace({ 'app.js': 'before\n' });
  try {
    const { call } = install(rootDir);
    const before = (await call('project.inspectFiles', { paths: ['/app.js', '/new.js'] })).result.files;
    assert.equal(before['/app.js'].content, 'before\n');
    assert.equal(before['/new.js'].content, null);
    assert.equal((await call('project.writeFile', { path: '/app.js', content: 'after\n' })).success, true);
    assert.equal((await call('project.createFile', { path: '/new.js', content: 'n\n' })).success, true);
    const after = (await call('project.inspectFiles', { paths: ['/app.js', '/new.js'] })).result.files;

    const restored = await call('project.restoreFiles', { files: [
      { id: 'c1', path: '/app.js', before: before['/app.js'], after: after['/app.js'] },
      { id: 'c2', path: '/new.js', before: before['/new.js'], after: after['/new.js'] },
    ] });
    assert.equal(restored.success, true, JSON.stringify(restored.error));
    assert.deepEqual(restored.result.results.map((item) => item.success), [true, true]);
    assert.equal(fs.readFileSync(path.join(rootDir, 'app.js'), 'utf8'), 'before\n');
    assert.equal(fs.existsSync(path.join(rootDir, 'new.js')), false);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test('本机宿主：删除需要确认，拒绝时文件保留；没有书斋时如实报错', async () => {
  const rootDir = makeWorkspace({ 'keep.txt': 'x' });
  try {
    const { call, trashed } = install(rootDir);
    configureToolchainUi({ requestApproval: async () => 'skip', update() {}, output() {} });
    const refused = await call('project.deleteFile', { path: '/keep.txt', approvalMode: 'auto' });
    assert.equal(refused.error.code, 'USER_CANCELLED');
    assert.deepEqual(trashed, []);
    assert.equal(fs.existsSync(path.join(rootDir, 'keep.txt')), true);

    core.setWorkspaceHost(core.createNodeWorkspaceHost({ folders: () => [], trashItem: async () => {} }));
    const handler = new core.WorkspaceRequestHandler({ appendLine() {} });
    let response;
    await handler.handle({ type: 'workspace_request', requestId: 'r', workspaceId: 'w', method: 'project.listFiles', params: {} },
      'w', (value) => { response = value; return true; });
    assert.equal(response.error.code, 'WORKSPACE_NOT_FOUND');
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test('本机宿主：工具链在书斋目录下运行命令', async () => {
  const rootDir = makeWorkspace({ 'package.json': JSON.stringify({ name: 'demo', scripts: { hello: 'node -e "console.log(42)"' } }) });
  try {
    const { call } = install(rootDir);
    const run = await call('toolchain.run', { toolchain: 'node', action: 'run_script', args: { name: 'hello' }, approvalMode: 'auto' });
    assert.equal(run.success, true, JSON.stringify(run.error));
    assert.equal(run.result.status, 'completed', JSON.stringify(run.result));
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test('连接以 desktop 身份登记书斋，并回应服务端的工作区请求', async () => {
  const rootDir = makeWorkspace({ 'readme.md': 'hello\n' });
  const server = new WebSocketServer({ port: 0 });
  await once(server, 'listening');
  let connection;
  try {
    install(rootDir);
    const handler = new core.WorkspaceRequestHandler({ appendLine() {} });
    const registered = [];
    const responses = [];
    server.on('connection', (socket) => {
      socket.on('message', (data) => {
        const message = JSON.parse(data.toString());
        if (message.type === 'workspace_connected') {
          registered.push(message);
          socket.send(JSON.stringify({ type: 'workspace_registered', workspaceId: 'vscode-desk1' }));
          socket.send(JSON.stringify({ type: 'workspace_request', requestId: 'r1', workspaceId: 'vscode-desk1', method: 'project.readFile', params: { path: '/readme.md' } }));
        } else if (message.type === 'workspace_response') {
          responses.push(message);
        }
      });
    });
    const statuses = [];
    connection = new core.GorConnection(`ws://127.0.0.1:${server.address().port}`, { appendLine() {} },
      (status, workspaceId) => statuses.push([status, workspaceId]),
      (request, workspaceId, send) => { void handler.handle(request, workspaceId, send); },
      () => ({ type: 'workspace_connected', client: 'desktop', workspaceName: 'demo',
        workspaceFolders: [{ id: 'root-1', name: 'demo', uri: new core.NodeUri(rootDir).toString() }] }));
    await connection.connect();
    assert.equal(await connection.waitForWorkspace(2000), 'vscode-desk1');
    const deadline = Date.now() + 2000;
    while (!responses.length && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(registered[0].client, 'desktop');
    assert.match(registered[0].workspaceFolders[0].uri, /^file:\/\//);
    assert.equal(responses[0].success, true, JSON.stringify(responses[0].error));
    assert.equal(responses[0].result.content, 'hello\n');
    assert.ok(statuses.some(([status, id]) => status === 'connected' && id === 'vscode-desk1'));
  } finally {
    connection?.dispose();
    server.close();
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});
