// 会话管理 Hook
// 负责会话的创建、查询、切换、删除等操作
import { useState, useCallback } from 'react';
import { useFeedback } from '../components/ui/feedback';
import {
  createSession,
  getSessionMessages,
  getSessions,
  deleteSession as deleteSessionApi,
} from '../api/chat';
import { CHAT_CONFIG } from '../config';
import { isToday } from '../utils/date';
import type { Session, ChatMessage } from '../types';

const { DEFAULT_USER_ID } = CHAT_CONFIG;

export function useSession() {
  const { notify } = useFeedback();
  const [sessions, setSessions] = useState<Session[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [isSessionReady, setIsSessionReady] = useState(false);

  /**
   * 更新浏览器 URL 的 sessionId（放入 hash 路由 query：/path#/chat?sessionId=xxx）
   */
  const updateUrlSessionId = useCallback((sid: string) => {
    const base = window.location.pathname;
    const hashPath = window.location.hash.split('?')[0] || '#/chat';
    window.history.replaceState(null, '', `${base}${hashPath}?sessionId=${sid}`);
  }, []);

  /**
   * 拉取会话列表
   */
  const fetchSessions = useCallback(async (): Promise<Session[]> => {
    try {
      const list = await getSessions(DEFAULT_USER_ID);
      setSessions(list);
      return list;
    } catch (err) {
      console.error('[Session] 拉取会话列表失败:', err);
      return [];
    }
  }, []);

  /**
   * 加载指定会话的历史消息
   */
  const loadHistory = useCallback(async (sid: string): Promise<ChatMessage[]> => {
    try {
      const history = await getSessionMessages(sid);
      if (history && history.length > 0) {
        return history.map((m) => ({
          id: m.id || Date.now().toString(),
          role: m.role,
          content: m.content,
          images: m.images || undefined,
          files: m.attachments || undefined,
          file: m.attachments?.[m.attachments.length - 1] || undefined,
          isStreaming: false,
          tokenUsage:
            m.prompt_tokens || m.completion_tokens || m.total_tokens
              ? {
                  prompt_tokens: m.prompt_tokens || 0,
                  completion_tokens: m.completion_tokens || 0,
                  total_tokens: m.total_tokens || 0,
                }
              : undefined,
        }));
      }
      return [];
    } catch (err) {
      console.error('[Session] 加载历史消息失败:', err);
      return [];
    }
  }, []);

  /**
   * 页面初始化：拉取会话列表 + 处理 URL sessionId + 每天只创建一个新会话
   */
  const initSession = useCallback(async (): Promise<string | null> => {
    try {
      // 1. 拉取全部会话列表
      const sessionList = await fetchSessions();

      // 2. 读取 URL query 参数 sessionId（优先 hash 路由内 query：#/chat?sessionId=xxx）
      const hashQuery = new URLSearchParams(window.location.hash.split('?')[1] || '');
      let sid = hashQuery.get('sessionId');
      if (!sid) {
        // 兼容旧格式：?sessionId=xxx 在 pathname query
        const urlParams = new URLSearchParams(window.location.search);
        sid = urlParams.get('sessionId');
      }

      // 3. 处理 sessionId
      if (sid && sessionList.some((s) => s.id === sid)) {
        // 场景1：URL 携带 sessionId 且存在于列表中
        setSessionId(sid);
      } else {
        // 场景2：URL 无 sessionId 或不存在
        // 检查今天是否已经有会话（每天只创建一个新会话）
        const todaySessions = sessionList.filter((s) => isToday(s.updated_at || ''));

        if (todaySessions.length > 0) {
          // 今天已有会话，使用今天最新的会话
          sid = todaySessions[0].id;
          updateUrlSessionId(sid);
          setSessionId(sid);
          console.log('[Session] 复用今天的会话:', sid);
        } else {
          // 今天没有会话，创建新会话
          const newSession = await createSession(DEFAULT_USER_ID);
          sid = newSession.id;
          updateUrlSessionId(sid);
          setSessionId(sid);
          // 刷新会话列表，追加新会话
          await fetchSessions();
          console.log('[Session] 创建今天的新会话:', sid);
        }
      }

      setIsSessionReady(true);
      return sid;
    } catch (err) {
      console.error('[Session] 初始化失败:', err);
      notify('初始化失败');
      setIsSessionReady(true);
      return null;
    }
  }, [fetchSessions, updateUrlSessionId, notify]);

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

      setSessionId(sid);
      updateUrlSessionId(sid);
      return true;
    },
    [sessionId, updateUrlSessionId, notify],
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

      try {
        const newSession = await createSession(DEFAULT_USER_ID);
        const sid = newSession.id;
        updateUrlSessionId(sid);
        setSessionId(sid);
        // 刷新会话列表
        await fetchSessions();
        return sid;
      } catch (err) {
        console.error('[Session] 创建会话失败:', err);
        notify('创建会话失败');
        return null;
      }
    },
    [updateUrlSessionId, fetchSessions, notify],
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
            const newSession = await createSession(DEFAULT_USER_ID);
            newSid = newSession.id;
            await fetchSessions();
          }
          setSessionId(newSid);
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
    [sessionId, fetchSessions, updateUrlSessionId, notify],
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
    deleteSessionById,
    updateUrlSessionId,
  };
}

export default useSession;
