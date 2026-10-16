import { createContext } from 'react';
import type { ChatMessage } from '../../types';

/** 施行（命令）状态；与扩展回执中的 status 一一对应，展示文案只在这里映射。 */
export type ToolchainRunStatus =
  | 'awaiting_approval' | 'running' | 'completed' | 'failed' | 'user_cancelled' | 'approval_timeout'
  | 'timed_out' | 'cancelled' | 'plan_changed' | 'not_enabled' | 'rejected' | 'workspace_untrusted'
  | 'background' | 'stopped' | 'apply_requested';

/** 为什么要问：审阅模式不在白名单 / 删除类 / 项目外 / 疑似风险。 */
export type ToolchainConfirmReason = 'review' | 'destructive' | 'external' | 'suspicious';
export type ToolchainOperationKind = 'command' | 'git' | 'file' | 'external';
export type ToolchainWarning = { level: 'warn' | 'high'; reason: string; evidence?: string };

export interface ToolchainRunView {
  runId: string;
  sessionId?: string;
  /** 绑定到发起这条命令的助手消息。 */
  messageId?: string;
  approvalId?: string;
  /** 正在等待用户在卡片中决定。 */
  pending?: boolean;
  /** 已回答，等待扩展回执。 */
  answering?: boolean;
  status: ToolchainRunStatus;
  kind?: ToolchainOperationKind;
  reason?: ToolchainConfirmReason;
  warnings?: ToolchainWarning[];
  /** 卡片收起后保留的风险标签。 */
  warningLevel?: 'warn' | 'high';
  allowRemember?: boolean;
  /** 审阅模式下本轮尚未落笔的文件数；大于 0 时可「落笔并施行」。 */
  pendingReviewFiles?: number;
  command?: string;
  cwd?: string;
  scripts?: Array<{ name: string; body: string }>;
  scriptSource?: string;
  /** 额外说明：提交说明与文件清单、要删除的路径等。 */
  details?: string[];
  /** 确认时可改写的字段（提交说明）。 */
  editable?: { field: 'message'; label: string; value: string };
  effects?: string[];
  deadline?: number;
  summary?: string;
  startedAt?: number;
  durationMs?: number;
  approved?: 'user' | 'allowlist' | 'auto' | 'remembered';
  /** 后台常驻进程（dev server）的本地访问地址。 */
  url?: string;
  diagnostics?: { failed?: number; items?: Array<{ file?: string; line?: number; message?: string }> };
}

export type ToolchainTone = 'pending' | 'running' | 'ok' | 'fail' | 'muted';

export function toolchainStatusLabel(run: Pick<ToolchainRunView, 'status' | 'diagnostics'>): { label: string; tone: ToolchainTone } {
  switch (run.status) {
    case 'awaiting_approval': return { label: '待施行', tone: 'pending' };
    case 'running': return { label: '正施行', tone: 'running' };
    case 'completed': return { label: '已施行', tone: 'ok' };
    case 'failed': return { label: run.diagnostics?.failed ? '见疏漏' : '未施成', tone: 'fail' };
    case 'user_cancelled': return { label: '未施行', tone: 'muted' };
    case 'approval_timeout': return { label: '逾时未施', tone: 'muted' };
    case 'timed_out': return { label: '逾时而止', tone: 'pending' };
    case 'cancelled': return { label: '中道而止', tone: 'muted' };
    case 'plan_changed': return { label: '内容有异', tone: 'pending' };
    case 'not_enabled': return { label: '此令未开', tone: 'muted' };
    case 'rejected': return { label: '不可施行', tone: 'fail' };
    case 'workspace_untrusted': return { label: '未得信任', tone: 'muted' };
    case 'background': return { label: '常驻施行', tone: 'running' };
    case 'stopped': return { label: '已收令', tone: 'muted' };
    case 'apply_requested': return { label: '先行落笔', tone: 'pending' };
  }
}

/** 卡片上「为什么要问」的说明；风险信息保持直白。 */
export const CONFIRM_REASON_TEXT: Record<ToolchainConfirmReason, string> = {
  review: '审阅落笔：不在白名单内',
  destructive: '删除类操作：两种模式都需确认',
  external: '项目外的文件：两种模式都需确认',
  suspicious: '即刻落笔模式下本应直接运行，因发现疑似风险改为请你确认',
};

export type ToolchainApproveOptions = { remember?: boolean; message?: string };

/** 宿主注入的施行能力；Web 端不提供（为 null），消息气泡因此不渲染任何施行卡片。 */
export interface ToolchainRunsHost {
  runsFor(message: Pick<ChatMessage, 'id' | 'role' | 'isStreaming'>): ToolchainRunView[];
  onShown(run: ToolchainRunView): void;
  onApprove(run: ToolchainRunView, options?: ToolchainApproveOptions): void;
  onApplyAndRun(run: ToolchainRunView): void;
  onSkip(run: ToolchainRunView): void;
  onStopRound(run: ToolchainRunView): void;
  onAbort(run: ToolchainRunView): void;
  onOpenUrl(run: ToolchainRunView): void;
}

export const ToolchainRunsContext = createContext<ToolchainRunsHost | null>(null);
