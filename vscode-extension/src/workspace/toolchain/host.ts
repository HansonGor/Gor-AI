import * as fs from 'node:fs/promises';
import * as vscode from 'vscode';
import { normalizeWorkspaceRelativePath, selectWorkspaceRoot, toWorkspaceUri, WorkspaceRequestError } from '../paths';
import { decide, normalizeApprovalMode, PlanRejection } from './policy';
import { buildChildEnv, redactSecrets, runProcess, type ProcessOutcome, type RunHandle } from './runner';
import { nodeProfile } from './profiles/node';
import type { ApprovalMode, Diagnostics, ExecPlan, Params, RunResult, RunStatus, ToolchainProfile } from './types';

/** 登记所有工具链；以后加 python / java 只需在这里加一行。 */
export const TOOLCHAINS: ToolchainProfile[] = [nodeProfile];

export const APPROVAL_TIMEOUT_MS = 10 * 60 * 1000;
/** 常驻进程启动后最多等这么久检测访问地址，然后先把结果交回对话。 */
export const BACKGROUND_READY_TIMEOUT_MS = 60 * 1000;
export const MAX_BACKGROUND_RUNS = 3;
const BACKGROUND_TAIL_CHARS = 8_000;
const LOG_CHARS = 4_000;

export type ApprovalRequest = {
  approvalId: string;
  runId: string;
  sessionId?: string;
  toolchain: string;
  action: string;
  command: string;
  cwd: string;
  risk: string;
  scripts?: Array<{ name: string; body: string }>;
  scriptSource?: string;
  effects: string[];
  deadline: number;
};

export type ApprovalAnswer = 'approve' | 'skip' | 'stop' | 'timeout' | 'cancelled';

export type RunUpdate = {
  runId: string;
  approvalId?: string;
  sessionId?: string;
  status: RunStatus;
  command?: string;
  cwd?: string;
  summary?: string;
  startedAt?: number;
  durationMs?: number;
  diagnostics?: Diagnostics;
  url?: string;
};

export type ToolchainUi = {
  /** 展示审阅卡片（或原生确认框）并等待用户决定；signal 触发时应尽快返回 cancelled。 */
  requestApproval(request: ApprovalRequest, signal: AbortSignal): Promise<ApprovalAnswer>;
  update(update: RunUpdate): void;
  output(text: string): void;
};

/** 聊天面板不可见或未能展示卡片时的兜底：VS Code 原生确认框。 */
export const nativeUi: ToolchainUi = {
  async requestApproval(request, signal) {
    const detail = [
      `命令：${request.command}`,
      `目录：${request.cwd}`,
      ...(request.scripts?.length ? ['', '脚本实际内容：', ...request.scripts.map((s) => `  ${s.name}: ${s.body}`)] : []),
      '',
      ...request.effects,
    ].join('\n');
    const choice = await Promise.race([
      Promise.resolve(vscode.window.showWarningMessage('此令待你过目', { modal: true, detail }, '施行')),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), Math.max(0, request.deadline - Date.now()))),
      new Promise<'cancelled'>((resolve) => signal.addEventListener('abort', () => resolve('cancelled'), { once: true })),
    ]);
    if (choice === '施行') return 'approve';
    if (choice === 'timeout' || choice === 'cancelled') return choice;
    return 'skip';
  },
  update() { /* 原生模式没有卡片，状态由回执说明 */ },
  output() { /* 由 configureToolchainUi 注入输出面板 */ },
};

let ui: ToolchainUi = nativeUi;
export function configureToolchainUi(next: Partial<ToolchainUi>): void {
  ui = { ...nativeUi, ...next };
}

// 一次性命令单独串行排队：同一时间只跑一个，不阻塞文件读写请求。常驻进程不占这条队列。
let runQueue: Promise<void> = Promise.resolve();
const activeRuns = new Map<string, { abort: AbortController; cancelProcess?: () => void }>();

type BackgroundRun = {
  runId: string;
  sessionId?: string;
  approvalId?: string;
  toolchain: string;
  command: string;
  cwd: string;
  root: string;
  startedAt: number;
  url?: string;
  tail: string;
  stopping: boolean;
  handle: RunHandle;
};
const backgroundRuns = new Map<string, BackgroundRun>();

function text(value: unknown, max: number): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : undefined;
}

function findProfile(id: unknown): ToolchainProfile {
  const profile = TOOLCHAINS.find((item) => item.id === id);
  if (!profile) {
    throw new WorkspaceRequestError('TOOLCHAIN_NOT_SUPPORTED', `不支持的工具链：${String(id)}。可用：${TOOLCHAINS.map((t) => t.id).join('、')}`);
  }
  return profile;
}

async function resolveCwd(root: vscode.WorkspaceFolder, value: unknown): Promise<{ cwd: string; cwdUri: vscode.Uri }> {
  const cwd = value === undefined || value === null || value === '' || value === '/'
    ? '/' : normalizeWorkspaceRelativePath(value);
  const cwdUri = cwd === '/' ? root.uri : toWorkspaceUri(cwd, root);
  let isDirectory = false;
  try { isDirectory = (await fs.stat(cwdUri.fsPath)).isDirectory(); } catch { /* reported below */ }
  if (!isDirectory) throw new WorkspaceRequestError('INVALID_PATH', `工作目录不存在：${cwd}`);
  return { cwd, cwdUri };
}

function describeBackground(run: BackgroundRun) {
  return { runId: run.runId, toolchain: run.toolchain, command: run.command, cwd: run.cwd, url: run.url, startedAt: run.startedAt };
}

export async function listToolchains(params: Params): Promise<Record<string, unknown>> {
  const root = selectWorkspaceRoot(params.root);
  const toolchains = [];
  for (const profile of TOOLCHAINS) {
    let env;
    try {
      env = await profile.detect(root);
    } catch (error) {
      toolchains.push({ id: profile.id, available: false, reason: error instanceof Error ? error.message : String(error) });
      continue;
    }
    toolchains.push({
      id: profile.id,
      ...(await profile.describe(root, env)),
      actions: [
        ...profile.actions.map((action) => ({ id: action.id, risk: action.risk, description: action.description })),
        { id: 'logs', risk: 'read', description: '查看后台常驻进程最近的输出（params.runId）' },
        { id: 'stop', risk: 'read', description: '止令：结束后台常驻进程（params.runId）' },
      ],
    });
  }
  return {
    workspaceTrusted: vscode.workspace.isTrusted !== false,
    toolchains,
    backgroundProcesses: [...backgroundRuns.values()].filter((run) => run.root === root.name).map(describeBackground),
  };
}

// 依赖缺失的常见报错：模块找不到、命令不存在。
const MISSING_DEPENDENCY = /Cannot find module|ERR_MODULE_NOT_FOUND|Cannot find package|is not recognized as an internal or external command|command not found|:\s*not found\b/i;
// 开发服务器打印的本地访问地址。
const LOCAL_URL = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]):\d{2,5}(?:\/[^\s'"<>]*)?/i;

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '');
}

export function detectLocalUrl(output: string): string | undefined {
  const match = stripAnsi(output).match(LOCAL_URL)?.[0];
  return match?.replace('0.0.0.0', 'localhost').replace(/[.,;)]+$/, '');
}

function summarize(status: RunStatus, plan: ExecPlan | undefined, outcome?: ProcessOutcome, diagnostics?: Diagnostics, reason?: string): string {
  const seconds = outcome ? `${(outcome.durationMs / 1000).toFixed(1)} 秒` : '';
  switch (status) {
    case 'completed': {
      if (diagnostics?.total !== undefined && diagnostics.failed === 0) return `${diagnostics.total} 项全部通过 · ${seconds}`;
      return `命令已完成（退出码 0）· ${seconds}`;
    }
    case 'failed': {
      if (outcome?.spawnError) return `命令未能启动：${redactSecrets(outcome.spawnError).slice(0, 200)}`;
      if (diagnostics?.failed) {
        return diagnostics.total !== undefined ? `${diagnostics.total} 项中失败 ${diagnostics.failed} 项` : `发现 ${diagnostics.failed} 处问题`;
      }
      return `命令以退出码 ${outcome?.exitCode ?? '未知'} 结束 · ${seconds}`;
    }
    case 'timed_out': return `超过 ${Math.round((plan?.timeoutMs ?? 0) / 60000)} 分钟，已终止`;
    case 'cancelled': return '已终止，输出可能不完整';
    case 'user_cancelled': return '你未允准，命令没有执行';
    case 'approval_timeout': return `${Math.round(APPROVAL_TIMEOUT_MS / 60000)} 分钟无回应，命令没有执行`;
    case 'plan_changed': return '确认后脚本或依赖清单被改动，未执行，需重新确认';
    default: return reason ?? '';
  }
}

function finish(runId: string, sessionId: string | undefined, approvalId: string | undefined, result: RunResult): Record<string, unknown> {
  ui.update({
    runId, approvalId, sessionId, status: result.status, command: result.command, cwd: result.cwd,
    summary: result.summary, durationMs: result.durationMs, diagnostics: result.diagnostics, url: result.url,
  });
  return { success: result.status === 'completed' || result.status === 'background' || result.status === 'stopped', runId, ...result };
}

/** 失败时判断是否可能因为依赖没装：生成命令时没有 node_modules，或输出里有模块/命令找不到。 */
function dependencyHint(plan: ExecPlan, output: string): Pick<RunResult, 'hint'> {
  return plan.dependenciesInstalled === false || MISSING_DEPENDENCY.test(output) ? { hint: 'DEPENDENCIES_NOT_INSTALLED' } : {};
}

/** logs / stop：针对已经在后台运行的进程，不生成新命令，不需要审阅。 */
async function manageBackground(action: string, args: Params, toolchain: string): Promise<Record<string, unknown>> {
  const runId = text(args.runId, 120);
  const run = runId ? backgroundRuns.get(runId) : undefined;
  if (!run) {
    const running = [...backgroundRuns.values()].map((item) => `${item.runId}（${item.command}）`).join('、');
    throw new WorkspaceRequestError('RUN_NOT_FOUND', `没有找到这个后台进程。当前在运行：${running || '无'}。`);
  }
  const base = { toolchain, action, command: run.command, cwd: run.cwd, url: run.url };
  if (action === 'logs') {
    return {
      success: true, runId: run.runId, ...base, status: 'background' as RunStatus, alive: true,
      output: redactSecrets(stripAnsi(run.tail)).slice(-LOG_CHARS), summary: run.url ? `后台运行中 · ${run.url}` : '后台运行中',
    };
  }
  run.stopping = true;
  run.handle.cancel();
  await Promise.race([run.handle.done, new Promise((resolve) => setTimeout(resolve, 10_000))]);
  return { success: true, runId: run.runId, ...base, status: 'stopped' as RunStatus, summary: '已收令，后台进程已结束' };
}

export async function runToolchainAction(params: Params): Promise<Record<string, unknown>> {
  const runId = text(params.runId, 80) ?? `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const sessionId = text(params.sessionId, 80);
  const mode: ApprovalMode = normalizeApprovalMode(params.approvalMode);
  const profile = findProfile(params.toolchain);
  const args = params.args && typeof params.args === 'object' && !Array.isArray(params.args) ? params.args as Params : {};
  if (params.action === 'logs' || params.action === 'stop') return manageBackground(params.action, args, profile.id);
  const spec = profile.actions.find((item) => item.id === params.action);
  if (!spec) {
    throw new WorkspaceRequestError('TOOLCHAIN_ACTION_NOT_SUPPORTED',
      `${profile.id} 没有动作 ${String(params.action)}。可用：${[...profile.actions.map((a) => a.id), 'logs', 'stop'].join('、')}`);
  }
  const base = { toolchain: profile.id, action: spec.id };
  const reject = (status: RunStatus, summary: string, extra: Partial<RunResult> = {}) =>
    finish(runId, sessionId, undefined, { ...base, ...extra, status, summary });

  const trusted = vscode.workspace.isTrusted !== false;
  if (!trusted) {
    return reject('workspace_untrusted', '当前工作区未受信任，请先在 VS Code 中信任此工作区。');
  }
  const root = selectWorkspaceRoot(params.root);
  const { cwd, cwdUri } = await resolveCwd(root, params.cwd);
  const env = await profile.detect(root);
  let plan: ExecPlan;
  try {
    plan = await spec.plan(args, { root, cwd, cwdUri, env });
  } catch (error) {
    if (error instanceof PlanRejection) return reject(error.status, error.message, { cwd });
    throw error;
  }
  const shown = { command: plan.display.command, cwd: plan.cwd };
  const decision = decide(plan, mode, trusted);
  if (decision.kind === 'reject') return reject(decision.status, decision.reason, shown);
  if (plan.background) {
    // 同一个常驻命令已经在跑就不重复启动，直接告诉对话它的地址。
    const existing = [...backgroundRuns.values()].find((run) => run.root === root.name && run.cwd === plan.cwd && run.command === plan.display.command);
    if (existing) {
      return { success: true, runId: existing.runId, ...base, ...shown, status: 'background', url: existing.url,
        summary: existing.url ? `已在后台运行 · ${existing.url}` : '已在后台运行' };
    }
    if (backgroundRuns.size >= MAX_BACKGROUND_RUNS) {
      return reject('rejected', `已有 ${MAX_BACKGROUND_RUNS} 个后台常驻进程，请先止令其中一个。`, shown);
    }
  }

  const abort = new AbortController();
  const active: { abort: AbortController; cancelProcess?: () => void } = { abort };
  activeRuns.set(runId, active);
  let approvalId: string | undefined;
  try {
    const fingerprint = await plan.fingerprint();
    if (decision.kind === 'confirm') {
      approvalId = `approval-${runId}`;
      ui.update({ runId, approvalId, sessionId, status: 'awaiting_approval', ...shown });
      const answer = await ui.requestApproval({
        approvalId, runId, sessionId, ...base, ...shown, risk: plan.risk,
        scripts: plan.display.scripts, scriptSource: plan.display.scriptSource, effects: plan.display.effects,
        deadline: Date.now() + APPROVAL_TIMEOUT_MS,
      }, abort.signal);
      if (abort.signal.aborted || answer === 'cancelled') {
        return finish(runId, sessionId, approvalId, { ...base, ...shown, status: 'cancelled', summary: '本轮已停止，命令没有执行' });
      }
      if (answer === 'timeout') {
        return finish(runId, sessionId, approvalId, { ...base, ...shown, status: 'approval_timeout', summary: summarize('approval_timeout', plan) });
      }
      if (answer !== 'approve') {
        return finish(runId, sessionId, approvalId, { ...base, ...shown, status: 'user_cancelled', summary: summarize('user_cancelled', plan) });
      }
      // 展示什么就执行什么：确认期间脚本被改动则不执行。
      if (await plan.fingerprint() !== fingerprint) {
        return finish(runId, sessionId, approvalId, { ...base, ...shown, status: 'plan_changed', summary: summarize('plan_changed', plan) });
      }
    }
    if (plan.background) {
      return await startBackground(plan, { runId, sessionId, approvalId, base, shown, root: root.name, abort });
    }

    const previous = runQueue;
    let release: () => void = () => undefined;
    runQueue = new Promise<void>((resolve) => { release = resolve; });
    try {
      await previous;
      if (abort.signal.aborted) {
        return finish(runId, sessionId, approvalId, { ...base, ...shown, status: 'cancelled', summary: '本轮已停止，命令没有执行' });
      }
      const startedAt = Date.now();
      ui.update({ runId, approvalId, sessionId, status: 'running', ...shown, startedAt });
      ui.output(`\n▶ [${profile.id}] ${plan.display.command}  （目录 ${plan.cwd}）\n`);
      const handle = runProcess({
        argv: plan.argv,
        cwd: plan.cwdUri.fsPath,
        env: buildChildEnv(process.env),
        timeoutMs: plan.timeoutMs,
        onOutput: (chunk) => ui.output(redactSecrets(chunk)),
      });
      active.cancelProcess = handle.cancel;
      if (abort.signal.aborted) handle.cancel();
      const outcome = await handle.done;
      const status: RunStatus = outcome.timedOut ? 'timed_out' : outcome.cancelled ? 'cancelled'
        : outcome.exitCode === 0 ? 'completed' : 'failed';
      const diagnostics = status === 'completed' || status === 'failed'
        ? plan.parse?.({ stdout: outcome.stdout, stderr: outcome.stderr, exitCode: outcome.exitCode }) : undefined;
      const hint = status === 'failed' ? dependencyHint(plan, outcome.stdout + '\n' + outcome.stderr) : {};
      const summary = summarize(status, plan, outcome, diagnostics) + (hint.hint ? '，可能尚未安装依赖' : '');
      ui.output(`■ ${summary}\n`);
      return finish(runId, sessionId, approvalId, {
        ...base, ...shown, status, approved: decision.kind === 'confirm' ? 'user' : 'allowlist',
        exitCode: outcome.exitCode, durationMs: outcome.durationMs,
        stdout: outcome.stdout, stderr: outcome.stderr,
        stdoutTruncated: outcome.stdoutTruncated, stderrTruncated: outcome.stderrTruncated,
        ...(diagnostics ? { diagnostics } : {}), ...hint, summary,
      });
    } finally {
      release();
    }
  } finally {
    activeRuns.delete(runId);
  }
}

/** 启动常驻进程：检测到访问地址、进程提前退出或等满 60 秒后先返回，进程继续在后台运行。 */
async function startBackground(plan: ExecPlan, context: {
  runId: string; sessionId?: string; approvalId?: string; root: string; abort: AbortController;
  base: { toolchain: string; action: string }; shown: { command: string; cwd: string };
}): Promise<Record<string, unknown>> {
  const { runId, sessionId, approvalId, base, shown } = context;
  if (context.abort.signal.aborted) {
    return finish(runId, sessionId, approvalId, { ...base, ...shown, status: 'cancelled', summary: '本轮已停止，命令没有执行' });
  }
  const startedAt = Date.now();
  let resolveReady: () => void = () => undefined;
  const ready = new Promise<void>((resolve) => { resolveReady = resolve; });
  const run: BackgroundRun = {
    runId, sessionId, approvalId, toolchain: base.toolchain, command: shown.command, cwd: shown.cwd, root: context.root,
    startedAt, tail: '', stopping: false,
    handle: undefined as unknown as RunHandle,
  };
  ui.update({ runId, approvalId, sessionId, status: 'running', ...shown, startedAt });
  ui.output(`\n▶ [${base.toolchain}] ${shown.command}  （目录 ${shown.cwd}，后台运行）\n`);
  run.handle = runProcess({
    argv: plan.argv,
    cwd: plan.cwdUri.fsPath,
    env: buildChildEnv(process.env),
    timeoutMs: 0,
    onOutput: (chunk) => {
      ui.output(redactSecrets(chunk));
      run.tail = (run.tail + chunk).slice(-BACKGROUND_TAIL_CHARS);
      if (!run.url) {
        run.url = detectLocalUrl(run.tail);
        if (run.url) resolveReady();
      }
    },
  });
  backgroundRuns.set(runId, run);
  const exited = run.handle.done.then((outcome) => ({ outcome }));
  const settled = await Promise.race([
    exited,
    ready.then(() => 'ready' as const),
    new Promise<'waiting'>((resolve) => setTimeout(() => resolve('waiting'), BACKGROUND_READY_TIMEOUT_MS)),
  ]);

  if (typeof settled === 'object') {
    // 还没就绪就退出：多半是启动失败（端口占用、依赖缺失等）。
    backgroundRuns.delete(runId);
    const { outcome } = settled;
    const output = outcome.stdout + '\n' + outcome.stderr;
    const status: RunStatus = outcome.cancelled ? 'cancelled' : outcome.exitCode === 0 ? 'completed' : 'failed';
    const hint = status === 'failed' ? dependencyHint(plan, output) : {};
    const summary = status === 'completed' ? '进程很快就退出了，没有保持运行'
      : summarize(status, plan, outcome) + (hint.hint ? '，可能尚未安装依赖' : '');
    return finish(runId, sessionId, approvalId, {
      ...base, ...shown, status, approved: 'user', exitCode: outcome.exitCode, durationMs: outcome.durationMs,
      stdout: outcome.stdout, stderr: outcome.stderr, stdoutTruncated: outcome.stdoutTruncated,
      stderrTruncated: outcome.stderrTruncated, ...hint, summary,
    });
  }

  // 之后进程结束（止令、崩溃、端口冲突退出）时更新卡片状态行。
  void run.handle.done.then((outcome) => {
    backgroundRuns.delete(runId);
    const stopped = run.stopping || outcome.cancelled;
    const summary = stopped ? '已收令，后台进程已结束' : `后台进程已退出（退出码 ${outcome.exitCode ?? '未知'}）`;
    ui.output(`■ ${shown.command}：${summary}\n`);
    ui.update({ runId, approvalId, sessionId, status: stopped ? 'stopped' : 'failed', ...shown, summary, url: run.url });
  });
  const summary = run.url ? `已在后台运行 · ${run.url}` : '已在后台启动，暂未检测到访问地址，可用 logs 查看输出';
  return finish(runId, sessionId, approvalId, {
    ...base, ...shown, status: 'background', approved: 'user', url: run.url,
    output: redactSecrets(stripAnsi(run.tail)).slice(-LOG_CHARS), summary,
  });
}

export function cancelToolchainRun(params: Params): Record<string, unknown> {
  const runId = text(params.runId, 80);
  const background = runId ? backgroundRuns.get(runId) : undefined;
  if (background) {
    background.stopping = true;
    background.handle.cancel();
    return { cancelled: true, runId };
  }
  const active = runId ? activeRuns.get(runId) : undefined;
  if (!active) return { cancelled: false, reason: 'RUN_NOT_FOUND' };
  active.abort.abort();
  active.cancelProcess?.();
  return { cancelled: true, runId };
}

/** 扩展停用时结束所有后台常驻进程，不留下孤儿 dev server。 */
export function disposeToolchainProcesses(): void {
  for (const run of backgroundRuns.values()) {
    run.stopping = true;
    run.handle.cancel();
  }
}
