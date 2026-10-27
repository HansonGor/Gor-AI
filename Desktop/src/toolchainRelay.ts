/**
 * 书斋的施行审阅：把工具链的审阅请求与状态转给聊天页（与插件同一套 gor.toolchain 消息与施行卡片），
 * 页面在限定时间内没有展示卡片（窗口未就绪、页面在云笺模式等）就返回 undefined，由调用方退回系统确认框。
 * 不依赖 Electron，可离线测试。
 */
import { cancelToolchainRun, type ApprovalReply, type ApprovalRequest, type RunUpdate } from '@gor/workspace-core';

export const APPROVAL_SHOWN_TIMEOUT_MS = 1500;
const MAX_MESSAGE_CHARS = 5_000;

type Pending = { shown: boolean; settle: (answer: ApprovalReply | undefined) => void };

export function isLocalDevUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:')
      && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && !url.username && !url.password;
  } catch {
    return false;
  }
}

export class ToolchainRelay {
  private readonly pending = new Map<string, Pending>();

  /**
   * @param send 发给页面；没有可用窗口时返回 false
   * @param openExternal 打开常驻进程打印的本机地址
   * @param cancelRun 止令（默认取消对应的工具链命令）
   */
  constructor(
    private readonly send: (message: unknown) => boolean,
    private readonly openExternal: (url: string) => void,
    private readonly cancelRun: (runId: string) => void = (runId) => { cancelToolchainRun({ runId }); },
  ) {}

  requestApproval(request: ApprovalRequest, signal: AbortSignal): Promise<ApprovalReply | undefined> {
    return new Promise((resolve) => {
      let settled = false;
      const timers: Array<ReturnType<typeof setTimeout>> = [];
      const settle = (answer: ApprovalReply | undefined) => {
        if (settled) return;
        settled = true;
        timers.forEach(clearTimeout);
        signal.removeEventListener('abort', onAbort);
        this.pending.delete(request.approvalId);
        if (answer === undefined || answer === 'timeout' || answer === 'cancelled') {
          // 收回卡片：之后的状态由 update 消息给出。
          this.send({ type: 'gor.toolchain', kind: 'withdrawn', approvalId: request.approvalId, runId: request.runId });
        }
        resolve(answer);
      };
      const onAbort = () => settle('cancelled');
      if (signal.aborted) { settle('cancelled'); return; }
      signal.addEventListener('abort', onAbort, { once: true });
      this.pending.set(request.approvalId, { shown: false, settle });
      if (!this.send({ type: 'gor.toolchain', kind: 'approval', request })) {
        settle(undefined);
        return;
      }
      timers.push(setTimeout(() => { if (!this.pending.get(request.approvalId)?.shown) settle(undefined); }, APPROVAL_SHOWN_TIMEOUT_MS));
      timers.push(setTimeout(() => settle('timeout'), Math.max(0, request.deadline - Date.now())));
    });
  }

  update(update: RunUpdate): void {
    this.send({ type: 'gor.toolchain', kind: 'update', update });
  }

  /** 处理页面发来的消息；字段逐项校验，不信任结构。 */
  handlePageMessage(value: unknown): void {
    if (!value || typeof value !== 'object') return;
    const message = value as Record<string, unknown>;
    switch (message.type) {
      case 'gor.toolchainApprovalShown': {
        const pending = typeof message.approvalId === 'string' ? this.pending.get(message.approvalId) : undefined;
        if (pending) pending.shown = true;
        break;
      }
      case 'gor.toolchainApprovalAnswer': {
        if (typeof message.approvalId !== 'string') break;
        const allowed = ['approve', 'approve_round', 'apply_and_run', 'stop'] as const;
        const answer = allowed.find((item) => item === message.answer) ?? 'skip';
        const edited = typeof message.message === 'string' && message.message.trim() ? message.message.slice(0, MAX_MESSAGE_CHARS) : undefined;
        this.pending.get(message.approvalId)?.settle(edited && answer !== 'stop' ? { answer, message: edited } : answer);
        break;
      }
      case 'gor.toolchainCancel':
        if (typeof message.runId === 'string') this.cancelRun(message.runId);
        break;
      case 'gor.toolchainOpenUrl':
        if (typeof message.url === 'string' && isLocalDevUrl(message.url)) this.openExternal(message.url);
        break;
      default:
        break;
    }
  }

  /** 窗口关闭或书斋收起时：未回答的卡片按未展示处理，退回系统确认框。 */
  releaseAll(): void {
    for (const pending of [...this.pending.values()]) pending.settle(undefined);
  }
}
