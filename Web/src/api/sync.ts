// 多端同步推送流：同一账号的其他设备发消息、生成回复、增删会话时，本端实时收到事件。
// 用 fetch 读取服务器推送流（SSE），凭证随请求自动携带（Web 为 Cookie，插件/桌面端由宿主附加）。
import { parseSSEStream } from '../utils/sse';

export type SyncEvent =
  | { type: 'hello'; namespace: string }
  | { type: 'resync' }
  | { type: 'sessions_changed'; sessionId: string; reason: 'created' | 'deleted' | 'updated' }
  | { type: 'preview_changed'; sessionId: string; revision?: number }
  | {
      type: 'run_started'; runId: string; sessionId: string; assistantMessageId?: string | null; startedAt?: number;
      userMessage: { content?: string; images?: string[]; attachments?: unknown[] };
    }
  | { type: 'run_event'; runId: string; sessionId: string; seq: number; event: Record<string, any> }
  | { type: 'run_finished'; runId: string; sessionId: string; status: 'completed' | 'cancelled' | 'failed' | string };

/** 订阅推送流直到连接结束或被中止；调用方负责重连。 */
export async function readSyncEvents(userId: string, onEvent: (event: SyncEvent) => void, signal: AbortSignal): Promise<void> {
  const response = await fetch(`/api/sync/events?userId=${encodeURIComponent(userId)}`, {
    headers: { Accept: 'text/event-stream' },
    signal,
  });
  if (!response.ok || !response.body) throw new Error(`同步连接失败 (${response.status})`);
  for await (const event of parseSSEStream(response.body)) {
    if (event && typeof event.type === 'string') onEvent(event as unknown as SyncEvent);
  }
}
