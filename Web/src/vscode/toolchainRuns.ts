/** 插件与桌面端书斋共用：接收宿主发来的施行审阅与状态，回传用户决定。Web 端（含桌面端云笺）从不安装。 */
import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';
import type { ChatMessage } from '../types';
import type {
  ToolchainApproveOptions, ToolchainConfirmReason, ToolchainOperationKind, ToolchainRunsHost, ToolchainRunView,
  ToolchainRunStatus, ToolchainWarning,
} from '../components/chat/toolchainRun';

type Post = (message: unknown) => boolean;

const STATUSES = new Set<ToolchainRunStatus>([
  'awaiting_approval', 'running', 'completed', 'failed', 'user_cancelled', 'approval_timeout', 'timed_out', 'cancelled',
  'plan_changed', 'not_enabled', 'rejected', 'workspace_untrusted', 'background', 'stopped', 'apply_requested',
]);
const REASONS = new Set<ToolchainConfirmReason>(['review', 'destructive', 'external', 'suspicious']);
const KINDS = new Set<ToolchainOperationKind>(['command', 'git', 'file', 'external']);
const APPROVED = new Set(['user', 'allowlist', 'auto', 'remembered']);
const MAX_RUNS = 200;
const MAX_MESSAGE_CHARS = 5_000;

let runs: ToolchainRunView[] = [];
let post: Post = () => false;
const listeners = new Set<() => void>();

function emit(next: ToolchainRunView[]): void {
  runs = next.slice(-MAX_RUNS);
  listeners.forEach((listener) => listener());
}

function upsert(runId: string, patch: Partial<ToolchainRunView>): void {
  const index = runs.findIndex((run) => run.runId === runId);
  if (index < 0) {
    emit([...runs, { runId, status: 'awaiting_approval', ...patch } as ToolchainRunView]);
    return;
  }
  emit(runs.map((run, i) => (i === index ? { ...run, ...patch } : run)));
}

/** 只接受本机开发服务器地址；扩展打开前还会再校验一次。 */
export function isLocalUrl(value: unknown): boolean {
  if (typeof value !== 'string' || value.length > 300) return false;
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  } catch {
    return false;
  }
}

function str(value: unknown, max = 400): string | undefined {
  return typeof value === 'string' ? value.slice(0, max) : undefined;
}

function strings(value: unknown, maxItems: number, maxChars: number): string[] | undefined {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string').slice(0, maxItems).map((item) => item.slice(0, maxChars)) : undefined;
}

function warnings(value: unknown): ToolchainWarning[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const list = value.flatMap((item) => item && typeof item === 'object' && (item.level === 'warn' || item.level === 'high') && typeof item.reason === 'string'
    ? [{ level: item.level as 'warn' | 'high', reason: item.reason.slice(0, 200), ...(typeof item.evidence === 'string' ? { evidence: item.evidence.slice(0, 240) } : {}) }]
    : []).slice(0, 6);
  return list.length ? list : undefined;
}

/** 处理来自扩展的 gor.toolchain 消息；字段逐项校验，不信任结构。 */
export function acceptToolchainMessage(data: unknown): void {
  if (!data || typeof data !== 'object') return;
  const message = data as Record<string, unknown>;
  if (message.type !== 'gor.toolchain') return;
  if (message.kind === 'approval' && message.request && typeof message.request === 'object') {
    const request = message.request as Record<string, unknown>;
    const runId = str(request.runId, 120);
    const approvalId = str(request.approvalId, 160);
    if (!runId || !approvalId) return;
    const editable = request.editable && typeof request.editable === 'object' ? request.editable as Record<string, unknown> : undefined;
    upsert(runId, {
      approvalId, pending: true, answering: false, status: 'awaiting_approval',
      sessionId: str(request.sessionId, 120), command: str(request.command), cwd: str(request.cwd),
      kind: KINDS.has(request.kind as ToolchainOperationKind) ? request.kind as ToolchainOperationKind : 'command',
      reason: REASONS.has(request.reason as ToolchainConfirmReason) ? request.reason as ToolchainConfirmReason : 'review',
      warnings: warnings(request.warnings),
      allowRemember: request.allowRemember === true,
      pendingReviewFiles: typeof request.pendingReviewFiles === 'number' && request.pendingReviewFiles > 0 ? Math.floor(request.pendingReviewFiles) : undefined,
      scriptSource: str(request.scriptSource),
      scripts: Array.isArray(request.scripts)
        ? request.scripts.flatMap((item) => item && typeof item === 'object' && typeof item.name === 'string' && typeof item.body === 'string'
          ? [{ name: item.name.slice(0, 120), body: item.body.slice(0, 2000) }] : []).slice(0, 12)
        : undefined,
      details: strings(request.details, 40, 300),
      editable: editable && editable.field === 'message' && typeof editable.value === 'string'
        ? { field: 'message', label: str(editable.label, 20) ?? '提交说明', value: editable.value.slice(0, MAX_MESSAGE_CHARS) }
        : undefined,
      effects: strings(request.effects, 6, 120),
      deadline: typeof request.deadline === 'number' ? request.deadline : undefined,
    });
    return;
  }
  if (message.kind === 'withdrawn') {
    const runId = str(message.runId, 120);
    if (runId) upsert(runId, { pending: false, answering: false });
    return;
  }
  if (message.kind === 'update' && message.update && typeof message.update === 'object') {
    const update = message.update as Record<string, unknown>;
    const runId = str(update.runId, 120);
    const status = update.status as ToolchainRunStatus;
    if (!runId || !STATUSES.has(status)) return;
    const diagnostics = update.diagnostics && typeof update.diagnostics === 'object' ? update.diagnostics as ToolchainRunView['diagnostics'] : undefined;
    upsert(runId, {
      status,
      ...(status === 'awaiting_approval' ? {} : { pending: false, answering: false }),
      ...(str(update.sessionId, 120) ? { sessionId: str(update.sessionId, 120) } : {}),
      ...(str(update.approvalId, 160) ? { approvalId: str(update.approvalId, 160) } : {}),
      ...(KINDS.has(update.kind as ToolchainOperationKind) ? { kind: update.kind as ToolchainOperationKind } : {}),
      ...(str(update.command) ? { command: str(update.command) } : {}),
      ...(str(update.cwd) ? { cwd: str(update.cwd) } : {}),
      ...(str(update.summary) !== undefined ? { summary: str(update.summary) } : {}),
      ...(typeof update.startedAt === 'number' ? { startedAt: update.startedAt } : {}),
      ...(typeof update.durationMs === 'number' ? { durationMs: update.durationMs } : {}),
      ...(isLocalUrl(update.url) ? { url: update.url as string } : {}),
      ...(update.warningLevel === 'warn' || update.warningLevel === 'high' ? { warningLevel: update.warningLevel } : {}),
      ...(APPROVED.has(update.approved as string) ? { approved: update.approved as ToolchainRunView['approved'] } : {}),
      ...(diagnostics ? { diagnostics } : {}),
    });
  }
}

export function installToolchainBridge(postMessage: Post): void {
  post = postMessage;
  window.addEventListener('message', (event: MessageEvent) => acceptToolchainMessage(event.data));
}

/** 桌面端书斋：消息经 preload 通道收发（同一套 gor.toolchain 消息），不经 window.postMessage。 */
export function connectToolchainChannel(postMessage: Post, subscribeMessages: (listener: (data: unknown) => void) => void): void {
  post = postMessage;
  subscribeMessages(acceptToolchainMessage);
}

export function resetToolchainRunsForTest(postMessage: Post = () => false): void {
  post = postMessage;
  emit([]);
}

export function getToolchainRuns(): ToolchainRunView[] {
  return runs;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

type Answer = 'approve' | 'approve_round' | 'apply_and_run' | 'skip' | 'stop';

function answer(run: ToolchainRunView, value: Answer, message?: string): void {
  if (!run.approvalId || !run.pending || run.answering) return;
  upsert(run.runId, { answering: true });
  const edited = message && message.trim() && message !== run.editable?.value ? message.trim().slice(0, MAX_MESSAGE_CHARS) : undefined;
  post({ type: 'gor.toolchainApprovalAnswer', approvalId: run.approvalId, answer: value, ...(edited ? { message: edited } : {}) });
}

/**
 * ChatPage 在插件模式下使用：把同一会话中尚未绑定的施行绑定到正在生成的助手消息，
 * 并提供卡片回调。停止本轮复用聊天页已有的停止逻辑。
 */
export function useVscodeToolchainRuns(
  sessionId: string | null,
  messages: ChatMessage[],
  stopRound: () => void,
): ToolchainRunsHost {
  const current = useSyncExternalStore(subscribe, getToolchainRuns, getToolchainRuns);
  const streamingId = [...messages].reverse().find((message) => message.role === 'assistant' && message.isStreaming)?.id;

  useEffect(() => {
    if (!sessionId || !streamingId) return;
    const unbound = current.filter((run) => !run.messageId && run.sessionId === sessionId);
    if (unbound.length) emit(runs.map((run) => (unbound.includes(run) ? { ...run, messageId: streamingId } : run)));
  }, [current, sessionId, streamingId]);

  const runsFor = useCallback((message: Pick<ChatMessage, 'id' | 'role' | 'isStreaming'>) => {
    if (!sessionId || message.role !== 'assistant') return [];
    return current.filter((run) => run.sessionId === sessionId
      && (run.messageId === message.id || (!run.messageId && message.isStreaming === true)));
  }, [current, sessionId]);

  return useMemo<ToolchainRunsHost>(() => ({
    runsFor,
    onShown: (run) => { if (run.approvalId) post({ type: 'gor.toolchainApprovalShown', approvalId: run.approvalId }); },
    onApprove: (run, options?: ToolchainApproveOptions) =>
      answer(run, options?.remember && run.allowRemember ? 'approve_round' : 'approve', options?.message),
    onApplyAndRun: (run) => { if (run.pendingReviewFiles) answer(run, 'apply_and_run'); },
    onSkip: (run) => answer(run, 'skip'),
    onStopRound: (run) => { answer(run, 'stop'); stopRound(); },
    onAbort: (run) => { post({ type: 'gor.toolchainCancel', runId: run.runId }); },
    onOpenUrl: (run) => { if (isLocalUrl(run.url)) post({ type: 'gor.toolchainOpenUrl', url: run.url }); },
  }), [runsFor, stopRound]);
}
