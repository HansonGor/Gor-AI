// 聊天状态管理 Hook（组合入口）
// 整合 useSession（会话管理）、useMessage（消息发送）、图片处理
import { useCallback, useEffect } from 'react';
import { useFeedback } from '../components/ui/feedback';
import { useSession } from './useSession';
import { useMessage } from './useMessage';
import { compressImages } from '../utils/image';
import { usePreviewProjectStore } from '../stores/previewProjectStore.ts';

export function useChat() {
  const { notify } = useFeedback();
  const {
    sessions,
    sessionId,
    isSessionReady,
    fetchSessions,
    loadHistory,
    initSession,
    selectSession: selectSessionBase,
    createNewSession: createNewSessionBase,
    deleteSessionById: deleteSessionByIdBase,
  } = useSession();

  const {
    messages,
    input,
    setInput,
    pendingImages,
    isLoading,
    contextRemain,
    modelQuotaInfo,
    projectChanges,
    projectRevision,
    previewRevision,
    fileInputRef,
    handleSend: handleSendBase,
    handleStop,
    handleImageSelect: handleImageSelectBase,
    removePendingImage,
    triggerFileInput,
    setMessagesList,
    clearInput,
  } = useMessage(sessionId);

  /**
   * 页面初始化
   */
  const initApp = useCallback(async () => {
    const sid = await initSession();
    if (sid) {
      const history = await loadHistory(sid);
      setMessagesList(history);
    }
  }, [initSession, loadHistory, setMessagesList]);

  /**
   * 切换会话
   */
  const selectSession = useCallback(
    async (sid: string) => {
      const success = await selectSessionBase(sid, isLoading);
      if (success) {
        usePreviewProjectStore.getState().createProject('react');
        setMessagesList([]);
        const history = await loadHistory(sid);
        setMessagesList(history);
      }
    },
    [selectSessionBase, isLoading, loadHistory, setMessagesList],
  );

  /**
   * 创建新会话
   */
  const createNewSession = useCallback(async () => {
    const sid = await createNewSessionBase(isLoading);
    if (sid) {
      usePreviewProjectStore.getState().createProject('react');
      setMessagesList([]);
      clearInput();
    }
  }, [createNewSessionBase, isLoading, setMessagesList, clearInput]);

  /**
   * 删除会话
   */
  const deleteSessionById = useCallback(
    async (sid: string) => {
      const newSid = await deleteSessionByIdBase(sid);
      if (newSid && newSid !== sessionId) {
        usePreviewProjectStore.getState().createProject('react');
        setMessagesList([]);
        const history = await loadHistory(newSid);
        setMessagesList(history);
      }
    },
    [deleteSessionByIdBase, sessionId, loadHistory, setMessagesList],
  );

  /**
   * 处理图片文件选择（带压缩）
   */
  const handleImageSelect = useCallback(
    async (files: FileList | File[]) => {
      if (!files || files.length === 0) return;

      const imageFiles = Array.from(files).filter((f) => f.type.startsWith('image/'));
      if (imageFiles.length === 0) {
        notify('请选择图片文件');
        return;
      }

      try {
        const compressed = await compressImages(imageFiles);
        if (compressed.length > 0) {
          // 直接传入已压缩的文件给 base 方法
          await handleImageSelectBase(compressed.map((img) => img.file));
        }
      } catch (err) {
        notify('图片处理失败');
      }
    },
    [handleImageSelectBase, notify],
  );

  /**
   * 发送消息（包装 base 方法，添加 Toast 错误提示）
   */
  const handleSend = useCallback(
    async (presetText?: string) => {
      if (!sessionId) {
        notify('会话未初始化，请刷新页面');
        return;
      }
      await handleSendBase(presetText);
      // 刷新会话列表（标题可能已更新）
      await fetchSessions();
    },
    [sessionId, handleSendBase, fetchSessions, notify],
  );

  // 组件卸载时清理
  useEffect(() => {
    return () => {
      handleStop();
    };
  }, [handleStop]);

  return {
    // 会话状态
    sessions,
    sessionId,
    isSessionReady,
    // 消息状态
    messages,
    input,
    setInput,
    pendingImages,
    isLoading,
    contextRemain,
    modelQuotaInfo,
    projectChanges,
    projectRevision,
    previewRevision,
    fileInputRef,
    // 会话方法
    initApp,
    selectSession,
    createNewSession,
    deleteSessionById,
    fetchSessions,
    // 消息方法
    handleSend,
    handleStop,
    handleImageSelect,
    removePendingImage,
    triggerFileInput,
  };
}

export default useChat;
