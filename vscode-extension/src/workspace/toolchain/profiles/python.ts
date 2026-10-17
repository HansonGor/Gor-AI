import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { normalizeWorkspaceRelativePath, toWorkspaceUri, WorkspaceRequestError } from '../../paths';
import { parsePythonCheckOutput, parsePytestSummary, parseUnittestSummary } from '../diagnostics';
import { mergeWarnings, scanFiles, type RiskLevel } from '../risk';
import { buildChildEnv, currentPath } from '../runner';
import type { ActionContext, ActionSpec, Diagnostics, ExecPlan, Params, ToolchainEnv, ToolchainProfile } from '../types';

/**
 * Python 工具链：开放程度与 Node 一致（R0–R4 同一套分级）。
 * 解释器优先级：VS Code Python 扩展选中的解释器 → 项目里的虚拟环境 → PATH（Windows 用 py -3，跳过微软商店占位程序）。
 * 不经过 shell：都以「解释器 -m 模块」或「解释器 文件」的参数数组启动；只往虚拟环境里装依赖，只按项目清单安装。
 */

export const PYTHON_TIMEOUT_MS = 10 * 60 * 1000;
const PROBE_TIMEOUT_MS = 15_000;
const EXCLUDED_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', 'out', 'vendor', '.venv', 'venv', 'env',
  '__pycache__', '.mypy_cache', '.pytest_cache', '.ruff_cache', '.tox', '.nox', 'site-packages']);
const PROJECT_MARKERS = ['pyproject.toml', 'requirements.txt', 'setup.py', 'setup.cfg', 'Pipfile', 'manage.py'];
const MANIFESTS = ['pyproject.toml', 'requirements.txt', 'requirements-dev.txt', 'setup.py', 'setup.cfg', 'uv.lock', 'poetry.lock', 'Pipfile.lock'];
const VENV_DIRS = ['.venv', 'venv', 'env'];
const PROBED_MODULES = ['pytest', 'ruff', 'flake8', 'mypy', 'pyright', 'black'];
const MAX_PROJECTS = 30;
const MAX_ARGS = 20;

export type PythonProbe = { executable: string; version: string; inVenv: boolean; modules: Record<string, boolean> };
export type PythonEnv = ToolchainEnv & {
  /** 实际执行用的解释器（绝对路径，不进入回执）。 */
  python?: string;
  /** 给用户看的说明，例如「.venv（Python 3.12.4）」。 */
  label?: string;
  source?: 'extension' | 'project' | 'path';
  inVenv?: boolean;
  modules?: Record<string, boolean>;
};

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function isStoreStub(file: string): boolean {
  return /[\\/]WindowsApps[\\/]/i.test(file);
}

function venvPython(dir: string): string {
  return process.platform === 'win32' ? path.join(dir, 'Scripts', 'python.exe') : path.join(dir, 'bin', 'python');
}

/** VS Code Python 扩展为这个工作区选中的解释器；扩展未安装或 5 秒内未就绪时返回 undefined。 */
async function fromExtension(root: vscode.WorkspaceFolder): Promise<string | undefined> {
  const extension = vscode.extensions?.getExtension?.<Record<string, any>>('ms-python.python');
  if (!extension) return undefined;
  try {
    const exports = extension.isActive ? extension.exports : await Promise.race([
      extension.activate(), new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 5_000)),
    ]);
    if (!exports) return undefined;
    const active = await exports.environments?.getActiveEnvironmentPath?.(root.uri);
    const candidate = typeof active?.path === 'string' ? active.path
      : exports.settings?.getExecutionDetails?.(root.uri)?.execCommand?.[0];
    if (typeof candidate !== 'string' || !candidate) return undefined;
    // 有的环境给出的是目录（venv / conda 前缀），换成其中的解释器。
    if (await exists(candidate) && (await fs.stat(candidate)).isDirectory()) {
      for (const file of [venvPython(candidate), path.join(candidate, 'python.exe'), path.join(candidate, 'bin', 'python')]) {
        if (await exists(file)) return file;
      }
      return undefined;
    }
    return await exists(candidate) && !isStoreStub(candidate) ? candidate : undefined;
  } catch {
    return undefined;
  }
}

/** 项目里的虚拟环境：自工作目录向上（不超出工作区根）查找 .venv / venv / env。 */
async function fromProjectVenv(rootDir: string, cwdDir: string): Promise<string | undefined> {
  for (let dir = cwdDir; ; dir = path.dirname(dir)) {
    for (const name of VENV_DIRS) {
      const candidate = venvPython(path.join(dir, name));
      if (await exists(candidate)) return candidate;
    }
    if (dir === rootDir || !dir.startsWith(rootDir) || path.dirname(dir) === dir) return undefined;
  }
}

/** PATH 中的 Python：Windows 优先 py 启动器（交给 probe 解析成真实解释器），跳过微软商店占位程序。 */
async function fromPath(): Promise<string[] | undefined> {
  const dirs = currentPath().split(path.delimiter).filter(Boolean);
  const names = process.platform === 'win32' ? ['py.exe', 'python.exe', 'python3.exe'] : ['python3', 'python'];
  for (const name of names) {
    for (const dir of dirs) {
      const candidate = path.join(dir, name);
      if (isStoreStub(candidate) || !await exists(candidate)) continue;
      return name === 'py.exe' ? [candidate, '-3'] : [candidate];
    }
  }
  return undefined;
}

const PROBE_SCRIPT = [
  'import importlib.util, json, sys',
  `mods = ${JSON.stringify(PROBED_MODULES)}`,
  'print(json.dumps({"executable": sys.executable, "version": sys.version.split()[0],',
  '  "inVenv": sys.prefix != getattr(sys, "base_prefix", sys.prefix) or __import__("os").path.isdir(__import__("os").path.join(sys.prefix, "conda-meta")),',
  '  "modules": {m: importlib.util.find_spec(m) is not None for m in mods}}))',
].join('\n');

/** 问解释器自己：真实路径、版本、是否在虚拟环境、装了哪些工具（只查找模块，不导入执行）。 */
async function probe(command: string[]): Promise<PythonProbe | undefined> {
  return new Promise((resolve) => {
    execFile(command[0], [...command.slice(1), '-c', PROBE_SCRIPT], {
      timeout: PROBE_TIMEOUT_MS, windowsHide: true, env: buildChildEnv(process.env, { PYTHONUTF8: '1' }),
    }, (error, stdout) => {
      if (error) return resolve(undefined);
      try {
        const data = JSON.parse(stdout.trim().split(/\r?\n/).pop() ?? '');
        if (typeof data.executable !== 'string' || !data.executable) return resolve(undefined);
        resolve({ executable: data.executable, version: String(data.version ?? ''), inVenv: data.inVenv === true, modules: data.modules ?? {} });
      } catch {
        resolve(undefined);
      }
    });
  });
}

// 定位集中在这里，测试可替换；扩展只执行这里找到的解释器。
export const pythonLocator = { fromExtension, fromProjectVenv, fromPath, probe };

function requireLocalFolder(root: vscode.WorkspaceFolder): void {
  if (root.uri.scheme !== 'file') {
    throw new WorkspaceRequestError('TOOLCHAIN_UNAVAILABLE', '工具链目前只支持本地文件工作区。');
  }
}

/** 按优先级找到解释器并探测；label 只描述来源和版本，不含本机路径。 */
export async function resolvePython(root: vscode.WorkspaceFolder, cwdDir?: string): Promise<PythonEnv> {
  requireLocalFolder(root);
  const rootDir = path.resolve(root.uri.fsPath);
  const candidates: Array<{ command: string[]; source: PythonEnv['source'] }> = [];
  const selected = await pythonLocator.fromExtension(root);
  if (selected) candidates.push({ command: [selected], source: 'extension' });
  const venv = await pythonLocator.fromProjectVenv(rootDir, cwdDir ?? rootDir);
  if (venv) candidates.push({ command: [venv], source: 'project' });
  const onPath = await pythonLocator.fromPath();
  if (onPath) candidates.push({ command: onPath, source: 'path' });
  for (const candidate of candidates) {
    const info = await pythonLocator.probe(candidate.command);
    if (!info) continue;
    const where = info.inVenv
      ? (info.executable.startsWith(rootDir) ? path.basename(path.dirname(path.dirname(info.executable))) : '虚拟环境')
      : '系统 Python';
    const from = candidate.source === 'extension' ? 'VS Code 选中的' : '';
    return {
      available: true, python: info.executable, version: info.version, inVenv: info.inVenv, modules: info.modules,
      source: candidate.source, label: `${from}${where}（Python ${info.version}）`,
    };
  }
  return { available: false, reason: '没有找到可用的 Python：请安装 Python，或在 VS Code 中选择解释器。' };
}

function pythonEnv(context: ActionContext): PythonEnv & { python: string } {
  const env = context.env as PythonEnv;
  if (!env.available || !env.python) {
    throw new WorkspaceRequestError('TOOLCHAIN_UNAVAILABLE', env.reason ?? '没有找到可用的 Python。');
  }
  return env as PythonEnv & { python: string };
}

function cwdDirOf(context: ActionContext): string {
  return path.resolve(context.cwdUri.fsPath);
}

function hash(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** 子进程环境：UTF-8 输出；用虚拟环境时设置 VIRTUAL_ENV 并把它的脚本目录放到 PATH 最前面。 */
function childEnv(env: PythonEnv & { python: string }): Record<string, string> {
  // 不缓冲输出：管道下 Python 默认整块缓冲，常驻服务打印的访问地址会迟迟收不到。
  const extra: Record<string, string> = { PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' };
  if (env.inVenv) {
    const binDir = path.dirname(env.python);
    extra.VIRTUAL_ENV = path.dirname(binDir);
    extra.PATH = [binDir, currentPath()].filter(Boolean).join(path.delimiter);
  }
  return extra;
}

/** 工作区内的目标路径，返回相对 cwd 的写法（参数里不出现本机绝对路径）。 */
function targetPath(value: unknown, context: ActionContext, mustBePy = false): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const normalized = normalizeWorkspaceRelativePath(value);
  if (mustBePy && !/\.pyw?$/i.test(normalized)) throw new WorkspaceRequestError('INVALID_PARAMS', 'file 必须是工作区内的 .py 文件。');
  const absolute = path.resolve(toWorkspaceUri(normalized, context.root).fsPath);
  const cwd = cwdDirOf(context);
  if (absolute !== cwd && !absolute.startsWith(cwd + path.sep)) {
    throw new WorkspaceRequestError('INVALID_PATH', '目标路径必须位于命令的工作目录之内。');
  }
  return path.relative(cwd, absolute) || '.';
}

function readArgs(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > MAX_ARGS || value.some((item) => typeof item !== 'string' || item.length > 500 || item.includes('\0'))) {
    throw new WorkspaceRequestError('INVALID_PARAMS', `args 必须是最多 ${MAX_ARGS} 个字符串（参数直接传给 Python，不经过 shell）。`);
  }
  return value as string[];
}

async function readText(file: string): Promise<string> {
  return fs.readFile(file, 'utf8').catch(() => '');
}

async function manifestFingerprint(cwdDir: string): Promise<string> {
  const parts = [];
  for (const name of MANIFESTS) parts.push(await readText(path.join(cwdDir, name)));
  return hash(parts.join('\0'));
}

/** 运行文件时一并研判它直接导入的本地模块（同目录或工作目录下的同名 .py）。 */
async function localImports(file: string, cwdDir: string): Promise<string[]> {
  const text = await readText(file);
  const found = new Set<string>();
  for (const match of text.matchAll(/^\s*(?:from\s+([\w.]+)\s+import|import\s+([\w.]+))/gm)) {
    const name = (match[1] ?? match[2]).split('.')[0];
    for (const base of [path.dirname(file), cwdDir]) {
      for (const candidate of [path.join(base, `${name}.py`), path.join(base, name, '__init__.py')]) {
        if (candidate.startsWith(cwdDir + path.sep) && await exists(candidate)) found.add(candidate);
      }
    }
    if (found.size >= 10) break;
  }
  return [...found];
}

// 常驻服务：就绪后先返回地址，进程在后台运行，直到止令。
const SERVER_MODULES = new Set(['uvicorn', 'gunicorn', 'hypercorn', 'daphne', 'http.server', 'gradio', 'streamlit', 'flask', 'fastapi', 'mkdocs', 'jupyter', 'notebook', 'jupyterlab']);
function isLongRunning(head: string, args: string[]): boolean {
  if (args.includes('--reload') || args.includes('--watch')) return true;
  if (head === 'flask' || head === 'streamlit' || head === 'fastapi' || head === 'mkdocs') return args.some((arg) => ['run', 'dev', 'serve'].includes(arg));
  if (SERVER_MODULES.has(head)) return true;
  return /(?:^|[\\/])manage\.py$/.test(head) && args.includes('runserver');
}

/** pip / 发布工具经 run_module 调用时的定级：删除类与发布 R2，往全局装包 R4。 */
function moduleLevel(module: string, args: string[], inVenv: boolean): { level: RiskLevel; effects: string[]; rejectReason?: string } {
  const effects = ['将执行项目中的代码'];
  const sub = args[0];
  if (module === 'pip' && ['install', 'uninstall', 'download'].includes(sub ?? '')) {
    if (!inVenv) return { level: 4, effects, rejectReason: '当前解释器不在虚拟环境里，Gor 不会改动系统 Python 的包；请先创建虚拟环境（create_venv）。' };
    if (sub === 'uninstall') return { level: 2, effects: [...effects, '会从虚拟环境卸载包'] };
    return { level: 1, effects: [...effects, '会联网下载并写入虚拟环境'] };
  }
  if ((module === 'twine' && sub === 'upload') || ((module === 'poetry' || module === 'uv' || module === 'hatch' || module === 'flit') && sub === 'publish')) {
    return { level: 2, effects: [...effects, '会对外发布，发出后无法收回'] };
  }
  return { level: 1, effects };
}

function plan(context: ActionContext, options: {
  argv: string[]; command: string; allowKey: string; level?: RiskLevel; effects?: string[]; rejectReason?: string;
  warnings?: ExecPlan['warnings']; background?: boolean; parse?: (text: string) => Diagnostics | undefined;
  details?: string[]; fingerprint?: () => Promise<string>; extraEnv?: Record<string, string>;
}): ExecPlan {
  const env = pythonEnv(context);
  const background = options.background === true;
  return {
    kind: 'command',
    argv: options.argv,
    cwd: context.cwd,
    cwdUri: context.cwdUri,
    timeoutMs: background ? 0 : PYTHON_TIMEOUT_MS,
    level: options.level ?? 1,
    allowKey: options.allowKey,
    warnings: options.warnings,
    rejectReason: options.rejectReason,
    ...(background ? { background: true } : {}),
    env: { ...childEnv(env), ...options.extraEnv },
    display: {
      command: options.command,
      details: [`解释器：${env.label}`, ...(options.details ?? [])],
      effects: [...(options.effects ?? ['将执行项目中的代码']), ...(background ? ['会在后台持续运行，直到你止令或关闭 VS Code'] : [])],
    },
    fingerprint: options.fingerprint ?? (() => manifestFingerprint(cwdDirOf(context))),
    ...(options.parse ? { parse: ({ stdout, stderr }) => options.parse!(`${stdout}\n${stderr}`) } : {}),
  };
}

function hasModule(context: ActionContext, name: string): boolean {
  return (context.env as PythonEnv).modules?.[name] === true;
}

const envAction: ActionSpec = {
  id: 'env', level: 0, description: '查看 Python 解释器与版本',
  async plan(_params, context) {
    const env = pythonEnv(context);
    return { ...plan(context, { argv: [env.python, '--version'], command: 'python --version', allowKey: 'python:env', level: 0, effects: [] }),
      timeoutMs: 15_000, fingerprint: async () => 'static' };
  },
};

const testAction: ActionSpec = {
  id: 'test', level: 1, description: '运行测试（pytest；没有 pytest 时用 unittest），可用 params.path 指定文件或目录',
  async plan(params, context) {
    const env = pythonEnv(context);
    const target = targetPath(params.path, context);
    if (hasModule(context, 'pytest')) {
      return plan(context, { argv: [env.python, '-m', 'pytest', '-q', ...(target ? [target] : [])], command: `pytest -q${target ? ' ' + target : ''}`,
        allowKey: 'python:test', parse: parsePytestSummary });
    }
    return plan(context, { argv: [env.python, '-m', 'unittest', ...(target ? [target.replace(/\.py$/, '').split(path.sep).join('.')] : ['discover'])],
      command: `python -m unittest ${target ?? 'discover'}`, allowKey: 'python:test', parse: parseUnittestSummary });
  },
};

const lintAction: ActionSpec = {
  id: 'lint', level: 1, description: '代码检查（ruff check，没有时用 flake8；绝不自动修复）',
  async plan(params, context) {
    const env = pythonEnv(context);
    const target = targetPath(params.path, context) ?? '.';
    if (!hasModule(context, 'ruff') && hasModule(context, 'flake8')) {
      return plan(context, { argv: [env.python, '-m', 'flake8', target], command: `flake8 ${target}`, allowKey: 'python:lint', parse: parsePythonCheckOutput });
    }
    return plan(context, { argv: [env.python, '-m', 'ruff', 'check', '--no-fix', '--output-format', 'concise', target],
      command: `ruff check ${target}`, allowKey: 'python:lint', parse: parsePythonCheckOutput });
  },
};

const typecheckAction: ActionSpec = {
  id: 'typecheck', level: 1, description: '类型检查（mypy，没有时用 pyright）',
  async plan(params, context) {
    const env = pythonEnv(context);
    const target = targetPath(params.path, context) ?? '.';
    const tool = !hasModule(context, 'mypy') && hasModule(context, 'pyright') ? 'pyright' : 'mypy';
    return plan(context, { argv: [env.python, '-m', tool, target], command: `${tool} ${target}`, allowKey: 'python:typecheck', parse: parsePythonCheckOutput });
  },
};

const formatCheckAction: ActionSpec = {
  id: 'format_check', level: 1, description: '格式检查（ruff format --check，没有时用 black --check；只检查不改文件）',
  async plan(params, context) {
    const env = pythonEnv(context);
    const target = targetPath(params.path, context) ?? '.';
    if (!hasModule(context, 'ruff') && hasModule(context, 'black')) {
      return plan(context, { argv: [env.python, '-m', 'black', '--check', '--diff', target], command: `black --check ${target}`, allowKey: 'python:format_check' });
    }
    return plan(context, { argv: [env.python, '-m', 'ruff', 'format', '--check', '--diff', target], command: `ruff format --check ${target}`, allowKey: 'python:format_check' });
  },
};

const runFileAction: ActionSpec = {
  id: 'run_file', level: 1, description: '运行工作区内的 .py 文件（params.file，可选 params.args 最多 20 个；manage.py runserver 等常驻服务在后台运行）',
  async plan(params, context) {
    const env = pythonEnv(context);
    const file = targetPath(params.file, context, true);
    if (!file) throw new WorkspaceRequestError('INVALID_PARAMS', '请用 params.file 指定要运行的 .py 文件。');
    const args = readArgs(params.args);
    const cwdDir = cwdDirOf(context);
    const absolute = path.join(cwdDir, file);
    if (!await exists(absolute)) throw new WorkspaceRequestError('FILE_NOT_FOUND', `文件不存在：${file}`);
    const scanned = [absolute, ...await localImports(absolute, cwdDir)];
    const signature = hash((await Promise.all(scanned.map(readText))).join('\0'));
    return plan(context, {
      argv: [env.python, file, ...args], command: ['python', file, ...args].join(' '), allowKey: `python:run_file:${file.split(path.sep).join('/')}`,
      warnings: mergeWarnings(await scanFiles(scanned, cwdDir)), background: isLongRunning(file.split(path.sep).join('/'), args),
      fingerprint: async () => hash((await Promise.all(scanned.map(readText))).join('\0')) === signature ? signature : 'changed',
    });
  },
};

const runModuleAction: ActionSpec = {
  id: 'run_module', level: 1, description: '运行模块 python -m <params.module>（可选 params.args；uvicorn、flask run、streamlit run 等常驻服务在后台运行）',
  async plan(params, context) {
    const env = pythonEnv(context);
    const module = typeof params.module === 'string' ? params.module.trim() : '';
    if (!/^[A-Za-z_][\w.]{0,100}$/.test(module)) throw new WorkspaceRequestError('INVALID_PARAMS', 'module 必须是模块名，例如 uvicorn、pytest、app.main。');
    const args = readArgs(params.args);
    const head = module.split('.')[0] === 'http' ? module : module.split('.')[0];
    const graded = moduleLevel(head, args, env.inVenv === true);
    // 运行项目自己的模块时，研判对应的本地文件。
    const cwdDir = cwdDirOf(context);
    const local = [path.join(cwdDir, ...module.split('.')) + '.py', path.join(cwdDir, ...module.split('.'), '__main__.py')];
    const scanned = (await Promise.all(local.map(async (file) => (await exists(file) ? file : '')))).filter(Boolean);
    return plan(context, {
      argv: [env.python, '-m', module, ...args], command: ['python -m', module, ...args].join(' '), allowKey: `python:run_module:${module}`,
      level: graded.level, effects: graded.effects, rejectReason: graded.rejectReason,
      warnings: mergeWarnings(await scanFiles(scanned, cwdDir)), background: isLongRunning(head, args),
    });
  },
};

const createVenvAction: ActionSpec = {
  id: 'create_venv', level: 1, description: '在工作目录创建虚拟环境 .venv（python -m venv .venv）',
  async plan(_params, context) {
    const env = pythonEnv(context);
    const target = path.join(cwdDirOf(context), '.venv');
    if (await exists(target)) throw new WorkspaceRequestError('VENV_EXISTS', '工作目录里已经有 .venv；如需重建请先手动删除。');
    return plan(context, {
      argv: [env.python, '-m', 'venv', '.venv'], command: 'python -m venv .venv', allowKey: 'python:create_venv',
      effects: ['会在工作目录创建 .venv 目录'], fingerprint: async () => (await exists(target) ? 'exists' : 'absent'),
    });
  },
};

/** 在 PATH 中查找可执行文件（uv / poetry）；只接受 .exe 或无扩展名的可执行文件，不调用 .cmd/.bat。 */
async function findExecutable(name: string): Promise<string | undefined> {
  const names = process.platform === 'win32' ? [`${name}.exe`] : [name];
  for (const dir of currentPath().split(path.delimiter).filter(Boolean)) {
    for (const file of names) {
      const candidate = path.join(dir, file);
      if (await exists(candidate)) return candidate;
    }
  }
  return undefined;
}
export const pythonTools = { findExecutable };

const installAction: ActionSpec = {
  id: 'install', level: 1,
  description: '按项目清单安装依赖到虚拟环境（uv sync / poetry install / pip install -r requirements.txt / pip install -e .；不支持安装清单以外的包）',
  async plan(_params, context) {
    const env = pythonEnv(context);
    const cwdDir = cwdDirOf(context);
    const effects = ['会联网下载依赖', '会写入虚拟环境', '会执行依赖包自带的构建脚本'];
    const setupFiles = (await Promise.all(['setup.py'].map(async (name) => (await exists(path.join(cwdDir, name)) ? path.join(cwdDir, name) : ''))))
      .filter(Boolean);
    const warnings = mergeWarnings(await scanFiles(setupFiles, cwdDir));
    const managed = async (tool: 'uv' | 'poetry', lock: string, args: string[]) => {
      if (!await exists(path.join(cwdDir, lock))) return undefined;
      const exe = await pythonTools.findExecutable(tool);
      if (!exe) throw new WorkspaceRequestError('TOOLCHAIN_UNAVAILABLE', `项目使用 ${tool}（有 ${lock}），但没有找到 ${tool}；请先安装 ${tool}，或在终端手动执行 ${tool} ${args.join(' ')}。`);
      // uv / poetry 自己管理项目的虚拟环境，不会写入系统 Python。
      return plan(context, { argv: [exe, ...args], command: `${tool} ${args.join(' ')}`, allowKey: 'python:install', effects, warnings });
    };
    const viaTool = await managed('uv', 'uv.lock', ['sync']) ?? await managed('poetry', 'poetry.lock', ['install']);
    if (viaTool) return viaTool;
    let pipArgs: string[] | undefined;
    if (await exists(path.join(cwdDir, 'requirements.txt'))) pipArgs = ['install', '-r', 'requirements.txt'];
    else if (await exists(path.join(cwdDir, 'pyproject.toml')) || await exists(path.join(cwdDir, 'setup.py'))) pipArgs = ['install', '-e', '.'];
    if (!pipArgs) throw new WorkspaceRequestError('TOOLCHAIN_CONFIG_NOT_FOUND', '工作目录里没有 requirements.txt、pyproject.toml 或 setup.py。');
    if (!env.inVenv) {
      return plan(context, { argv: [env.python, '-m', 'pip', ...pipArgs], command: `pip ${pipArgs.join(' ')}`, allowKey: 'python:install', level: 4,
        rejectReason: '当前解释器不在虚拟环境里，Gor 不会往系统 Python 装包；请先创建虚拟环境（create_venv）或在 VS Code 中选择虚拟环境。', effects });
    }
    return plan(context, {
      argv: [env.python, '-m', 'pip', ...pipArgs, '--disable-pip-version-check'], command: `pip ${pipArgs.join(' ')}`, allowKey: 'python:install',
      effects, warnings, extraEnv: { PIP_NO_INPUT: '1' },
    });
  },
};

async function listProjects(rootDir: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string, depth: number) => {
    if (found.length >= MAX_PROJECTS || depth > 3) return;
    for (const marker of PROJECT_MARKERS) {
      if (await exists(path.join(dir, marker))) { found.push(dir); break; }
    }
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

export const pythonProfile: ToolchainProfile = {
  id: 'python',
  async detect(root, cwdDir) {
    return resolvePython(root, cwdDir ? path.resolve(cwdDir) : undefined);
  },
  async describe(root, env) {
    const rootDir = path.resolve(root.uri.fsPath);
    const python = env as PythonEnv;
    const projects = [];
    for (const dir of await listProjects(rootDir)) {
      const relative = path.relative(rootDir, dir).split(path.sep).join('/');
      const markers = [];
      for (const name of [...PROJECT_MARKERS, 'uv.lock', 'poetry.lock']) if (await exists(path.join(dir, name))) markers.push(name);
      const venv = (await Promise.all(VENV_DIRS.map(async (name) => (await exists(venvPython(path.join(dir, name))) ? name : '')))).find(Boolean);
      projects.push({ cwd: relative ? `/${relative}` : '/', markers, venv: venv ?? null,
        entryFiles: (await Promise.all(['main.py', 'app.py', 'manage.py'].map(async (name) => (await exists(path.join(dir, name)) ? name : '')))).filter(Boolean) });
    }
    return {
      available: python.available, reason: python.reason, interpreter: python.label, inVenv: python.inVenv,
      tools: Object.entries(python.modules ?? {}).filter(([, ok]) => ok).map(([name]) => name),
      projects, projectsTruncated: projects.length >= MAX_PROJECTS,
    };
  },
  actions: [envAction, createVenvAction, installAction, runFileAction, runModuleAction, testAction, lintAction, typecheckAction, formatCheckAction],
};
