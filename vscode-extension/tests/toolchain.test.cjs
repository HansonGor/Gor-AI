const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

// 用真实临时目录和真实子进程；只替换 vscode API 与 node / npm 的定位。
class Uri {
  constructor(value) { this.scheme = 'file'; this.authority = ''; this.path = value; }
  get fsPath() {
    return process.platform === 'win32' ? this.path.replace(/^\//, '').split('/').join('\\') : this.path;
  }
  static file(fsPath) {
    const normalized = path.resolve(fsPath).split(path.sep).join('/');
    return new Uri(normalized.startsWith('/') ? normalized : `/${normalized}`);
  }
  static joinPath(base, ...segments) { return new Uri(path.posix.join(base.path, ...segments)); }
}

let trusted = true;
let folders = [];
const vscodeMock = {
  Uri,
  workspace: {
    get workspaceFolders() { return folders; },
    get isTrusted() { return trusted; },
    get textDocuments() { return []; },
  },
  window: { showWarningMessage: async () => undefined },
};

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') return vscodeMock;
  return originalLoad.call(this, request, parent, isMain);
};
const host = require('../out/workspace/toolchain/host.js');
const policy = require('../out/workspace/toolchain/policy.js');
const runner = require('../out/workspace/toolchain/runner.js');
const nodeProfile = require('../out/workspace/toolchain/profiles/node.js');
const diagnostics = require('../out/workspace/toolchain/diagnostics.js');
const { WorkspaceRequestHandler } = require('../out/workspace/requestHandler.js');
Module._load = originalLoad;

const fakeNpm = path.join(os.tmpdir(), `gor-fake-npm-${process.pid}.js`);
// 模拟 npm run：依次执行 pre / 本体 / post（真实 npm 的行为），脚本本身仍经由 shell。
fs.writeFileSync(fakeNpm, `
const { execSync } = require('node:child_process');
const fs = require('node:fs');
// 模拟 npm install：只创建 node_modules，记录收到的参数，不联网。
if (process.argv[2] === 'install') {
  fs.mkdirSync('node_modules', { recursive: true });
  fs.writeFileSync('node_modules/.installed', JSON.stringify(process.argv.slice(2)));
  console.log('added 1 package');
  process.exit(0);
}
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const name = process.argv[3];
for (const script of ['pre' + name, name, 'post' + name]) {
  if (!pkg.scripts[script]) continue;
  try { execSync(pkg.scripts[script], { stdio: 'inherit' }); } catch (error) { process.exit(error.status ?? 1); }
}
`);
nodeProfile.nodeLocator.resolveNode = async () => process.execPath;
nodeProfile.nodeLocator.resolveNpmCli = async () => fakeNpm;

function workspace(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gor-toolchain-'));
  for (const [relative, content] of Object.entries(files)) {
    const file = path.join(dir, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  }
  folders = [{ name: 'app', uri: Uri.file(dir) }];
  trusted = true;
  return dir;
}

const approvals = [];
const updates = [];
let answer = async () => 'approve';
host.configureToolchainUi({
  requestApproval: async (request, signal) => { approvals.push(request); return answer(request, signal); },
  update: (update) => updates.push(update),
  output: () => undefined,
});
test.beforeEach(() => { approvals.length = 0; updates.length = 0; answer = async () => 'approve'; });

const PASS_SCRIPT = "console.log('# pass 3'); console.log('# fail 0');";
const run = (args) => host.runToolchainAction({ toolchain: 'node', approvalMode: 'review', ...args });

test('policy: untrusted rejects, write-class not enabled, review confirms every verify, auto runs allowlist only', () => {
  assert.equal(policy.decide({ risk: 'verify', allowlisted: true }, 'auto', false).status, 'workspace_untrusted');
  for (const risk of ['write', 'network', 'publish']) {
    assert.equal(policy.decide({ risk, allowlisted: true }, 'auto', true).status, 'not_enabled');
  }
  assert.equal(policy.decide({ risk: 'read', allowlisted: false }, 'review', true).kind, 'run');
  assert.equal(policy.decide({ risk: 'verify', allowlisted: true }, 'review', true).kind, 'confirm');
  assert.equal(policy.decide({ risk: 'verify', allowlisted: true }, 'auto', true).kind, 'run');
  assert.equal(policy.decide({ risk: 'verify', allowlisted: false }, 'auto', true).kind, 'confirm');
  // 缺失或未知模式一律按审阅处理
  assert.equal(policy.normalizeApprovalMode(undefined), 'review');
  assert.equal(policy.normalizeApprovalMode('anything'), 'review');
});

test('script expansion includes pre/post hooks and nested same-package scripts', () => {
  const scripts = { pretest: 'node a.js', test: 'npm run lint && node --test', posttest: 'node b.js', lint: 'eslint .', prelint: 'node c.js' };
  assert.deepEqual(nodeProfile.expandScripts(scripts, 'test').map((s) => s.name), ['pretest', 'test', 'prelint', 'lint', 'posttest']);
});

test('script content decides risk; a script named test cannot hide destructive commands', () => {
  assert.equal(nodeProfile.classifyScripts(['node --test']).risk, 'verify');
  assert.equal(nodeProfile.classifyScripts(['rm -rf src && node --test']).risk, 'write');
  assert.equal(nodeProfile.classifyScripts(['npm install && vitest']).risk, 'network');
  assert.equal(nodeProfile.classifyScripts(['npx something']).risk, 'network');
  assert.equal(nodeProfile.classifyScripts(['npm publish']).risk, 'publish');
  assert.equal(nodeProfile.classifyScripts(['eslint . --fix']).risk, 'write');
  assert.equal(nodeProfile.classifyScripts(['vite']).longRunning, true);
  assert.equal(nodeProfile.classifyScripts(['tsc -w']).longRunning, true);
  assert.equal(nodeProfile.classifyScripts(['vite build']).longRunning, false);
  assert.ok(nodeProfile.classifyScripts(['vite build']).effects.includes('会写入构建产物（如 dist/）'));
  assert.ok(!nodeProfile.classifyScripts(['tsc --noEmit']).effects.includes('会写入构建产物（如 dist/）'));
  // predev 先构建、dev 再常驻：既是常驻进程，也要提示会写构建产物
  const webDev = nodeProfile.classifyScripts(['vite build --config vite.preview-runtime.config.js', 'vite']);
  assert.equal(webDev.longRunning, true);
  assert.ok(webDev.effects.includes('会写入构建产物（如 dist/）'));
});

test('child env drops secrets; output is redacted and truncated head+tail', async () => {
  const env = runner.buildChildEnv({ PATH: '/bin', GITHUB_TOKEN: 'x', NPM_TOKEN: 'y', AWS_SECRET_ACCESS_KEY: 'z', HOME: '/h', EDITOR: 'vim' });
  assert.equal(env.PATH, '/bin');
  assert.equal(env.HOME, '/h');
  for (const key of ['GITHUB_TOKEN', 'NPM_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'EDITOR']) assert.equal(env[key], undefined);
  assert.equal(env.CI, '1');
  const redacted = runner.redactSecrets('https://user:ghp_abcdefghijklmnopqrstuvwxyz@github.com x API_KEY=abc123 Bearer abcdefghijklmnopqrstu');
  assert.ok(!redacted.includes('ghp_') && !redacted.includes('abc123') && !redacted.includes('abcdefghijklmnopqrstu'));
  const handle = runner.runProcess({
    argv: [process.execPath, '-e', "process.stdout.write('A'.repeat(60000)); process.stdout.write('END')"],
    cwd: os.tmpdir(), env: runner.buildChildEnv(process.env), timeoutMs: 20_000,
  });
  const outcome = await handle.done;
  assert.equal(outcome.exitCode, 0);
  assert.equal(outcome.stdoutTruncated, true);
  assert.ok(outcome.stdout.startsWith('AAAA') && outcome.stdout.endsWith('END') && outcome.stdout.includes('中间省略'));
});

test('runner never uses a shell: metacharacters are passed literally', async () => {
  const outcome = await runner.runProcess({
    argv: [process.execPath, '-e', 'console.log(process.argv[1])', '&& echo hacked'],
    cwd: os.tmpdir(), env: runner.buildChildEnv(process.env), timeoutMs: 20_000,
  }).done;
  assert.equal(outcome.stdout.trim(), '&& echo hacked');
});

test('runner timeout and cancel terminate the process', async () => {
  const slow = [process.execPath, '-e', 'setTimeout(() => {}, 60000)'];
  const timedOut = await runner.runProcess({ argv: slow, cwd: os.tmpdir(), env: runner.buildChildEnv(process.env), timeoutMs: 300 }).done;
  assert.equal(timedOut.timedOut, true);
  assert.equal(timedOut.exitCode, null);
  const handle = runner.runProcess({ argv: slow, cwd: os.tmpdir(), env: runner.buildChildEnv(process.env), timeoutMs: 20_000 });
  setTimeout(() => handle.cancel(), 200);
  const cancelled = await handle.done;
  assert.equal(cancelled.cancelled, true);
  assert.ok(cancelled.durationMs < 15_000);
});

test('review mode asks before every run_script, shows the real script body and hooks, then runs it', async () => {
  workspace({
    'package.json': { scripts: { pretest: 'node pre.js', test: 'node pass.js' } },
    'pre.js': "console.log('pre ran')",
    'pass.js': PASS_SCRIPT,
  });
  const result = await run({ action: 'run_script', args: { name: 'test' }, runId: 'r1', sessionId: 's1' });
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0].command, 'npm run test');
  assert.equal(approvals[0].sessionId, 's1');
  assert.deepEqual(approvals[0].scripts.map((s) => s.name), ['pretest', 'test']);
  assert.ok(approvals[0].effects.includes('将执行项目中的代码'));
  assert.equal(result.status, 'completed');
  assert.equal(result.success, true);
  assert.equal(result.approved, 'user');
  assert.ok(result.stdout.includes('pre ran'));
  assert.deepEqual([result.diagnostics.passed, result.diagnostics.failed], [3, 0]);
  assert.equal(result.summary.startsWith('3 项全部通过'), true);
  assert.deepEqual(updates.map((u) => u.status), ['awaiting_approval', 'running', 'completed']);
  // 回执不暴露宿主机绝对路径
  assert.ok(!JSON.stringify(result).includes(process.execPath));
});

test('skip, approval timeout and plan change never execute the command', async () => {
  const dir = workspace({ 'package.json': { scripts: { test: 'node mark.js' } }, 'mark.js': "require('fs').writeFileSync('ran.txt', 'x')" });
  answer = async () => 'skip';
  assert.equal((await run({ action: 'run_script', args: { name: 'test' } })).status, 'user_cancelled');
  answer = async () => 'timeout';
  assert.equal((await run({ action: 'run_script', args: { name: 'test' } })).status, 'approval_timeout');
  answer = async () => {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'node mark.js && echo changed' } }));
    return 'approve';
  };
  const changed = await run({ action: 'run_script', args: { name: 'test' } });
  assert.equal(changed.status, 'plan_changed');
  assert.equal(changed.success, false);
  assert.equal(fs.existsSync(path.join(dir, 'ran.txt')), false);
});

test('auto mode runs allowlisted verify actions without asking but still confirms custom scripts', async () => {
  workspace({
    'package.json': { devDependencies: { vitest: '1' }, scripts: { check: 'node pass.js' } },
    'pass.js': PASS_SCRIPT,
    'node_modules/vitest/vitest.mjs': "console.log('Tests  1 failed | 2 passed (3)'); console.log(' FAIL src/a.test.ts:12:3'); process.exit(1);",
  });
  const tests = await run({ approvalMode: 'auto', action: 'test' });
  assert.equal(approvals.length, 0);
  assert.equal(tests.approved, 'allowlist');
  assert.equal(tests.status, 'failed');
  assert.equal(tests.command, 'vitest run');
  assert.deepEqual([tests.diagnostics.failed, tests.diagnostics.total], [1, 3]);
  assert.equal(tests.diagnostics.items[0].file, 'src/a.test.ts');
  assert.equal(tests.summary, '3 项中失败 1 项');
  await run({ approvalMode: 'auto', action: 'run_script', args: { name: 'check' } });
  assert.equal(approvals.length, 1);
});

test('typecheck uses tsc --noEmit and lint never passes --fix', async () => {
  workspace({
    'package.json': {},
    'tsconfig.json': '{}',
    'node_modules/typescript/bin/tsc': "console.log(JSON.stringify(process.argv.slice(2))); console.log(\"src/a.ts(3,7): error TS2322: Type 'x' is not assignable.\"); console.log('Found 1 error.'); process.exit(2);",
    'node_modules/eslint/bin/eslint.js': 'console.log(JSON.stringify(process.argv.slice(2)))',
  });
  const typecheck = await run({ action: 'typecheck' });
  assert.ok(typecheck.stdout.includes('"--noEmit"'));
  assert.equal(typecheck.diagnostics.items[0].file, 'src/a.ts');
  assert.equal(typecheck.diagnostics.items[0].line, 3);
  const lint = await run({ action: 'lint', args: { path: '/src' } });
  fs.mkdirSync(path.join(folders[0].uri.fsPath, 'src'), { recursive: true });
  const lintAgain = await run({ action: 'lint', args: { path: '/src' } });
  for (const value of [lint, lintAgain]) assert.ok(!value.stdout?.includes('--fix'));
  assert.equal(lintAgain.status, 'completed');
});

test('write-class scripts and untrusted runs are refused without asking; install hidden in a dev script stays refused', async () => {
  workspace({ 'package.json': { scripts: { setup: 'npm install', clean: 'rimraf dist', dev: 'npm install && vite' } } });
  assert.equal((await run({ action: 'run_script', args: { name: 'setup' } })).status, 'not_enabled');
  assert.equal((await run({ action: 'run_script', args: { name: 'clean' } })).status, 'not_enabled');
  assert.equal((await run({ action: 'run_script', args: { name: 'dev' } })).status, 'not_enabled');
  trusted = false;
  assert.equal((await run({ action: 'run_script', args: { name: 'setup' } })).status, 'workspace_untrusted');
  assert.equal(approvals.length, 0);
});

test('working directory and targets cannot leave the workspace', async () => {
  workspace({ 'package.json': { devDependencies: { vitest: '1' } }, 'node_modules/vitest/vitest.mjs': '', 'pkg/package.json': '{}' });
  await assert.rejects(run({ action: 'test', cwd: '../outside' }), { code: 'INVALID_PATH' });
  await assert.rejects(run({ action: 'test', cwd: '/missing' }), { code: 'INVALID_PATH' });
  await assert.rejects(run({ action: 'lint', cwd: '/pkg', args: { path: '/other' } }), (error) => ['INVALID_PATH', 'TOOLCHAIN_TOOL_NOT_FOUND'].includes(error.code));
  await assert.rejects(run({ action: 'test', args: { path: 'C:/Windows' } }), { code: 'INVALID_PATH' });
  await assert.rejects(run({ action: 'rm' }), { code: 'TOOLCHAIN_ACTION_NOT_SUPPORTED' });
  await assert.rejects(host.runToolchainAction({ toolchain: 'python', action: 'test' }), { code: 'TOOLCHAIN_NOT_SUPPORTED' });
});

test('list reports scripts per package without host paths', async () => {
  workspace({ 'package.json': { name: 'root', scripts: { test: 'node --test' }, devDependencies: { typescript: '5' } }, 'packages/a/package.json': { name: 'a', scripts: { build: 'tsc' } }, 'node_modules/x/package.json': '{}' });
  const listed = await host.listToolchains({});
  const node = listed.toolchains.find((t) => t.id === 'node');
  assert.equal(node.available, true);
  assert.deepEqual(node.packages.map((p) => p.cwd), ['/', '/packages/a']);
  assert.deepEqual(node.packages[0].tools, ['typescript']);
  assert.ok(node.actions.some((a) => a.id === 'run_script'));
  assert.ok(!JSON.stringify(listed).includes(process.execPath));
});

test('toolchain requests bypass the serialized workspace queue and cancel reaches a pending approval', async () => {
  workspace({ 'package.json': { scripts: { test: 'node pass.js' } }, 'pass.js': PASS_SCRIPT });
  let release;
  answer = (_request, signal) => new Promise((resolve) => {
    release = resolve;
    signal.addEventListener('abort', () => resolve('cancelled'));
  });
  const responses = [];
  const handler = new WorkspaceRequestHandler({ appendLine: () => undefined });
  const send = (response) => { responses.push(response); return true; };
  const pending = handler.handle({ type: 'workspace_request', requestId: 'a', workspaceId: 'w', method: 'toolchain.run',
    params: { toolchain: 'node', action: 'run_script', args: { name: 'test' }, runId: 'blocked', approvalMode: 'review' } }, 'w', send);
  while (!release) await new Promise((resolve) => setTimeout(resolve, 10));
  // 审阅卡片未回答期间，普通请求仍能立即得到响应
  await handler.handle({ type: 'workspace_request', requestId: 'b', workspaceId: 'w', method: 'project.unknown', params: {} }, 'w', send);
  assert.equal(responses.find((r) => r.requestId === 'b').error.code, 'UNSUPPORTED_OPERATION');
  await handler.handle({ type: 'workspace_request', requestId: 'c', workspaceId: 'w', method: 'toolchain.cancel', params: { runId: 'blocked' } }, 'w', send);
  await pending;
  assert.equal(responses.find((r) => r.requestId === 'c').result.cancelled, true);
  assert.equal(responses.find((r) => r.requestId === 'a').result.status, 'cancelled');
});

test('cancel during execution terminates the whole process tree', async () => {
  const dir = workspace({ 'package.json': { scripts: { test: 'node sleep.js' } }, 'sleep.js': "require('fs').writeFileSync('pid.txt', String(process.pid)); setTimeout(() => {}, 60000)" });
  const started = Date.now();
  const running = run({ action: 'run_script', args: { name: 'test' }, runId: 'long' });
  while (!fs.existsSync(path.join(dir, 'pid.txt'))) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(host.cancelToolchainRun({ runId: 'long' }).cancelled, true);
  const result = await running;
  assert.equal(result.status, 'cancelled');
  assert.ok(Date.now() - started < 20_000);
  // 真正执行脚本的孙进程也必须结束
  const pid = Number(fs.readFileSync(path.join(dir, 'pid.txt'), 'utf8'));
  let alive = true;
  for (let i = 0; i < 50 && alive; i += 1) {
    try { process.kill(pid, 0); await new Promise((resolve) => setTimeout(resolve, 100)); } catch { alive = false; }
  }
  assert.equal(alive, false);
});

test('diagnostics parsers recognise jest, node --test and eslint summaries', () => {
  assert.deepEqual(
    (({ failed, passed, total }) => ({ failed, passed, total }))(diagnostics.parseTestSummary('Tests:       2 failed, 46 passed, 48 total')),
    { failed: 2, passed: 46, total: 48 });
  assert.equal(diagnostics.parseTestSummary('ℹ pass 27\nℹ fail 0').total, 27);
  const eslint = diagnostics.parseEslintOutput('/src/a.ts\n  3:5  error  Unexpected any  no-explicit-any\n\n✖ 1 problem (1 error, 0 warnings)');
  assert.equal(eslint.failed, 1);
  assert.equal(eslint.items[0].line, 3);
  assert.equal(diagnostics.parseAny('nothing recognisable'), undefined);
});

// ---- 安装依赖与后台常驻进程 ----

const DEV_SERVER = "require('fs').writeFileSync('pid.txt', String(process.pid)); console.log('  VITE ready'); console.log('  \u279c  Local:   http://localhost:5173/'); setInterval(() => {}, 1000);";

async function waitFor(check, timeoutMs = 10_000) {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function processAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

test('missing node_modules is reported, install always asks (even auto) and then the tool runs', async () => {
  const dir = workspace({ 'package.json': { devDependencies: { typescript: '5' } }, 'tsconfig.json': '{}' });
  await assert.rejects(run({ approvalMode: 'auto', action: 'typecheck' }), { code: 'DEPENDENCIES_NOT_INSTALLED' });
  const listed = await host.listToolchains({});
  assert.equal(listed.toolchains[0].packages[0].dependenciesInstalled, false);
  const installed = await run({ approvalMode: 'auto', action: 'install' });
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0].command, 'npm install');
  assert.ok(approvals[0].effects.includes('会联网下载依赖'));
  assert.equal(installed.status, 'completed');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'node_modules/.installed'), 'utf8')), ['install', '--no-audit', '--no-fund']);
  assert.equal((await host.listToolchains({})).toolchains[0].packages[0].dependenciesInstalled, true);
});

test('install is not executed when skipped or when the lock file changes during review', async () => {
  const dir = workspace({ 'package.json': {}, 'package-lock.json': '{}' });
  answer = async () => 'skip';
  assert.equal((await run({ action: 'install' })).status, 'user_cancelled');
  answer = async () => { fs.writeFileSync(path.join(dir, 'package-lock.json'), '{"changed":true}'); return 'approve'; };
  assert.equal((await run({ action: 'install' })).status, 'plan_changed');
  assert.equal(fs.existsSync(path.join(dir, 'node_modules')), false);
});

test('pnpm projects install with pnpm only when it can be located', async () => {
  workspace({ 'package.json': {}, 'pnpm-lock.yaml': '' });
  const original = nodeProfile.nodeLocator.resolvePackageManagerCli;
  try {
    nodeProfile.nodeLocator.resolvePackageManagerCli = async () => undefined;
    await assert.rejects(run({ action: 'install' }), { code: 'TOOLCHAIN_UNAVAILABLE' });
    nodeProfile.nodeLocator.resolvePackageManagerCli = async (_node, manager) => (manager === 'pnpm' ? fakeNpm : undefined);
    const result = await run({ action: 'install' });
    assert.equal(result.command, 'pnpm install');
    assert.equal(result.status, 'completed');
  } finally {
    nodeProfile.nodeLocator.resolvePackageManagerCli = original;
  }
});

test('failed runs without dependencies carry a hint to install them', async () => {
  workspace({ 'package.json': { scripts: { build: 'node build.js' } }, 'build.js': "require('vite-not-installed')" });
  const result = await run({ action: 'run_script', args: { name: 'build' } });
  assert.equal(result.status, 'failed');
  assert.equal(result.hint, 'DEPENDENCIES_NOT_INSTALLED');
  assert.match(result.summary, /可能尚未安装依赖/);
});

test('dev runs in the background after approval, reports its URL, is not started twice, and stops on 止令', async () => {
  const dir = workspace({ 'package.json': { scripts: { dev: 'node server.js' } }, 'server.js': DEV_SERVER });
  const started = await run({ approvalMode: 'auto', action: 'run_script', args: { name: 'dev' }, runId: 'dev-1', sessionId: 's1' });
  assert.equal(approvals.length, 1, '常驻进程在即刻模式下也要确认');
  assert.ok(approvals[0].effects.some((effect) => effect.includes('后台持续运行')));
  assert.equal(started.status, 'background');
  assert.equal(started.success, true);
  assert.equal(started.url, 'http://localhost:5173/');
  assert.match(started.summary, /已在后台运行/);
  const pid = Number(fs.readFileSync(path.join(dir, 'pid.txt'), 'utf8'));
  assert.equal(processAlive(pid), true);

  const again = await run({ approvalMode: 'auto', action: 'run_script', args: { name: 'dev' } });
  assert.equal(again.runId, 'dev-1');
  assert.equal(approvals.length, 1);
  const listed = await host.listToolchains({});
  assert.deepEqual(listed.backgroundProcesses.map((item) => item.runId), ['dev-1']);
  const logs = await run({ action: 'logs', args: { runId: 'dev-1' } });
  assert.match(logs.output, /localhost:5173/);

  const stopped = await run({ action: 'stop', args: { runId: 'dev-1' } });
  assert.equal(stopped.status, 'stopped');
  await waitFor(() => !processAlive(pid));
  await waitFor(() => updates.some((u) => u.runId === 'dev-1' && u.status === 'stopped'));
  assert.equal((await host.listToolchains({})).backgroundProcesses.length, 0);
  await assert.rejects(run({ action: 'stop', args: { runId: 'dev-1' } }), { code: 'RUN_NOT_FOUND' });
});

test('start scripts are background by name; a dev server that crashes on start is reported as failed', async () => {
  workspace({
    'package.json': { scripts: { start: 'node server.js', dev: 'node crash.js' } },
    'server.js': DEV_SERVER,
    'crash.js': "console.error(\"Error: Cannot find module 'vite'\"); process.exit(1);",
  });
  const crashed = await run({ action: 'run_script', args: { name: 'dev' } });
  assert.equal(crashed.status, 'failed');
  assert.equal(crashed.hint, 'DEPENDENCIES_NOT_INSTALLED');
  const started = await run({ action: 'run_script', args: { name: 'start' }, runId: 'start-1' });
  assert.equal(started.status, 'background');
  // 卡片上的「止令」走 cancelToolchainRun
  assert.equal(host.cancelToolchainRun({ runId: 'start-1' }).cancelled, true);
  await waitFor(() => updates.some((u) => u.runId === 'start-1' && u.status === 'stopped'));
});

test('extension shutdown ends every background process', async () => {
  const dir = workspace({ 'package.json': { scripts: { dev: 'node server.js' } }, 'server.js': DEV_SERVER });
  assert.equal((await run({ action: 'run_script', args: { name: 'dev' } })).status, 'background');
  const pid = Number(fs.readFileSync(path.join(dir, 'pid.txt'), 'utf8'));
  host.disposeToolchainProcesses();
  await waitFor(() => !processAlive(pid));
});

test('local URL detection ignores colors and normalises 0.0.0.0', () => {
  assert.equal(host.detectLocalUrl('\u001b[32m  Local: http://0.0.0.0:3000/\u001b[0m'), 'http://localhost:3000/');
  assert.equal(host.detectLocalUrl('see https://example.com:8080'), undefined);
});

test('chat panel opens only local dev-server URLs without credentials', () => {
  Module._load = function (request, parent, isMain) {
    if (request === 'vscode') return vscodeMock;
    return originalLoad.call(this, request, parent, isMain);
  };
  const { isLocalDevUrl } = require('../out/chatPanel.js');
  Module._load = originalLoad;
  assert.equal(isLocalDevUrl('http://localhost:5173/'), true);
  assert.equal(isLocalDevUrl('http://127.0.0.1:3000/app'), true);
  for (const url of ['https://example.com', 'http://user:pw@localhost:5173', 'file:///C:/x', 'javascript:alert(1)', 'not a url']) {
    assert.equal(isLocalDevUrl(url), false, url);
  }
});
