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
  | { type: 'run_finished'; runId: string; sessionId: string; status: 'completed' | 'cancelled' | 'failed' | string }
  // 遥斋：本账号书斋列表变化、施行审阅（由桌面端经后端转来）、本设备被断开或电脑关掉了遥控
  | { type: 'remote_workspaces_changed' }
  | { type: 'remote_toolchain'; remoteId: string; message: unknown }
  | { type: 'remote_revoked'; remoteId: string; deviceId?: string; reason: 'disabled' | 'kicked' | string };

type SyncListener = (event: SyncEvent) => void;
const extraListeners = new Set<SyncListener>();

/** 聊天页之外的模块（如遥斋）也要读推送事件：共用聊天页已有的推送连接，不另开一条。 */
export function addSyncListener(listener: SyncListener): () => void {
  extraListeners.add(listener);
  return () => { extraListeners.delete(listener); };
}

/** 订阅推送流直到连接结束或被中止；调用方负责重连。 */
export async function readSyncEvents(userId: string, onEvent: (event: SyncEvent) => void, signal: AbortSignal): Promise<void> {
  const response = await fetch(`/api/sync/events?userId=${encodeURIComponent(userId)}`, {
    headers: { Accept: 'text/event-stream' },
    signal,
  });
  if (!response.ok || !response.body) throw new Error(`同步连接失败 (${response.status})`);
  for await (const event of parseSSEStream(response.body)) {
    if (!event || typeof event.type !== 'string') continue;
    onEvent(event as unknown as SyncEvent);
    for (const listener of [...extraListeners]) listener(event as unknown as SyncEvent);
  }
}
