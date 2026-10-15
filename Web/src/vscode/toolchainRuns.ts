/** VS Code 插件专用：接收扩展发来的施行审阅与状态，回传用户决定。Web 端从不安装。 */
import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';
import type { ChatMessage } from '../types';
import type { ToolchainRunsHost, ToolchainRunView, ToolchainRunStatus } from '../components/chat/toolchainRun';

type Post = (message: unknown) => boolean;

const STATUSES = new Set<ToolchainRunStatus>([
  'awaiting_approval', 'running', 'completed', 'failed', 'user_cancelled', 'approval_timeout',
  'timed_out', 'cancelled', 'plan_changed', 'not_enabled', 'rejected', 'workspace_untrusted', 'background', 'stopped',
]);
const MAX_RUNS = 200;

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
    upsert(runId, {
      approvalId, pending: true, answering: false, status: 'awaiting_approval',
      sessionId: str(request.sessionId, 120), command: str(request.command), cwd: str(request.cwd),
      scriptSource: str(request.scriptSource),
      scripts: Array.isArray(request.scripts)
        ? request.scripts.flatMap((item) => item && typeof item === 'object' && typeof item.name === 'string' && typeof item.body === 'string'
          ? [{ name: item.name.slice(0, 120), body: item.body.slice(0, 2000) }] : []).slice(0, 12)
        : undefined,
      effects: Array.isArray(request.effects) ? request.effects.filter((item): item is string => typeof item === 'string').slice(0, 6) : undefined,
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
      ...(str(update.command) ? { command: str(update.command) } : {}),
      ...(str(update.cwd) ? { cwd: str(update.cwd) } : {}),
      ...(str(update.summary) !== undefined ? { summary: str(update.summary) } : {}),
      ...(typeof update.startedAt === 'number' ? { startedAt: update.startedAt } : {}),
      ...(typeof update.durationMs === 'number' ? { durationMs: update.durationMs } : {}),
      ...(isLocalUrl(update.url) ? { url: update.url as string } : {}),
      ...(diagnostics ? { diagnostics } : {}),
    });
  }
}

export function installToolchainBridge(postMessage: Post): void {
  post = postMessage;
  window.addEventListener('message', (event: MessageEvent) => acceptToolchainMessage(event.data));
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

function answer(run: ToolchainRunView, value: 'approve' | 'skip' | 'stop'): void {
  if (!run.approvalId || !run.pending || run.answering) return;
  upsert(run.runId, { answering: true });
  post({ type: 'gor.toolchainApprovalAnswer', approvalId: run.approvalId, answer: value });
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
    onApprove: (run) => answer(run, 'approve'),
    onSkip: (run) => answer(run, 'skip'),
    onStopRound: (run) => { answer(run, 'stop'); stopRound(); },
    onAbort: (run) => { post({ type: 'gor.toolchainCancel', runId: run.runId }); },
    onOpenUrl: (run) => { if (isLocalUrl(run.url)) post({ type: 'gor.toolchainOpenUrl', url: run.url }); },
  }), [runsFor, stopRound]);
}
