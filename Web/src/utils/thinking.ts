export type ThinkingStatus = 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
export interface ThinkingRound { id: string; content: string; ended: boolean; title?: string; summary?: string; source?: 'model' | 'phase' | 'tool'; steps?: string[]; toolName?: string; toolRunning?: boolean }
/** 酌思本轮实际采用的深浅；escalated 表示运行中遇到问题由随思转为深思。 */
export interface ResolvedThinkingMode { mode: 'light' | 'deep'; reason: string; escalated: boolean; initialReason?: string }
export interface ThinkingTrace { rounds: ThinkingRound[]; status: ThinkingStatus; thinkingMode?: ResolvedThinkingMode }
export interface ThinkingEvent {
  type: 'thinking_start' | 'thinking_delta' | 'thinking_end' | 'thinking_title' | 'thinking_summary_delta' | 'thinking_update' | 'thinking_mode';
  roundId: string;
  mode?: 'light' | 'deep';
  reason?: string;
  escalated?: boolean;
  content?: string;
  title?: string;
  summary?: string;
  source?: 'model' | 'phase' | 'tool';
  steps?: string[];
  toolName?: string;
  toolRunning?: boolean;
}

export function acceptThinkingEvent(trace: ThinkingTrace | undefined, event: ThinkingEvent): ThinkingTrace {
  const current = trace ?? { rounds: [], status: 'running' };
  if (current.status !== 'running') return current;
  if (event.type === 'thinking_mode') {
    const previous = current.thinkingMode;
    const escalated = event.escalated === true;
    return { ...current, thinkingMode: {
      mode: event.mode === 'deep' ? 'deep' : 'light',
      reason: typeof event.reason === 'string' ? event.reason : '',
      escalated,
      ...(escalated && previous ? { initialReason: previous.initialReason ?? previous.reason } : {}),
    } };
  }
  const index = current.rounds.findIndex(round => round.id === event.roundId);
  if (event.type === 'thinking_start') {
    return index >= 0 ? current : { ...current, rounds: [...current.rounds, { id: event.roundId, content: '', ended: false }] };
  }
  if (index < 0 || index !== current.rounds.length - 1) return current;
  const round = current.rounds[index];
  const priority = { model: 1, phase: 2, tool: 3 };
  const source = event.source ?? 'model';
  const acceptsPresentation = priority[source] >= priority[round.source ?? 'model'];
  if (event.type !== 'thinking_delta' && event.type !== 'thinking_end'
    && priority[source] < priority[round.source ?? 'model']) return current;
  return { ...current, rounds: current.rounds.map((round, i) => i !== index ? round : {
    ...round,
    content: event.type === 'thinking_delta' ? round.content + (event.content ?? '') : round.content,
    ended: event.type === 'thinking_end' || round.ended,
    source: acceptsPresentation ? event.source ?? round.source : round.source,
    steps: acceptsPresentation && Array.isArray(event.steps) ? event.steps.filter(step => typeof step === 'string') : round.steps,
    toolName: acceptsPresentation && typeof event.toolName === 'string' ? event.toolName : round.toolName,
    toolRunning: acceptsPresentation && typeof event.toolRunning === 'boolean' ? event.toolRunning : round.toolRunning,
    title: !acceptsPresentation ? round.title : event.type === 'thinking_title' && typeof event.title === 'string'
      ? event.title
      : typeof event.title === 'string' ? event.title : round.title,
    summary: !acceptsPresentation ? round.summary : event.type === 'thinking_summary_delta'
      ? (round.summary ?? '') + (event.content ?? '')
      : typeof event.summary === 'string' ? event.summary : round.summary,
  }) };
}

export function finishThinking(trace: ThinkingTrace | undefined, status: ThinkingStatus): ThinkingTrace | undefined {
  if (!trace || trace.status !== 'running') return trace;
  return { ...trace, status };
}

export function restoreThinking(value: unknown): ThinkingTrace | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const trace = value as ThinkingTrace;
  if (!Array.isArray(trace.rounds)) return undefined;
  const rounds = trace.rounds.filter(round => typeof round?.id === 'string' && typeof round.content === 'string').map(round => ({
    ...round,
    title: typeof round.title === 'string' ? round.title : undefined,
    summary: typeof round.summary === 'string' ? round.summary : undefined,
    source: ['model', 'phase', 'tool'].includes(round.source ?? '') ? round.source : undefined,
    steps: Array.isArray(round.steps) ? round.steps.filter(step => typeof step === 'string') : undefined,
    toolName: typeof round.toolName === 'string' ? round.toolName : undefined,
    toolRunning: typeof round.toolRunning === 'boolean' ? round.toolRunning : undefined,
  }));
  const status = ['completed', 'failed', 'cancelled', 'interrupted'].includes(trace.status) ? trace.status : 'interrupted';
  const mode = trace.thinkingMode;
  const thinkingMode = mode && (mode.mode === 'light' || mode.mode === 'deep') ? {
    mode: mode.mode, reason: typeof mode.reason === 'string' ? mode.reason : '', escalated: mode.escalated === true,
    ...(typeof mode.initialReason === 'string' ? { initialReason: mode.initialReason } : {}),
  } : undefined;
  return { rounds, status, ...(thinkingMode ? { thinkingMode } : {}) };
}

export function isToolStatusInThinking(message: { thinkingTrace?: ThinkingTrace; executionToolName?: string }, activeOnly = true): boolean {
  const trace = message.thinkingTrace;
  const latest = trace?.rounds.slice(-1)[0];
  return trace?.status === 'running' && latest?.source === 'tool' && (!activeOnly || latest.toolRunning === true)
    && Boolean(latest.toolName && latest.toolName === message.executionToolName);
}
