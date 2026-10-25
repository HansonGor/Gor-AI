// 多端同步：维持推送连接（断开自动重连），把其他设备的会话变化与正在生成的回复交给调用方。
// 本端自己发起的回复由原有的发送流程显示，这里按 assistantMessageId 识别并跳过。
import { useEffect, useRef, useState } from 'react';
import { readSyncEvents, type SyncEvent } from '../api/sync';
import { applyRemoteRunEvent, startRemoteRun, type RemoteRun } from '../utils/remoteRun';

export interface ChatSyncHandlers {
  /** 会话列表有变化（新建、删除、改名、更新时间），或重连后需要整体刷新 */
  onSessionsChanged: () => void;
  /** 当前打开的会话在别处被删除 */
  onCurrentSessionDeleted: () => void;
  /** 其他设备的回复结束：调用方从服务器重新拉取这一轮的完整记录；完成后才移除临时显示，避免闪烁 */
  onRemoteRunFinished: (sessionId: string) => Promise<void> | void;
  /** 会话的预览项目在别处更新 */
  onPreviewChanged: (sessionId: string) => void;
  /** 本端自己发起的回复（按发送时生成的 assistantMessageId 判断） */
  isLocalAssistant: (assistantMessageId: string) => boolean;
}

const RECONNECT_DELAYS = [1000, 2000, 5000, 10000];
const SESSIONS_DEBOUNCE_MS = 250;

export function useChatSync(userId: string | null, sessionId: string | null, handlers: ChatSyncHandlers) {
  const [runs, setRuns] = useState<Record<string, RemoteRun>>({});
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;

  useEffect(() => {
    if (!userId) return;
    const controller = new AbortController();
    const ignoredRuns = new Set<string>();
    let sessionsTimer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;

    const sessionsChanged = () => {
      clearTimeout(sessionsTimer);
      sessionsTimer = setTimeout(() => handlersRef.current.onSessionsChanged(), SESSIONS_DEBOUNCE_MS);
    };
    const removeRun = (runId: string) => setRuns((current) => {
      if (!(runId in current)) return current;
      const { [runId]: _removed, ...rest } = current;
      return rest;
    });

    const handle = (event: SyncEvent) => {
      switch (event.type) {
        case 'hello':
          // 连上（含重连）后整体刷新一次，补上断线期间的变化
          if (attempt > 0) sessionsChanged();
          attempt = 0;
          break;
        case 'resync':
          sessionsChanged();
          break;
        case 'sessions_changed':
          sessionsChanged();
          if (event.reason === 'deleted' && event.sessionId === sessionIdRef.current) handlersRef.current.onCurrentSessionDeleted();
          break;
        case 'preview_changed':
          handlersRef.current.onPreviewChanged(event.sessionId);
          break;
        case 'run_started':
          if (event.assistantMessageId && handlersRef.current.isLocalAssistant(event.assistantMessageId)) {
            ignoredRuns.add(event.runId);
            break;
          }
          setRuns((current) => (current[event.runId] ? current : { ...current, [event.runId]: startRemoteRun(event) }));
          break;
        case 'run_event':
          if (ignoredRuns.has(event.runId)) break;
          setRuns((current) => {
            const run = current[event.runId];
            if (!run) return current;
            const next = applyRemoteRunEvent(run, event.seq, event.event);
            return next === run ? current : { ...current, [event.runId]: next };
          });
          break;
        case 'run_finished': {
          if (ignoredRuns.delete(event.runId)) break;
          const finished = handlersRef.current.onRemoteRunFinished(event.sessionId);
          void Promise.resolve(finished).catch(() => undefined).finally(() => removeRun(event.runId));
          break;
        }
        default:
          break;
      }
    };

    void (async () => {
      while (!controller.signal.aborted) {
        try {
          await readSyncEvents(userId, handle, controller.signal);
        } catch {
          if (controller.signal.aborted) return;
        }
        if (controller.signal.aborted) return;
        // 连接断开（后端重启、网络切换、手机 App 回到前台）：退避后重连，期间的临时显示作废
        setRuns({});
        ignoredRuns.clear();
        const delay = RECONNECT_DELAYS[Math.min(attempt, RECONNECT_DELAYS.length - 1)];
        attempt += 1;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    })();

    return () => {
      controller.abort();
      clearTimeout(sessionsTimer);
      setRuns({});
    };
  }, [userId]);

  const currentRun = sessionId ? Object.values(runs).find((run) => run.sessionId === sessionId) ?? null : null;
  return { currentRun, remoteRuns: runs };
}
