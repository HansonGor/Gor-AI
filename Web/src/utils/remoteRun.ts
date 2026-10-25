// 其他设备正在生成的回复：把同步推送的事件拼成正文与思考步骤，作为临时消息显示在本端。
// 回复结束后由调用方从服务器重新拉取这一轮的完整记录（工具卡片、文件改动、预览），这里只负责实时显示。
import type { ChatMessage, UploadedAttachment } from '../types';
import { acceptThinkingEvent, type ThinkingEvent, type ThinkingTrace } from './thinking';

export interface RemoteRun {
  runId: string;
  sessionId: string;
  assistantMessageId?: string | null;
  userMessage: { content?: string; images?: string[]; attachments?: unknown[] };
  content: string;
  thinkingTrace?: ThinkingTrace;
  lastSeq: number;
}

const THINKING_EVENT_TYPES = new Set([
  'thinking_start', 'thinking_delta', 'thinking_end', 'thinking_update', 'thinking_title', 'thinking_summary_delta', 'thinking_mode',
]);

export function startRemoteRun(event: { runId: string; sessionId: string; assistantMessageId?: string | null; userMessage?: RemoteRun['userMessage'] }): RemoteRun {
  return {
    runId: event.runId,
    sessionId: event.sessionId,
    assistantMessageId: event.assistantMessageId,
    userMessage: event.userMessage ?? {},
    content: '',
    lastSeq: 0,
  };
}

/** 按序号应用一条回复事件；重复或过期的序号（补齐与实时推送重叠时）直接忽略。 */
export function applyRemoteRunEvent(run: RemoteRun, seq: number, event: Record<string, any>): RemoteRun {
  if (!Number.isFinite(seq) || seq <= run.lastSeq) return run;
  const next: RemoteRun = { ...run, lastSeq: seq };
  if (event.type === 'token') {
    next.content = run.content + (typeof event.content === 'string' ? event.content : '');
  } else if (THINKING_EVENT_TYPES.has(event.type) && (event.type === 'thinking_mode' || typeof event.roundId === 'string')) {
    next.thinkingTrace = acceptThinkingEvent(run.thinkingTrace, event as ThinkingEvent);
  }
  return next;
}

/**
 * 临时显示用的两条消息（用户提问 + 正在生成的回复）。
 * 服务端会先保存用户消息：若本端已从历史里读到同一条提问，则不再重复显示。
 */
export function remoteRunMessages(run: RemoteRun, history: readonly ChatMessage[]): ChatMessage[] {
  const question = (run.userMessage.content ?? '').trim();
  const last = history[history.length - 1];
  const alreadyLoaded = last?.role === 'user' && last.content.trim() === question;
  const messages: ChatMessage[] = [];
  if (!alreadyLoaded) {
    messages.push({
      id: `remote-user-${run.runId}`,
      role: 'user',
      content: question || '（图片）',
      ...(run.userMessage.images?.length ? { images: run.userMessage.images } : {}),
      ...(run.userMessage.attachments?.length ? { attachments: run.userMessage.attachments as UploadedAttachment[] } : {}),
    });
  }
  messages.push({
    id: `remote-assistant-${run.runId}`,
    role: 'assistant',
    content: run.content,
    isStreaming: true,
    executionPhase: run.content ? 'composing' : 'thinking',
    ...(run.thinkingTrace ? { thinkingTrace: run.thinkingTrace } : {}),
  });
  return messages;
}
