import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { normalizeWorkspaceRelativePath, toWorkspaceUri, WorkspaceRequestError } from '../../paths';
import { parseAny, parseEslintOutput, parseTestSummary, parseTscOutput } from '../diagnostics';
import { mergeWarnings, scanFiles, scanText, scriptEntryFiles, type RiskLevel, type RiskWarning } from '../risk';
import type { ActionContext, ActionSpec, ExecPlan, Params, ToolchainEnv, ToolchainProfile } from '../types';

/**
 * Node 工具链。
 * 不经过 shell：npm 通过 node + npm-cli.js 启动，tsc / eslint / vitest / jest 直接用项目里的入口文件。
 */

export const NODE_TIMEOUT_MS = 10 * 60 * 1000;
const EXCLUDED_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', 'out', 'vendor', '.next', '.nuxt', '.turbo', '.cache']);
const MAX_PACKAGES = 30;
const MAX_SCRIPT_CHARS = 2_000;

type PackageJson = {
  name?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  packageManager?: string;
};

export type NodeEnv = ToolchainEnv & { node?: string; npmCli?: string; packageManager?: string };

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function pathEntries(): string[] {
  const key = Object.keys(process.env).find((name) => name.toLowerCase() === 'path');
  return (key ? process.env[key] ?? '' : '').split(path.delimiter).filter(Boolean);
}

/** 在 PATH 中查找 node 可执行文件（不通过 shell，也不执行 PATH 中的其他程序）。 */
export async function resolveNode(): Promise<string | undefined> {
  const names = process.platform === 'win32' ? ['node.exe'] : ['node'];
  for (const dir of pathEntries()) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (await exists(candidate)) return candidate;
    }
  }
  return undefined;
}

async function resolveNpmCli(node: string): Promise<string | undefined> {
  const dir = path.dirname(node);
  for (const candidate of [
    path.join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(dir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ]) {
    if (await exists(candidate)) return candidate;
  }
  return undefined;
}

/** pnpm / yarn 的 JS 入口：全局安装或 corepack 自带的分发脚本，都用同一个 node 启动。 */
async function resolvePackageManagerCli(node: string, manager: 'pnpm' | 'yarn'): Promise<string | undefined> {
  const dir = path.dirname(node);
  const entry = manager === 'pnpm' ? path.join('pnpm', 'bin', 'pnpm.cjs') : path.join('yarn', 'bin', 'yarn.js');
  const roots = [path.join(dir, 'node_modules'), path.join(dir, '..', 'lib', 'node_modules')];
  if (process.platform === 'win32' && process.env.APPDATA) roots.push(path.join(process.env.APPDATA, 'npm', 'node_modules'));
  for (const root of roots) {
    for (const candidate of [path.join(root, entry), path.join(root, 'corepack', 'dist', `${manager}.js`)]) {
      if (await exists(candidate)) return candidate;
    }
  }
  return undefined;
}

// 定位集中在这里，测试可替换；扩展只执行这里找到的 node 与包管理器入口。
export const nodeLocator = { resolveNode, resolveNpmCli, resolvePackageManagerCli };

function requireLocalFolder(root: vscode.WorkspaceFolder): void {
  if (root.uri.scheme !== 'file') {
    throw new WorkspaceRequestError('TOOLCHAIN_UNAVAILABLE', '工具链目前只支持本地文件工作区。');
  }
}

async function readPackage(dir: string): Promise<{ data: PackageJson; text: string } | undefined> {
  let text: string;
  try {
    text = await fs.readFile(path.join(dir, 'package.json'), 'utf8');
  } catch {
    return undefined;
  }
  try {
    const data = JSON.parse(text);
    return data && typeof data === 'object' ? { data, text } : undefined;
  } catch {
    throw new WorkspaceRequestError('TOOLCHAIN_CONFIG_INVALID', 'package.json 不是有效的 JSON。');
  }
}

async function detectPackageManager(rootDir: string, cwdDir: string, pkg?: PackageJson): Promise<string> {
  const declared = pkg?.packageManager?.split('@')[0];
  if (declared && ['npm', 'pnpm', 'yarn', 'bun'].includes(declared)) return declared;
  for (let dir = cwdDir; dir.startsWith(rootDir); dir = path.dirname(dir)) {
    if (await exists(path.join(dir, 'pnpm-lock.yaml'))) return 'pnpm';
    if (await exists(path.join(dir, 'yarn.lock'))) return 'yarn';
    if (await exists(path.join(dir, 'bun.lockb'))) return 'bun';
    if (await exists(path.join(dir, 'package-lock.json'))) return 'npm';
    if (dir === rootDir || path.dirname(dir) === dir) break;
  }
  return 'npm';
}

/** 自 cwd 向上（不超出工作区根）查找依赖入口，兼容 monorepo 依赖提升。 */
async function findPackageFile(rootDir: string, cwdDir: string, relative: string): Promise<string | undefined> {
  for (let dir = cwdDir; ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, 'node_modules', relative);
    if (await exists(candidate)) return candidate;
    if (dir === rootDir || !dir.startsWith(rootDir) || path.dirname(dir) === dir) return undefined;
  }
}

/** cwd 或其上级（不超出工作区根）是否已有 node_modules。 */
async function hasNodeModules(rootDir: string, cwdDir: string): Promise<boolean> {
  for (let dir = cwdDir; ; dir = path.dirname(dir)) {
    if (await exists(path.join(dir, 'node_modules'))) return true;
    if (dir === rootDir || !dir.startsWith(rootDir) || path.dirname(dir) === dir) return false;
  }
}

const LONG_RUNNING = /(?:--watch\b|\bwatch\b|\bserve\b|\bnodemon\b|webpack-dev-server|\b(?:next|nuxt|nuxi|astro|remix|vitepress|docusaurus|gatsby)\s+dev\b|\breact-scripts\s+start\b|\bexpo\s+start\b|\bhttp-server\b|\blive-server\b|(?:^|[\s;&|])vite(?:\s*$|\s+(?!build\b)(?:--|\.|preview\b)|\s*[;&|])|\btsc\b[^;&|]*\s-w\b)/i;
// 这些脚本名约定俗成就是常驻进程，即使内容是 node server.js 之类看不出来的命令。
const LONG_RUNNING_NAME = /^(?:dev|start|serve|preview|watch)(?::|$)/;
// R4：会覆盖远端历史。
const FORCE_PUSH = /\bgit\s+push\b[^;&|\n]*(?:\s--force(?:-with-lease)?\b|\s-f\b)/i;
// R2：删除文件、丢弃未提交的改动、发布（发出去收不回）。
const DELETE = /(?:(?:^|[\s;&|])(?:rm|rmdir|del|erase|rd)\s|\brimraf\b|\bdel-cli\b|\bshx\s+rm\b|\bgit\s+(?:clean\b|reset\s+--hard\b|checkout\s+--\s|restore\s)|Remove-Item\b)/i;
const PUBLISH = /(?:\b(?:npm|pnpm|yarn)\s+(?:publish|deprecate|unpublish|dist-tag)\b|\bvsce\s+publish\b|\bdocker\s+push\b)/i;
const NETWORK = /(?:\b(?:npm|pnpm|yarn|bun)\s+(?:i|install|add|ci|update|upgrade|up|dlx|create|init|exec)\b|\bnpx\b|\bcurl\b|\bwget\b|\bscp\b|\bssh\b)/i;
const GIT_WRITE = /\bgit\s+(?:push|commit|tag|merge|rebase|stash|checkout|switch)\b/i;
const BUILD = /(?:\bbuild\b|\bvite\s+build\b|\bwebpack\b|\brollup\b|\besbuild\b|\bbabel\b|\bparcel\b|\btsup\b|\bswc\b|\btsc\b(?![^;&|]*--noEmit))/i;
const NESTED = /\b(?:npm\s+(?:run(?:-script)?\s+|(?=test\b|start\b))|pnpm\s+(?:run\s+)?|yarn\s+(?:run\s+)?|bun\s+run\s+)([\w:.@/-]+)/g;
const PM_SUBCOMMANDS = new Set(['install', 'i', 'add', 'remove', 'ci', 'exec', 'dlx', 'publish', 'run', 'run-script', 'test', 'start', 'init', 'create', 'link', 'pack', 'version', 'update', 'up', 'why', 'list', 'ls']);

/** 展开要执行的脚本：pre/post 钩子与脚本内部调用的同包脚本（最多 4 层）。 */
export function expandScripts(scripts: Record<string, string>, name: string): Array<{ name: string; body: string }> {
  const ordered: Array<{ name: string; body: string }> = [];
  const visit = (script: string, depth: number) => {
    if (depth > 4 || ordered.some((item) => item.name === script)) return;
    for (const candidate of [`pre${script}`, script, `post${script}`]) {
      const body = scripts[candidate];
      if (typeof body !== 'string' || ordered.some((item) => item.name === candidate)) continue;
      ordered.push({ name: candidate, body });
      for (const match of body.matchAll(NESTED)) {
        const nested = match[1];
        if (!PM_SUBCOMMANDS.has(nested) || nested === 'test' || nested === 'start') {
          if (typeof scripts[nested] === 'string') visit(nested, depth + 1);
        }
      }
    }
  };
  visit(name, 0);
  return ordered;
}

/**
 * 按脚本实际内容定级：强制推送 R4；删除、丢弃改动、发布 R2；其余 R1。
 * 这是文本匹配的提示，不是安全边界——脚本调用的 JS 文件里做了什么看不出来。
 */
export function classifyScripts(bodies: string[]): { level: RiskLevel; effects: string[]; longRunning: boolean; rejectReason?: string } {
  const text = bodies.join('\n');
  const effects = ['将执行项目中的代码'];
  if (NETWORK.test(text)) effects.push('会联网');
  if (DELETE.test(text)) effects.push('会删除文件或丢弃未提交的改动');
  if (PUBLISH.test(text)) effects.push('会对外发布，发出后无法收回');
  if (GIT_WRITE.test(text)) effects.push('会修改 Git 仓库');
  // 常驻脚本的 pre 钩子也可能先构建（如 predev: vite build），提示同样要写出来。
  if (BUILD.test(text)) effects.push('会写入构建产物（如 dist/）');
  const longRunning = LONG_RUNNING.test(text);
  if (FORCE_PUSH.test(text)) {
    return { level: 4, effects, longRunning, rejectReason: '脚本包含强制推送（git push --force），可能覆盖他人的提交，Gor 不会执行。' };
  }
  if (DELETE.test(text) || PUBLISH.test(text)) return { level: 2, effects, longRunning };
  return { level: 1, effects, longRunning };
}

/** 扫描将执行的脚本内容，以及脚本直接调用的本地 JS/TS 入口文件。 */
async function scanScripts(scripts: Array<{ name: string; body: string }>, cwdDir: string): Promise<RiskWarning[]> {
  const warnings = scripts.flatMap((script) => scanText(script.body, `scripts.${script.name}`));
  const entries = scripts.flatMap((script) => scriptEntryFiles(script.body, cwdDir));
  warnings.push(...await scanFiles(entries, cwdDir));
  return mergeWarnings(warnings);
}

function hash(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function nodeEnv(context: ActionContext): { node: string; npmCli?: string } {
  const env = context.env as NodeEnv;
  if (!env.available || !env.node) {
    throw new WorkspaceRequestError('TOOLCHAIN_UNAVAILABLE', env.reason ?? '未找到 Node.js，请确认已安装并在 PATH 中。');
  }
  return { node: env.node, npmCli: env.npmCli };
}

function rootDirOf(context: ActionContext): string {
  return path.resolve(context.root.uri.fsPath);
}

function cwdDirOf(context: ActionContext): string {
  return path.resolve(context.cwdUri.fsPath);
}

/** 测试/检查目标：工作区相对路径，必须位于 cwd 之内。 */
function targetPath(value: unknown, context: ActionContext): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const normalized = normalizeWorkspaceRelativePath(value);
  const absolute = path.resolve(toWorkspaceUri(normalized, context.root).fsPath);
  const cwd = cwdDirOf(context);
  if (absolute !== cwd && !absolute.startsWith(cwd + path.sep)) {
    throw new WorkspaceRequestError('INVALID_PATH', '目标路径必须位于命令的工作目录之内。');
  }
  return path.relative(cwd, absolute) || '.';
}

async function packageFingerprint(context: ActionContext): Promise<string> {
  const pkg = await readPackage(cwdDirOf(context));
  return hash(pkg?.text ?? '');
}

async function scriptPlan(name: string, context: ActionContext, allowKey = `node:run_script:${name}`, testOutput = false): Promise<ExecPlan> {
  const { node, npmCli } = nodeEnv(context);
  const cwdDir = cwdDirOf(context);
  const pkg = await readPackage(cwdDir);
  const scripts = pkg?.data.scripts ?? {};
  if (typeof scripts[name] !== 'string') {
    throw new WorkspaceRequestError('TOOLCHAIN_SCRIPT_NOT_FOUND', `package.json 中没有名为 ${name} 的脚本。`);
  }
  if (!npmCli) {
    throw new WorkspaceRequestError('TOOLCHAIN_UNAVAILABLE', '未找到 npm（npm-cli.js），无法运行 package.json 脚本。');
  }
  const expanded = expandScripts(scripts, name);
  const classified = classifyScripts(expanded.map((item) => item.body));
  const { level, effects } = classified;
  // 常驻进程（dev server / watch）就绪后先返回，进程继续在后台运行。
  const background = level < 4 && (classified.longRunning || LONG_RUNNING_NAME.test(name));
  if (background) effects.push('会在后台持续运行，直到你止令或关闭 VS Code');
  const signature = hash(JSON.stringify(expanded));
  return {
    kind: 'command',
    argv: [node, npmCli, 'run', name],
    cwd: context.cwd,
    cwdUri: context.cwdUri,
    timeoutMs: background ? 0 : NODE_TIMEOUT_MS,
    level,
    allowKey,
    warnings: await scanScripts(expanded, cwdDir),
    rejectReason: classified.rejectReason,
    ...(background ? { background: true } : {}),
    dependenciesInstalled: await hasNodeModules(rootDirOf(context), cwdDir),
    display: {
      command: `npm run ${name}`,
      scripts: expanded.map((item) => ({ name: item.name, body: item.body.slice(0, MAX_SCRIPT_CHARS) })),
      scriptSource: `${context.cwd === '/' ? '' : context.cwd.slice(1) + '/'}package.json › scripts.${name}`,
      effects,
    },
    fingerprint: async () => {
      const latest = await readPackage(cwdDir);
      return hash(JSON.stringify(expandScripts(latest?.data.scripts ?? {}, name))) === signature ? signature : 'changed';
    },
    parse: ({ stdout, stderr }) => (testOutput ? parseTestSummary(stdout + '\n' + stderr) : undefined) ?? parseAny(stdout + '\n' + stderr),
  };
}

async function binaryPlan(context: ActionContext, options: {
  relative: string; args: string[]; command: string; label: string; allowKey: string;
  parse: (text: string) => ReturnType<typeof parseAny>;
}): Promise<ExecPlan> {
  const { node } = nodeEnv(context);
  const entry = await findPackageFile(rootDirOf(context), cwdDirOf(context), options.relative);
  if (!entry) {
    if (!await hasNodeModules(rootDirOf(context), cwdDirOf(context))) {
      throw new WorkspaceRequestError('DEPENDENCIES_NOT_INSTALLED', '尚未安装依赖（没有找到 node_modules），可先用 install 动作安装依赖。');
    }
    throw new WorkspaceRequestError('TOOLCHAIN_TOOL_NOT_FOUND', `当前目录没有安装 ${options.label}（未找到 node_modules/${options.relative}）。`);
  }
  return {
    kind: 'command',
    argv: [node, entry, ...options.args],
    cwd: context.cwd,
    cwdUri: context.cwdUri,
    timeoutMs: NODE_TIMEOUT_MS,
    level: 1,
    allowKey: options.allowKey,
    dependenciesInstalled: true,
    display: { command: options.command, effects: ['将执行项目中的代码'] },
    fingerprint: () => packageFingerprint(context),
    parse: ({ stdout, stderr }) => options.parse(stdout + '\n' + stderr),
  };
}

const envAction: ActionSpec = {
  id: 'env',
  level: 0,
  description: '查看 Node 版本',
  async plan(_params, context) {
    const { node } = nodeEnv(context);
    return {
      kind: 'command', argv: [node, '--version'], cwd: context.cwd, cwdUri: context.cwdUri, timeoutMs: 15_000,
      level: 0, allowKey: 'node:env', display: { command: 'node --version', effects: [] },
      fingerprint: async () => 'static',
    };
  },
};

const INSTALL_EFFECTS = ['会联网下载依赖', '会写入 node_modules，并可能更新 lock 文件', '会执行依赖包自带的安装脚本'];
const LOCKFILES = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock'];
// npm install 会顺带执行项目自身的这些生命周期脚本。
const INSTALL_LIFECYCLE = ['preinstall', 'install', 'postinstall', 'prepare'];

const installAction: ActionSpec = {
  id: 'install',
  level: 1,
  description: '按 package.json 与 lock 文件安装依赖（联网、写入 node_modules）',
  async plan(_params, context) {
    const { node, npmCli } = nodeEnv(context);
    const rootDir = rootDirOf(context);
    const cwdDir = cwdDirOf(context);
    const pkg = await readPackage(cwdDir);
    if (!pkg) throw new WorkspaceRequestError('TOOLCHAIN_CONFIG_NOT_FOUND', '工作目录中没有 package.json。');
    const manager = await detectPackageManager(rootDir, cwdDir, pkg.data);
    let argv: string[];
    if (manager === 'npm') {
      if (!npmCli) throw new WorkspaceRequestError('TOOLCHAIN_UNAVAILABLE', '未找到 npm（npm-cli.js），无法安装依赖。');
      argv = [node, npmCli, 'install', '--no-audit', '--no-fund'];
    } else if (manager === 'pnpm' || manager === 'yarn') {
      const cli = await nodeLocator.resolvePackageManagerCli(node, manager);
      if (!cli) {
        throw new WorkspaceRequestError('TOOLCHAIN_UNAVAILABLE',
          `项目使用 ${manager}，但没有找到 ${manager}（全局安装或 corepack）。请先安装 ${manager}，或在终端手动执行 ${manager} install。`);
      }
      argv = [node, cli, 'install'];
    } else {
      throw new WorkspaceRequestError('TOOLCHAIN_UNAVAILABLE', `暂不支持用 ${manager} 安装依赖，请在终端手动执行。`);
    }
    const lifecycle = INSTALL_LIFECYCLE
      .filter((name) => typeof pkg.data.scripts?.[name] === 'string')
      .map((name) => ({ name, body: pkg.data.scripts![name] }));
    // 包清单或 lock 文件在确认期间被改动，就不按旧内容安装。
    const fingerprint = async () => {
      const parts = [(await readPackage(cwdDir))?.text ?? ''];
      for (const name of LOCKFILES) parts.push(await fs.readFile(path.join(cwdDir, name), 'utf8').catch(() => ''));
      return hash(parts.join('\0'));
    };
    return {
      kind: 'command', argv, cwd: context.cwd, cwdUri: context.cwdUri, timeoutMs: NODE_TIMEOUT_MS,
      level: 1, allowKey: 'node:install', warnings: await scanScripts(lifecycle, cwdDir),
      display: {
        command: `${manager} install`,
        ...(lifecycle.length ? { scripts: lifecycle, scriptSource: '安装时会执行的项目脚本' } : {}),
        effects: INSTALL_EFFECTS,
      },
      fingerprint,
    };
  },
};

const runScriptAction: ActionSpec = {
  id: 'run_script',
  level: 1,
  description: '运行 package.json 中的脚本（按脚本实际内容定级；dev / start / watch 等常驻进程在后台运行）',
  plan(params, context) {
    const name = typeof params.name === 'string' ? params.name.trim() : '';
    if (!name || name.length > 100 || !/^[\w:.@/-]+$/.test(name)) {
      throw new WorkspaceRequestError('INVALID_PARAMS', 'name 必须是 package.json 中的脚本名。');
    }
    return scriptPlan(name, context);
  },
};

const typecheckAction: ActionSpec = {
  id: 'typecheck',
  level: 1,
  description: 'TypeScript 类型检查（tsc --noEmit，不写文件）',
  async plan(_params, context) {
    if (!await exists(path.join(cwdDirOf(context), 'tsconfig.json'))) {
      throw new WorkspaceRequestError('TOOLCHAIN_CONFIG_NOT_FOUND', '工作目录中没有 tsconfig.json。');
    }
    return binaryPlan(context, {
      relative: path.join('typescript', 'bin', 'tsc'), args: ['--noEmit', '--pretty', 'false'],
      command: 'tsc --noEmit', label: 'TypeScript', allowKey: 'node:typecheck', parse: parseTscOutput,
    });
  },
};

const testAction: ActionSpec = {
  id: 'test',
  level: 1,
  description: '运行测试（vitest / jest 用非 watch 模式；否则运行 scripts.test）',
  async plan(params, context) {
    const target = targetPath(params.path, context);
    const rootDir = rootDirOf(context);
    const cwdDir = cwdDirOf(context);
    const pkg = (await readPackage(cwdDir))?.data;
    const deps = { ...pkg?.dependencies, ...pkg?.devDependencies };
    if (deps.vitest && await findPackageFile(rootDir, cwdDir, path.join('vitest', 'vitest.mjs'))) {
      return binaryPlan(context, {
        relative: path.join('vitest', 'vitest.mjs'), args: ['run', ...(target ? [target] : [])],
        command: `vitest run${target ? ' ' + target : ''}`, label: 'vitest', allowKey: 'node:test', parse: parseTestSummary,
      });
    }
    if (deps.jest && await findPackageFile(rootDir, cwdDir, path.join('jest', 'bin', 'jest.js'))) {
      return binaryPlan(context, {
        relative: path.join('jest', 'bin', 'jest.js'), args: ['--ci', '--watchAll=false', ...(target ? [target] : [])],
        command: `jest --ci${target ? ' ' + target : ''}`, label: 'jest', allowKey: 'node:test', parse: parseTestSummary,
      });
    }
    if (target) {
      throw new WorkspaceRequestError('INVALID_PARAMS', '未识别到 vitest / jest，无法只运行指定测试文件；可去掉 path 运行全部测试。');
    }
    if (typeof pkg?.scripts?.test === 'string') return scriptPlan('test', context, 'node:test', true);
    throw new WorkspaceRequestError('TOOLCHAIN_TOOL_NOT_FOUND', '没有找到测试框架，package.json 也没有 test 脚本。');
  },
};

const lintAction: ActionSpec = {
  id: 'lint',
  level: 1,
  description: 'ESLint 检查（不带 --fix，不改文件）',
  async plan(params, context) {
    const target = targetPath(params.path, context) ?? '.';
    return binaryPlan(context, {
      relative: path.join('eslint', 'bin', 'eslint.js'), args: [target],
      command: `eslint ${target}`, label: 'ESLint', allowKey: 'node:lint', parse: parseEslintOutput,
    });
  },
};

async function listPackages(rootDir: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string, depth: number) => {
    if (found.length >= MAX_PACKAGES || depth > 3) return;
    if (await exists(path.join(dir, 'package.json'))) found.push(dir);
    let entries: Array<import('node:fs').Dirent>;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || EXCLUDED_DIRS.has(entry.name.toLowerCase())) continue;
      await walk(path.join(dir, entry.name), depth + 1);
    }
  };
  await walk(rootDir, 0);
  return found;
}

function workspaceRelativeDir(rootDir: string, dir: string): string {
  const relative = path.relative(rootDir, dir).split(path.sep).join('/');
  return relative ? `/${relative}` : '/';
}

export const nodeProfile: ToolchainProfile = {
  id: 'node',
  async detect(root) {
    requireLocalFolder(root);
    const node = await nodeLocator.resolveNode();
    if (!node) return { available: false, reason: '未找到 Node.js，请确认已安装并在 PATH 中。' };
    const npmCli = await nodeLocator.resolveNpmCli(node);
    return { available: true, node, npmCli, ...(npmCli ? {} : { npmReason: '未找到 npm' }) } as NodeEnv;
  },
  async describe(root, env) {
    const rootDir = path.resolve(root.uri.fsPath);
    const packages = [];
    for (const dir of await listPackages(rootDir)) {
      const pkg = await readPackage(dir).catch(() => undefined);
      if (!pkg) continue;
      const deps = { ...pkg.data.dependencies, ...pkg.data.devDependencies };
      packages.push({
        cwd: workspaceRelativeDir(rootDir, dir),
        name: typeof pkg.data.name === 'string' ? pkg.data.name : undefined,
        packageManager: await detectPackageManager(rootDir, dir, pkg.data),
        scripts: Object.fromEntries(Object.entries(pkg.data.scripts ?? {})
          .filter(([, body]) => typeof body === 'string')
          .map(([name, body]) => [name, body.slice(0, 300)])),
        tools: ['typescript', 'eslint', 'vitest', 'jest'].filter((name) => name in deps),
        dependenciesInstalled: await hasNodeModules(rootDir, dir),
      });
    }
    return { available: env.available, reason: env.reason, packages, packagesTruncated: packages.length >= MAX_PACKAGES };
  },
  actions: [envAction, installAction, runScriptAction, typecheckAction, testAction, lintAction],
};
