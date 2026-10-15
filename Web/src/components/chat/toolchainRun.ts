import { createContext } from 'react';
import type { ChatMessage } from '../../types';

/** 施行（命令）状态；与扩展回执中的 status 一一对应，展示文案只在这里映射。 */
export type ToolchainRunStatus =
  | 'awaiting_approval' | 'running' | 'completed' | 'failed' | 'user_cancelled' | 'approval_timeout'
  | 'timed_out' | 'cancelled' | 'plan_changed' | 'not_enabled' | 'rejected' | 'workspace_untrusted'
  | 'background' | 'stopped';

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
  command?: string;
  cwd?: string;
  scripts?: Array<{ name: string; body: string }>;
  scriptSource?: string;
  effects?: string[];
  deadline?: number;
  summary?: string;
  startedAt?: number;
  durationMs?: number;
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
  }
}

/** 宿主注入的施行能力；Web 端不提供（为 null），消息气泡因此不渲染任何施行卡片。 */
export interface ToolchainRunsHost {
  runsFor(message: Pick<ChatMessage, 'id' | 'role' | 'isStreaming'>): ToolchainRunView[];
  onShown(run: ToolchainRunView): void;
  onApprove(run: ToolchainRunView): void;
  onSkip(run: ToolchainRunView): void;
  onStopRound(run: ToolchainRunView): void;
  onAbort(run: ToolchainRunView): void;
  onOpenUrl(run: ToolchainRunView): void;
}

export const ToolchainRunsContext = createContext<ToolchainRunsHost | null>(null);
