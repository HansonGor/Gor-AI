// 会话管理 Hook
// 负责会话的创建、查询、切换、删除等操作
import { useState, useCallback, useRef } from 'react';
import { getChatClientMode } from '../utils/clientMode';
import { restoreThinking } from '../utils/thinking';
import { useFeedback } from '../components/ui/feedback';
import {
  createSession,
  getSessionMessages,
  getSessions,
  deleteSession as deleteSessionApi,
} from '../api/chat';
import { CHAT_CONFIG } from '../config';
import { initialSessionId } from '../utils/sessionSelection';
import { createUuid } from '../utils/uuid';
import { consumeOpenFirstSession } from '../user/auth';
import type { Session, ChatMessage } from '../types';
import { createMessagePreviewSnapshot } from '../preview/core/projectSnapshot';
import { restorePresentationSnapshot } from '../preview/core/presentationSnapshot';
import { restoreChangeSetReference } from '../utils/changeSetReference';

export function getSessionUserId(): string {
  // The web app keeps its existing account namespace. The VS Code Webview uses
  // a separate user_id so both clients can share the API/database without
  // mixing their session lists.
  return getChatClientMode() === 'vscode'
    ? `${CHAT_CONFIG.DEFAULT_USER_ID}:vscode`
    : CHAT_CONFIG.DEFAULT_USER_ID;
}

export function useSession() {
  const { notify } = useFeedback();
  const [sessions, setSessions] = useState<Session[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [isSessionReady, setIsSessionReady] = useState(false);
  const activeSessionIdRef = useRef<string | null>(null);
  const pendingSessionCreatesRef = useRef(new Map<string, Promise<Session>>());

  const commitSessionId = useCallback((sid: string | null) => {
    activeSessionIdRef.current = sid;
    setSessionId(sid);
    try {
      const key = `gor-last-session:${getSessionUserId()}`;
      if (sid) localStorage.setItem(key, sid);
      else localStorage.removeItem(key);
    } catch { /* Storage may be unavailable in a Webview; API ordering remains a fallback. */ }
  }, []);

  /**
   * 更新浏览器 URL 的 sessionId（放入 hash 路由 query：/path#/chat?sessionId=xxx）
   */
  const updateUrlSessionId = useCallback((sid: string) => {
    // Use the live document URL explicitly. A VS Code Webview's <base> points to
    // its packaged resource origin, so a root-relative history URL would become
    // cross-origin even though only the hash route is meant to change.
    const currentUrl = new URL(window.location.href);
    const hashPath = currentUrl.hash.split('?')[0] || '#/chat';
    currentUrl.hash = `${hashPath.slice(1)}?sessionId=${encodeURIComponent(sid)}`;
    window.history.replaceState(null, '', currentUrl.href);
  }, []);

  /**
   * 拉取会话列表
   */
  const fetchSessions = useCallback(async (strict = false): Promise<Session[]> => {
    try {
      const list = await getSessions(getSessionUserId());
      setSessions(list);
      return list;
    } catch (err) {
      console.error('[Session] 拉取会话列表失败:', err);
      if (strict) throw err;
      return [];
    }
  }, []);

  const waitForSessionCreation = useCallback(async (sid: string): Promise<boolean> => {
    const pending = pendingSessionCreatesRef.current.get(sid);
    if (!pending) return true;
    try {
      await pending;
      return true;
    } catch {
      return false;
    }
  }, []);

  const isSessionActive = useCallback((sid: string): boolean => activeSessionIdRef.current === sid, []);

  /**
   * 加载指定会话的历史消息
   */
  const loadHistory = useCallback(async (sid: string): Promise<ChatMessage[]> => {
    try {
      const history = await getSessionMessages(sid);
      if (history && history.length > 0) {
        const restored: ChatMessage[] = history.map((m) => ({
          id: m.id || Date.now().toString(),
          role: m.role,
          content: m.content,
          thinkingTrace: restoreThinking(m.thinking_trace),
          images: m.images || undefined,
          attachments: m.role === 'user' ? m.attachments || undefined : undefined,
          files: m.role === 'assistant' ? m.attachments || undefined : undefined,
          file: m.role === 'assistant' ? m.attachments?.[m.attachments.length - 1] || undefined : undefined,
          previewChanges: m.preview_changes || m.previewChanges || undefined,
          projectChanges: m.project_changes || m.projectChanges || undefined,
          projectChangeSet: restoreChangeSetReference(m.project_change_sets, sid),
          previewSnapshot: (() => {
            const snapshot = m.preview_snapshot || m.previewSnapshot;
            if (!snapshot || typeof snapshot !== 'object' || !snapshot.files || typeof snapshot.files !== 'object') return undefined;
            const messageId = String(m.id || '');
            const presentationSnapshot = restorePresentationSnapshot(snapshot, messageId);
            if (presentationSnapshot) return presentationSnapshot;
            const changes = (m.preview_changes || m.previewChanges || []) as Array<{ path?: string }>;
            return createMessagePreviewSnapshot({
              id: String(snapshot.id || messageId),
              name: String(snapshot.name || 'Preview Project'),
              template: snapshot.template === 'html' ? 'html' : 'react',
              files: snapshot.files as Record<string, string>,
              revision: typeof snapshot.revision === 'number' ? snapshot.revision : 0,
            }, messageId, snapshot.outputExtension === '.glb' ? ['/src/scene.json'] : changes.flatMap((change) => typeof change.path === 'string' ? [change.path] : []));
          })(),
          isStreaming: false,
          tokenUsage:
            m.prompt_tokens || m.completion_tokens || m.total_tokens
              ? {
                  prompt_tokens: m.prompt_tokens || 0,
                  completion_tokens: m.completion_tokens || 0,
                  total_tokens: m.total_tokens || 0,
                }
              : undefined,
          // 联网搜索来源（历史消息直接从持久化数据还原，不重新搜索）
          searchSources: m.search_sources || m.searchSources || undefined,
          searchTrace: m.search_trace || m.searchTrace || undefined,
        }));
        return restored;
      }
      return [];
    } catch (err) {
      console.error('[Session] 加载历史消息失败:', err);
      return [];
    }
  }, []);

  /**
   * 页面初始化：明确链接优先，否则恢复最近使用的会话；空列表才新建。
   */
  const initSession = useCallback(async (): Promise<string | null> => {
    try {
      // 1. 拉取全部会话列表
      const sessionList = await fetchSessions(true);

      // 2. 读取 URL query 参数 sessionId（优先 hash 路由内 query：#/chat?sessionId=xxx）
      const hashQuery = new URLSearchParams(window.location.hash.split('?')[1] || '');
      let sid = hashQuery.get('sessionId');
      if (!sid) {
        // 兼容旧格式：?sessionId=xxx 在 pathname query
        const urlParams = new URLSearchParams(window.location.search);
        sid = urlParams.get('sessionId');
      }

      let lastUsed: string | null = null;
      // 刚登录/注册时进入列表第一个会话，不沿用本机上次打开的会话
      if (!consumeOpenFirstSession()) {
        try { lastUsed = localStorage.getItem(`gor-last-session:${getSessionUserId()}`); } catch { /* use API ordering */ }
      }
      sid = initialSessionId(sessionList, sid, lastUsed);
      if (sid) {
        updateUrlSessionId(sid);
        commitSessionId(sid);
      } else {
        const newSession = await createSession(getSessionUserId());
        sid = newSession.id;
        updateUrlSessionId(sid);
        commitSessionId(sid);
        await fetchSessions();
      }

      setIsSessionReady(true);
      return sid;
    } catch (err) {
      console.error('[Session] 初始化失败:', err);
      notify('初始化失败');
      setIsSessionReady(true);
      return null;
    }
  }, [fetchSessions, updateUrlSessionId, notify, commitSessionId]);

  /**
   * 切换会话
   */
  const selectSession = useCallback(
    async (sid: string, isLoading: boolean): Promise<boolean> => {
      if (sid === sessionId) return false;
      if (isLoading) {
        notify('请等待当前回复完成');
        return false;
      }

      commitSessionId(sid);
      updateUrlSessionId(sid);
      return true;
    },
    [sessionId, updateUrlSessionId, notify, commitSessionId],
  );

  /**
   * 创建新会话
   */
  const createNewSession = useCallback(
    async (isLoading: boolean): Promise<string | null> => {
      if (isLoading) {
        notify('请等待当前回复完成');
        return null;
      }

      // 手机经局域网 http 访问时没有 crypto.randomUUID，用兼容实现
      const sid = createUuid();
      const previousSessionId = sessionId;
      const optimisticSession: Session = {
        id: sid,
        title: '新对话',
        updated_at: new Date().toISOString(),
        message_count: 0,
      };

      // Switch locally first so the new-chat screen opens on the click, then
      // persist the same ID in the background to keep subsequent sends safe.
      commitSessionId(sid);
      updateUrlSessionId(sid);
      setSessions((current) => [optimisticSession, ...current.filter((item) => item.id !== sid)]);

      const pending = createSession(getSessionUserId(), sid);
      pendingSessionCreatesRef.current.set(sid, pending);
      void pending.then(
        (createdSession) => {
          pendingSessionCreatesRef.current.delete(sid);
          setSessions((current) => [createdSession, ...current.filter((item) => item.id !== sid)]);
          void fetchSessions();
        },
        (err) => {
          pendingSessionCreatesRef.current.delete(sid);
          setSessions((current) => current.filter((item) => item.id !== sid));
          if (activeSessionIdRef.current === sid) {
            commitSessionId(previousSessionId);
            if (previousSessionId) updateUrlSessionId(previousSessionId);
          }
          console.error('[Session] 创建会话失败:', err);
          notify('创建会话失败');
        },
      );
      return sid;
    },
    [sessionId, updateUrlSessionId, fetchSessions, notify, commitSessionId],
  );

  /**
   * 删除会话
   */
  const deleteSessionById = useCallback(
    async (sid: string): Promise<string | null> => {
      try {
        await deleteSessionApi(sid);

        // 刷新会话列表
        const remainingSessions = await fetchSessions();

        // 如果删除的是当前活跃会话，自动跳转
        if (sid === sessionId) {
          let newSid: string | null = null;
          if (remainingSessions.length > 0) {
            // 如果还有其他会话，跳转到第一个
            newSid = remainingSessions[0].id;
          } else {
            // 没有其他会话，创建新会话
            const newSession = await createSession(getSessionUserId());
            newSid = newSession.id;
            await fetchSessions();
          }
          commitSessionId(newSid);
          updateUrlSessionId(newSid);
          notify('会话已删除', 'success');
          return newSid;
        }

        notify('会话已删除', 'success');
        return sessionId;
      } catch (err) {
        console.error('[Session] 删除会话失败:', err);
        notify('删除失败');
        return null;
      }
    },
    [sessionId, fetchSessions, updateUrlSessionId, notify, commitSessionId],
  );

  return {
    // 状态
    sessions,
    sessionId,
    isSessionReady,
    // 方法
    fetchSessions,
    loadHistory,
    initSession,
    selectSession,
    createNewSession,
    waitForSessionCreation,
    isSessionActive,
    deleteSessionById,
    updateUrlSessionId,
  };
}

export default useSession;
