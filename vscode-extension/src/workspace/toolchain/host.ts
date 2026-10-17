import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as vscode from 'vscode';
import { normalizeWorkspaceRelativePath, selectWorkspaceRoot, toWorkspaceUri, WorkspaceRequestError } from '../paths';
import { decide, DEFAULT_ALLOWLIST, normalizeApprovalMode, PlanRejection, type ConfirmReason } from './policy';
import { highestWarning, type RiskLevel, type RiskWarning } from './risk';
import { buildChildEnv, redactSecrets, runProcess, type ProcessOutcome, type RunHandle } from './runner';
import { gitProfile } from './profiles/git';
import { nodeProfile } from './profiles/node';
import { pythonProfile } from './profiles/python';
import type { ApprovalMode, Diagnostics, ExecPlan, OperationKind, Params, RunResult, RunStatus, ToolchainProfile } from './types';

/** 登记所有工具链；以后加 java 等只需在这里加一行。 */
export const TOOLCHAINS: ToolchainProfile[] = [nodeProfile, pythonProfile, gitProfile];

export const APPROVAL_TIMEOUT_MS = 10 * 60 * 1000;
/** 常驻进程启动后最多等这么久检测访问地址，然后先把结果交回对话。 */
export const BACKGROUND_READY_TIMEOUT_MS = 60 * 1000;
export const MAX_BACKGROUND_RUNS = 3;
const BACKGROUND_TAIL_CHARS = 8_000;
const LOG_CHARS = 4_000;
const RESUME_TOKEN_TTL_MS = 2 * 60 * 1000;

export type ApprovalRequest = {
  approvalId: string;
  runId: string;
  sessionId?: string;
  kind: OperationKind;
  toolchain: string;
  action: string;
  command: string;
  cwd: string;
  level: RiskLevel;
  /** 为什么要问：审阅模式不在白名单 / 删除类 / 项目外 / 疑似风险。 */
  reason: ConfirmReason;
  warnings?: RiskWarning[];
  /** 可以勾选「本轮内此命令不再询问」。 */
  allowRemember: boolean;
  scripts?: Array<{ name: string; body: string }>;
  scriptSource?: string;
  details?: string[];
  effects: string[];
  editable?: { field: 'message'; label: string; value: string };
  /** 审阅模式下本轮尚未落笔的文件数；大于 0 时可选「落笔并施行」。 */
  pendingReviewFiles?: number;
  deadline: number;
};

export type ApprovalAnswer = 'approve' | 'approve_round' | 'apply_and_run' | 'skip' | 'stop' | 'timeout' | 'cancelled';
export type ApprovalReply = ApprovalAnswer | { answer: ApprovalAnswer; message?: string };

export type RunUpdate = {
  runId: string;
  approvalId?: string;
  sessionId?: string;
  status: RunStatus;
  kind?: OperationKind;
  command?: string;
  cwd?: string;
  summary?: string;
  startedAt?: number;
  durationMs?: number;
  diagnostics?: Diagnostics;
  url?: string;
  /** 卡片收起后保留的风险标签。 */
  warningLevel?: 'warn' | 'high';
  approved?: RunResult['approved'];
};

export type ToolchainUi = {
  /** 展示审阅卡片（或原生确认框）并等待用户决定；signal 触发时应尽快返回 cancelled。 */
  requestApproval(request: ApprovalRequest, signal: AbortSignal): Promise<ApprovalReply>;
  update(update: RunUpdate): void;
  output(text: string): void;
};

const REASON_TEXT: Record<ConfirmReason, string> = {
  review: '审阅落笔：不在白名单内',
  destructive: '删除类操作：两种模式都需确认',
  external: '项目外的文件：两种模式都需确认',
  suspicious: '疑似风险：两种模式都需确认',
};

/** 聊天面板不可见或未能展示卡片时的兜底：VS Code 原生确认框。 */
export const nativeUi: ToolchainUi = {
  async requestApproval(request, signal) {
    let message = request.editable?.value;
    for (;;) {
      const detail = [
        REASON_TEXT[request.reason],
        ...(request.warnings ?? []).map((w) => `${w.level === 'high' ? '【高度可疑】' : '【疑似风险】'}${w.reason}${w.evidence ? `：${w.evidence}` : ''}`),
        '',
        `命令：${request.command}`,
        `目录：${request.cwd}`,
        ...(request.details ?? []),
        ...(message !== undefined && request.editable ? [`${request.editable.label}：${message}`] : []),
        ...(request.scripts?.length ? ['', '脚本实际内容：', ...request.scripts.map((s) => `  ${s.name}: ${s.body}`)] : []),
        '',
        ...request.effects,
      ].join('\n');
      const high = highestWarning(request.warnings) === 'high';
      const actions = [high ? '仍要施行' : '施行', ...(request.editable ? [`改写${request.editable.label}`] : [])];
      const choice = await Promise.race([
        Promise.resolve(vscode.window.showWarningMessage('此令待你过目', { modal: true, detail }, ...actions)),
        new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), Math.max(0, request.deadline - Date.now()))),
        new Promise<'cancelled'>((resolve) => signal.addEventListener('abort', () => resolve('cancelled'), { once: true })),
      ]);
      if (choice === '施行' || choice === '仍要施行') return message !== request.editable?.value ? { answer: 'approve', message } : 'approve';
      if (choice === 'timeout' || choice === 'cancelled') return choice;
      if (request.editable && choice === `改写${request.editable.label}`) {
        const edited = await vscode.window.showInputBox({
          title: `Gor ${request.editable.label}`, value: message, ignoreFocusOut: true,
          prompt: '修改后按回车返回确认；按 Esc 取消。',
          validateInput: (text) => (text.trim() ? undefined : `${request.editable!.label}不能为空`),
        });
        if (edited === undefined) return 'skip';
        message = edited.trim() || message;
        continue;
      }
      return 'skip';
    }
  },
  update() { /* 原生模式没有卡片，状态由回执说明 */ },
  output() { /* 由 configureToolchainUi 注入输出面板 */ },
};

let ui: ToolchainUi = nativeUi;
export function configureToolchainUi(next: Partial<ToolchainUi>): void {
  ui = { ...nativeUi, ...next };
}

/** 白名单读 VS Code 设置 gor.toolchain.allowlist；未设置时用内置默认值。 */
export function currentAllowlist(): string[] {
  try {
    const configured = vscode.workspace.getConfiguration?.('gor')?.get<unknown>('toolchain.allowlist');
    if (Array.isArray(configured)) return configured.filter((item): item is string => typeof item === 'string');
  } catch { /* 测试替身或设置不可用时用默认值 */ }
  return DEFAULT_ALLOWLIST;
}

// 一次性命令单独串行排队：同一时间只跑一个，不阻塞文件读写请求。常驻进程不占这条队列。
let runQueue: Promise<void> = Promise.resolve();
const activeRuns = new Map<string, { abort: AbortController; cancelProcess?: () => void }>();
// 「本轮内此命令不再询问」：只记完全相同的命令与目录，按轮次隔离，轮次结束后自然失效。
const rememberedByRound = new Map<string, Set<string>>();
// 「落笔并施行」：Server 落笔后凭令牌继续执行同一条已确认的命令。
const resumeTokens = new Map<string, { key: string; fingerprint: string; expiresAt: number }>();

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
        ...profile.actions.map((action) => ({ id: action.id, level: `R${action.level}`, description: action.description })),
        ...(profile.id === 'node' ? [
          { id: 'logs', level: 'R0', description: '查看后台常驻进程最近的输出（params.runId）' },
          { id: 'stop', level: 'R0', description: '止令：结束后台常驻进程（params.runId）' },
        ] : []),
      ],
    });
  }
  return {
    workspaceTrusted: vscode.workspace.isTrusted !== false,
    allowlist: currentAllowlist(),
    toolchains,
    backgroundProcesses: [...backgroundRuns.values()].filter((run) => run.root === root.uri.fsPath).map(describeBackground),
  };
}

// 依赖缺失的常见报错：模块找不到、命令不存在。
const MISSING_DEPENDENCY = /Cannot find module|ERR_MODULE_NOT_FOUND|Cannot find package|is not recognized as an internal or external command|command not found|:\s*not found\b|ModuleNotFoundError|No module named/i;
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
    case 'user_cancelled': return '你未允准，没有执行';
    case 'approval_timeout': return `${Math.round(APPROVAL_TIMEOUT_MS / 60000)} 分钟无回应，没有执行`;
    case 'plan_changed': return '确认后内容发生了变化，未执行，需重新确认';
    default: return reason ?? '';
  }
}

/** Git 等原生操作的结果摘要，只陈述回执里的事实。 */
function nativeSummary(action: string, data: Record<string, unknown> | undefined): string {
  if (!data) return '已完成';
  if (data.committed === true) {
    const files = Array.isArray(data.files) ? data.files.length : 0;
    const committed = `已提交 ${files} 个文件到 ${data.branch ?? '当前分支'}` + (typeof data.commit === 'string' ? `，提交号 ${data.commit.slice(0, 8)}` : '');
    if (data.pushed === true) return committed + `，并推送到 ${data.upstream ?? `${data.remote}/${data.branch}`}` + (data.setUpstream ? '（已设置上游）' : '');
    if (typeof data.pushError === 'string') return `${committed}；${data.pushError}`;
    return typeof data.pushSkipped === 'string' ? `${committed}；${data.pushSkipped}` : committed;
  }
  if (data.pushed === true) return `已推送到 ${data.upstream ?? `${data.remote}/${data.branch}`}` + (data.setUpstream ? '，并设置了上游' : '');
  if (data.pushed === false) return typeof data.message === 'string' ? data.message : '没有需要推送的提交';
  if (typeof data.created === 'string') return `已新建分支 ${data.created}` + (data.checkedOut ? '并切换过去' : '');
  if (typeof data.switched === 'string') return `已切换到分支 ${data.switched}`;
  if (typeof data.deleted === 'string') return `已删除分支 ${data.deleted}`;
  if (Array.isArray(data.discarded)) return `已放弃 ${data.discarded.length} 个文件的改动`;
  if (data.pulled === true) return `已拉取，当前分支 ${data.branch ?? ''}`.trim();
  if (data.fetched === true) return '已获取远端更新';
  if (action === 'status' || action === 'diff') return `分支 ${data.branch ?? '游离 HEAD'}`;
  if (action === 'log' && Array.isArray(data.commits)) return `最近 ${data.commits.length} 个提交`;
  return '已完成';
}

function finish(runId: string, sessionId: string | undefined, approvalId: string | undefined, result: RunResult): Record<string, unknown> {
  ui.update({
    runId, approvalId, sessionId, status: result.status, command: result.command, cwd: result.cwd,
    summary: result.summary, durationMs: result.durationMs, diagnostics: result.diagnostics, url: result.url,
    warningLevel: highestWarning(result.warnings), approved: result.approved,
  });
  return { success: ['completed', 'background', 'stopped'].includes(result.status), runId, ...result };
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

/** 需要审阅时走的统一流程：卡片 → 回答。返回 null 表示获准，否则是带状态的结果。 */
type Seek = { approved: 'user' | 'remembered'; message?: string } | { stop: RunResult } | { applyFirst: true };

async function seekApproval(request: Omit<ApprovalRequest, 'approvalId' | 'deadline'>, roundKey: string | undefined, signal: AbortSignal, base: Pick<RunResult, 'toolchain' | 'action' | 'command' | 'cwd' | 'level' | 'warnings'>): Promise<Seek> {
  const approvalId = `approval-${request.runId}`;
  ui.update({ runId: request.runId, approvalId, sessionId: request.sessionId, status: 'awaiting_approval', kind: request.kind,
    command: request.command, cwd: request.cwd, warningLevel: highestWarning(request.warnings) });
  const reply = await ui.requestApproval({ ...request, approvalId, deadline: Date.now() + APPROVAL_TIMEOUT_MS }, signal);
  const answer = typeof reply === 'string' ? reply : reply.answer;
  const message = typeof reply === 'string' ? undefined : reply.message;
  if (signal.aborted || answer === 'cancelled') return { stop: { ...base, status: 'cancelled', summary: '本轮已停止，没有执行' } };
  if (answer === 'timeout') return { stop: { ...base, status: 'approval_timeout', summary: summarize('approval_timeout', undefined) } };
  if (answer === 'apply_and_run' && (request.pendingReviewFiles ?? 0) > 0) return { applyFirst: true };
  if (answer === 'approve_round' && request.allowRemember && roundKey) {
    const [round, key] = roundKey.split('\u0000');
    const set = rememberedByRound.get(round) ?? new Set<string>();
    set.add(key);
    rememberedByRound.set(round, set);
    // 只保留最近的若干轮
    while (rememberedByRound.size > 20) rememberedByRound.delete(rememberedByRound.keys().next().value as string);
  }
  if (answer === 'approve' || answer === 'approve_round' || answer === 'apply_and_run') return { approved: 'user', ...(message ? { message } : {}) };
  return { stop: { ...base, status: 'user_cancelled', summary: summarize('user_cancelled', undefined) } };
}

export async function runToolchainAction(params: Params): Promise<Record<string, unknown>> {
  const runId = text(params.runId, 80) ?? `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const sessionId = text(params.sessionId, 80);
  const roundId = text(params.roundId, 80);
  const mode: ApprovalMode = normalizeApprovalMode(params.approvalMode);
  const pendingReviewFiles = typeof params.pendingReviewFiles === 'number' && params.pendingReviewFiles > 0 ? Math.floor(params.pendingReviewFiles) : 0;
  const profile = findProfile(params.toolchain);
  const args = params.args && typeof params.args === 'object' && !Array.isArray(params.args) ? params.args as Params : {};
  if (profile.id === 'node' && (params.action === 'logs' || params.action === 'stop')) return manageBackground(params.action, args, profile.id);
  const spec = profile.actions.find((item) => item.id === params.action);
  if (!spec) {
    const extra = profile.id === 'node' ? ['logs', 'stop'] : [];
    throw new WorkspaceRequestError('TOOLCHAIN_ACTION_NOT_SUPPORTED',
      `${profile.id} 没有动作 ${String(params.action)}。可用：${[...profile.actions.map((a) => a.id), ...extra].join('、')}`);
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
  const env = await profile.detect(root, cwdUri.fsPath);
  let plan: ExecPlan;
  try {
    plan = await spec.plan(args, { root, cwd, cwdUri, env });
  } catch (error) {
    if (error instanceof PlanRejection) return reject(error.status, error.message, { cwd });
    if (error instanceof WorkspaceRequestError && error.code === 'GIT_FORCE_PUSH_REJECTED') return reject('rejected', error.message, { cwd, level: 4 });
    throw error;
  }
  const shown = { command: plan.display.command, cwd: plan.cwd, level: plan.level, ...(plan.warnings?.length ? { warnings: plan.warnings } : {}) };
  const memoryKey = `${profile.id}|${spec.id}|${plan.display.command}|${plan.cwd}`;
  const roundKey = roundId ? `${roundId}\u0000${memoryKey}` : undefined;
  const resumeKey = `${memoryKey}|${JSON.stringify(args)}`;

  // 「落笔并施行」的第二段：令牌有效且内容未变，就按已确认的命令继续执行。
  const resume = text(params.resumeToken, 120);
  let resumed = false;
  if (resume) {
    const stored = resumeTokens.get(resume);
    resumeTokens.delete(resume);
    if (!stored || stored.expiresAt < Date.now() || stored.key !== resumeKey) {
      return reject('plan_changed', '落笔后的继续执行凭据已失效，请重新发起这条命令。', shown);
    }
    if (await plan.fingerprint() !== stored.fingerprint) {
      return reject('plan_changed', summarize('plan_changed', plan), shown);
    }
    resumed = true;
  }

  const decision = resumed
    ? { kind: 'run' as const, approved: 'user' as const }
    : decide(plan, mode, { trusted, allowlist: currentAllowlist(), remembered: roundId ? rememberedByRound.get(roundId)?.has(memoryKey) : false });
  if (decision.kind === 'reject') return reject(decision.status, decision.reason, shown);
  if (plan.background) {
    // 同一个常驻命令已经在跑就不重复启动，直接告诉对话它的地址。
    const existing = [...backgroundRuns.values()].find((run) => run.root === root.uri.fsPath && run.cwd === plan.cwd && run.command === plan.display.command);
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
  let approved: RunResult['approved'] = decision.kind === 'run' ? decision.approved : 'user';
  let input: { message?: string } | undefined;
  try {
    const fingerprint = await plan.fingerprint();
    if (decision.kind === 'confirm') {
      approvalId = `approval-${runId}`;
      const outcome = await seekApproval({
        runId, sessionId, kind: plan.kind, ...base, command: plan.display.command, cwd: plan.cwd, level: plan.level,
        reason: decision.reason, warnings: plan.warnings, allowRemember: decision.allowRemember,
        scripts: plan.display.scripts, scriptSource: plan.display.scriptSource, details: plan.display.details,
        effects: plan.display.effects, editable: plan.display.editable,
        ...(pendingReviewFiles && plan.kind === 'command' ? { pendingReviewFiles } : {}),
      }, roundKey, abort.signal, { ...base, ...shown });
      if ('stop' in outcome) return finish(runId, sessionId, approvalId, outcome.stop);
      // 展示什么就执行什么：确认期间内容被改动则不执行。
      if (await plan.fingerprint() !== fingerprint) {
        return finish(runId, sessionId, approvalId, { ...base, ...shown, status: 'plan_changed', summary: summarize('plan_changed', plan) });
      }
      if ('applyFirst' in outcome) {
        const token = randomUUID();
        resumeTokens.set(token, { key: resumeKey, fingerprint, expiresAt: Date.now() + RESUME_TOKEN_TTL_MS });
        for (const [key, value] of resumeTokens) if (value.expiresAt < Date.now()) resumeTokens.delete(key);
        return finish(runId, sessionId, approvalId, { ...base, ...shown, status: 'apply_requested', resumeToken: token,
          summary: `先落笔 ${pendingReviewFiles} 个审阅候选，再施行` });
      }
      approved = outcome.approved;
      input = outcome.message ? { message: outcome.message } : undefined;
    }
    if (plan.background) {
      return await startBackground(plan, { runId, sessionId, approvalId, base, shown, root: root.uri.fsPath, abort });
    }

    const previous = runQueue;
    let release: () => void = () => undefined;
    runQueue = new Promise<void>((resolve) => { release = resolve; });
    try {
      await previous;
      if (abort.signal.aborted) {
        return finish(runId, sessionId, approvalId, { ...base, ...shown, status: 'cancelled', summary: '本轮已停止，没有执行' });
      }
      const startedAt = Date.now();
      ui.update({ runId, approvalId, sessionId, status: 'running', kind: plan.kind, command: plan.display.command, cwd: plan.cwd, startedAt });
      if (plan.execute) return await executeNative(plan, input, { runId, sessionId, approvalId, base, shown, approved, startedAt, signal: abort.signal });
      ui.output(`\n▶ [${profile.id}] ${plan.display.command}  （目录 ${plan.cwd}）\n`);
      const handle = runProcess({
        argv: plan.argv ?? [],
        cwd: plan.cwdUri.fsPath,
        env: buildChildEnv(process.env, plan.env),
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
        ...base, ...shown, status, approved,
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

async function executeNative(plan: ExecPlan, input: { message?: string } | undefined, context: {
  runId: string; sessionId?: string; approvalId?: string; startedAt: number; signal: AbortSignal;
  approved: RunResult['approved']; base: { toolchain: string; action: string }; shown: Partial<RunResult>;
}): Promise<Record<string, unknown>> {
  const { runId, sessionId, approvalId, base, shown, approved } = context;
  try {
    const outcome = await plan.execute!(context.signal, input);
    const summary = outcome.summary || nativeSummary(base.action, outcome.data);
    ui.output(`■ [${base.toolchain}] ${plan.display.command}：${summary}\n`);
    return finish(runId, sessionId, approvalId, {
      ...base, ...shown, status: outcome.ok ? 'completed' : 'failed', approved, durationMs: Date.now() - context.startedAt,
      ...(outcome.data ? { data: outcome.data } : {}), ...(outcome.code ? { code: outcome.code } : {}), summary,
    });
  } catch (error) {
    const known = error instanceof WorkspaceRequestError ? error : undefined;
    const summary = redactSecrets(known?.message ?? (error instanceof Error ? error.message : String(error))).slice(0, 400);
    return finish(runId, sessionId, approvalId, {
      ...base, ...shown, status: 'failed', approved, durationMs: Date.now() - context.startedAt,
      code: known?.code ?? 'OPERATION_FAILED', summary,
    });
  }
}

/** 启动常驻进程：检测到访问地址、进程提前退出或等满 60 秒后先返回，进程继续在后台运行。 */
async function startBackground(plan: ExecPlan, context: {
  runId: string; sessionId?: string; approvalId?: string; root: string; abort: AbortController;
  base: { toolchain: string; action: string }; shown: Partial<RunResult> & { command: string; cwd: string };
}): Promise<Record<string, unknown>> {
  const { runId, sessionId, approvalId, base, shown } = context;
  if (context.abort.signal.aborted) {
    return finish(runId, sessionId, approvalId, { ...base, ...shown, status: 'cancelled', summary: '本轮已停止，没有执行' });
  }
  const startedAt = Date.now();
  let resolveReady: () => void = () => undefined;
  const ready = new Promise<void>((resolve) => { resolveReady = resolve; });
  const run: BackgroundRun = {
    runId, sessionId, approvalId, toolchain: base.toolchain, command: shown.command, cwd: shown.cwd, root: context.root,
    startedAt, tail: '', stopping: false,
    handle: undefined as unknown as RunHandle,
  };
  ui.update({ runId, approvalId, sessionId, status: 'running', kind: 'command', command: shown.command, cwd: shown.cwd, startedAt });
  ui.output(`\n▶ [${base.toolchain}] ${shown.command}  （目录 ${shown.cwd}，后台运行）\n`);
  run.handle = runProcess({
    argv: plan.argv ?? [],
    cwd: plan.cwdUri.fsPath,
    env: buildChildEnv(process.env, plan.env),
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
    ui.update({ runId, approvalId, sessionId, status: stopped ? 'stopped' : 'failed', command: shown.command, cwd: shown.cwd, summary, url: run.url });
  });
  const summary = run.url ? `已在后台运行 · ${run.url}` : '已在后台启动，暂未检测到访问地址，可用 logs 查看输出';
  return finish(runId, sessionId, approvalId, {
    ...base, ...shown, status: 'background', approved: 'user', url: run.url,
    output: redactSecrets(stripAnsi(run.tail)).slice(-LOG_CHARS), summary,
  });
}

/**
 * 文件删除、项目外读取等非工具链操作的统一确认入口：同一张卡片、同一套等级与风险规则。
 * 获准返回 { approved }，之后调用方执行并用 report() 回报结果；否则返回带状态的结果。
 */
export async function confirmOperation(operation: {
  runId?: string; sessionId?: string; roundId?: string; approvalMode?: unknown;
  kind: OperationKind; toolchain: string; action: string; level: RiskLevel; allowKey: string;
  command: string; cwd: string; details?: string[]; effects: string[]; warnings?: RiskWarning[]; rejectReason?: string;
}): Promise<{ approved: RunResult['approved']; runId: string; approvalId?: string; report: (ok: boolean, summary: string) => void } | { result: Record<string, unknown> }> {
  const runId = operation.runId ?? `op-${randomUUID()}`;
  const base = { toolchain: operation.toolchain, action: operation.action };
  const shown = { command: operation.command, cwd: operation.cwd, level: operation.level, ...(operation.warnings?.length ? { warnings: operation.warnings } : {}) };
  const trusted = vscode.workspace.isTrusted !== false;
  const decision = decide(operation, normalizeApprovalMode(operation.approvalMode), { trusted, allowlist: currentAllowlist() });
  if (decision.kind === 'reject') {
    return { result: finish(runId, operation.sessionId, undefined, { ...base, ...shown, status: decision.status, summary: decision.reason }) };
  }
  let approved: RunResult['approved'] = decision.kind === 'run' ? decision.approved : 'user';
  let approvalId: string | undefined;
  if (decision.kind === 'confirm') {
    approvalId = `approval-${runId}`;
    const abort = new AbortController();
    activeRuns.set(runId, { abort });
    try {
      const outcome = await seekApproval({
        runId, sessionId: operation.sessionId, kind: operation.kind, ...base, command: operation.command, cwd: operation.cwd,
        level: operation.level, reason: decision.reason, warnings: operation.warnings, allowRemember: false,
        details: operation.details, effects: operation.effects,
      }, undefined, abort.signal, { ...base, ...shown });
      if ('stop' in outcome) return { result: finish(runId, operation.sessionId, approvalId, outcome.stop) };
      approved = 'user';
    } finally {
      activeRuns.delete(runId);
    }
  }
  const startedAt = Date.now();
  return {
    approved, runId, approvalId,
    report: (ok, summary) => {
      ui.update({ runId, approvalId, sessionId: operation.sessionId, status: ok ? 'completed' : 'failed', kind: operation.kind,
        command: operation.command, cwd: operation.cwd, summary, durationMs: Date.now() - startedAt,
        warningLevel: highestWarning(operation.warnings), approved });
    },
  };
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
