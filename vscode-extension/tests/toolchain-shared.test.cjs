const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

// Node / Python 工具链共用的纯函数：路径解析、参数校验、PATH 查找、子项目扫描。
class Uri {
  constructor(value, scheme = 'file') { this.scheme = scheme; this.authority = ''; this.path = value; }
  get fsPath() { return process.platform === 'win32' ? this.path.replace(/^\//, '').split('/').join('\\') : this.path; }
  static file(fsPath) {
    const normalized = path.resolve(fsPath).split(path.sep).join('/');
    return new Uri(normalized.startsWith('/') ? normalized : `/${normalized}`);
  }
  static joinPath(base, ...segments) { return new Uri(path.posix.join(base.path, ...segments), base.scheme); }
}
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') return { Uri, FileType: { File: 1, Directory: 2, SymbolicLink: 64 }, workspace: {} };
  return originalLoad.call(this, request, parent, isMain);
};
require('../out/workspace/vscodeHost.js').installVsCodeWorkspaceHost();
const shared = require('@gor/workspace-core/out/toolchain/profiles/shared.js');
Module._load = originalLoad;

function tree(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gor-shared-'));
  for (const relative of files) {
    const file = path.join(dir, relative);
    if (relative.endsWith('/')) { fs.mkdirSync(file, { recursive: true }); continue; }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '');
  }
  return dir;
}

function context(dir, cwd = '') {
  const root = { name: 'ws', uri: Uri.file(dir) };
  return { root, cwd: cwd ? `/${cwd}` : '/', cwdUri: cwd ? Uri.joinPath(root.uri, cwd) : root.uri, env: {} };
}

test('targetPath: workspace-root paths, command-relative paths, and nothing outside the command directory', () => {
  const dir = tree(['test-demo/test_math.py', 'test-demo/sub/a.py', 'other.py']);
  const ctx = context(dir, 'test-demo');
  assert.equal(shared.targetPath(undefined, ctx), undefined);
  assert.equal(shared.targetPath('', ctx), undefined);
  assert.equal(shared.targetPath('/test-demo/test_math.py', ctx), 'test_math.py');
  assert.equal(shared.targetPath('test-demo/sub/a.py', ctx), path.join('sub', 'a.py'), '工作区根相对写法');
  assert.equal(shared.targetPath('test_math.py', ctx), 'test_math.py', '命令目录相对写法');
  assert.equal(shared.targetPath('sub/a.py', ctx), path.join('sub', 'a.py'));
  assert.equal(shared.targetPath('/test-demo', ctx), '.');
  assert.throws(() => shared.targetPath('/other.py', ctx), { code: 'INVALID_PATH' }, '以 / 开头只按工作区根解析');
  assert.throws(() => shared.targetPath('../other.py', ctx), { code: 'INVALID_PATH' });
  assert.throws(() => shared.targetPath('C:/Windows', ctx), { code: 'INVALID_PATH' });
  assert.throws(() => shared.targetPath('a\\b.py', ctx), { code: 'INVALID_PATH' });
  const py = { pattern: /\.pyw?$/i, message: 'file 必须是工作区内的 .py 文件。' };
  assert.equal(shared.targetPath('test_math.py', ctx, py), 'test_math.py');
  assert.throws(() => shared.targetPath('notes.txt', ctx, py), { code: 'INVALID_PARAMS', message: py.message });
  // 根目录作为命令目录时，两种写法一致
  assert.equal(shared.targetPath('other.py', context(dir)), 'other.py');
});

test('readArgs: at most N plain strings, passed through untouched', () => {
  assert.deepEqual(shared.readArgs(undefined, 'Python'), []);
  assert.deepEqual(shared.readArgs(null, 'Python'), []);
  assert.deepEqual(shared.readArgs(['-v', '&& rm -rf /', 'a b'], 'Python'), ['-v', '&& rm -rf /', 'a b']);
  assert.equal(shared.readArgs(Array(20).fill('x'), 'Python').length, 20);
  assert.throws(() => shared.readArgs(Array(21).fill('x'), 'Python'), { code: 'INVALID_PARAMS', message: /最多 20 个字符串（参数直接传给 Python，不经过 shell）/ });
  assert.throws(() => shared.readArgs(['a', 1], 'Node'), { code: 'INVALID_PARAMS', message: /传给 Node/ });
  assert.throws(() => shared.readArgs('-v', 'Python'), { code: 'INVALID_PARAMS' });
  assert.throws(() => shared.readArgs(['x'.repeat(501)], 'Python'), { code: 'INVALID_PARAMS' });
  assert.throws(() => shared.readArgs(['a\0b'], 'Python'), { code: 'INVALID_PARAMS' });
  assert.throws(() => shared.readArgs(['a', 'b', 'c'], 'Python', 2), { message: /最多 2 个/ });
});

test('findOnPath: PATH order, names tried within each directory, skip excludes placeholders', async () => {
  const dir = tree(['first/tool.exe', 'second/tool.exe', 'second/other.exe', 'stub/WindowsApps/py.exe', 'real/py.exe']);
  const key = Object.keys(process.env).find((name) => name.toLowerCase() === 'path') ?? 'PATH';
  const saved = process.env[key];
  try {
    process.env[key] = ['missing', 'first', 'second'].map((name) => path.join(dir, name)).join(path.delimiter);
    assert.equal(await shared.findOnPath(['tool.exe']), path.join(dir, 'first', 'tool.exe'));
    assert.equal(await shared.findOnPath(['other.exe', 'tool.exe']), path.join(dir, 'first', 'tool.exe'), '目录优先于名字顺序');
    assert.equal(await shared.findOnPath(['nope.exe']), undefined);
    process.env[key] = [path.join(dir, 'stub', 'WindowsApps'), path.join(dir, 'real')].join(path.delimiter);
    assert.equal(await shared.findOnPath(['py.exe'], (file) => /[\\/]WindowsApps[\\/]/i.test(file)), path.join(dir, 'real', 'py.exe'));
    process.env[key] = '';
    assert.equal(await shared.findOnPath(['tool.exe']), undefined);
  } finally {
    process.env[key] = saved;
  }
});

test('findProjectDirs: marker files, excluded and hidden directories, depth and count limits', async () => {
  const dir = tree([
    'package.json', 'web/package.json', 'node_modules/x/package.json', '.hidden/package.json', 'Build/package.json',
    'a/b/c/package.json', 'a/b/c/d/package.json', 'py/requirements.txt',
  ]);
  const excluded = new Set([...shared.BASE_EXCLUDED_DIRS]);
  const found = await shared.findProjectDirs(dir, { markers: ['package.json'], excluded, max: 30 });
  assert.deepEqual(found.map((item) => shared.workspaceRelativeDir(dir, item)).sort(), ['/', '/a/b/c', '/web'],
    '跳过 node_modules、隐藏目录、大小写不同的 Build，最多 3 层');
  const py = await shared.findProjectDirs(dir, { markers: ['pyproject.toml', 'requirements.txt'], excluded, max: 30 });
  assert.deepEqual(py.map((item) => shared.workspaceRelativeDir(dir, item)), ['/py']);
  assert.equal((await shared.findProjectDirs(dir, { markers: ['package.json'], excluded, max: 2 })).length, 2);
  assert.ok(shared.BASE_EXCLUDED_DIRS.includes('node_modules') && shared.BASE_EXCLUDED_DIRS.includes('dist'));
});

test('small helpers: exists, hash, isInside, workspaceRelativeDir, requireLocalFolder, rootDirOf / cwdDirOf', async () => {
  const dir = tree(['a.txt', 'sub/']);
  assert.equal(await shared.exists(path.join(dir, 'a.txt')), true);
  assert.equal(await shared.exists(path.join(dir, 'sub')), true);
  assert.equal(await shared.exists(path.join(dir, 'missing')), false);
  assert.equal(shared.hash('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  const base = path.join(dir, 'sub');
  assert.equal(shared.isInside(base, base), true);
  assert.equal(shared.isInside(path.join(base, 'x'), base), true);
  assert.equal(shared.isInside(base + '-other', base), false, '同前缀的兄弟目录不算在内');
  assert.equal(shared.isInside(dir, base), false);
  assert.equal(shared.workspaceRelativeDir(dir, dir), '/');
  assert.equal(shared.workspaceRelativeDir(dir, path.join(dir, 'a', 'b')), '/a/b');
  assert.doesNotThrow(() => shared.requireLocalFolder({ uri: Uri.file(dir) }));
  assert.throws(() => shared.requireLocalFolder({ uri: new Uri('/x', 'vscode-remote') }), { code: 'TOOLCHAIN_UNAVAILABLE' });
  const ctx = context(dir, 'sub');
  assert.equal(shared.rootDirOf(ctx), path.resolve(dir));
  assert.equal(shared.cwdDirOf(ctx), path.resolve(base));
});
