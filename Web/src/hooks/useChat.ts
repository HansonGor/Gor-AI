// 聊天状态管理 Hook（组合入口）
// 整合 useSession（会话管理）、useMessage（消息发送）、图片处理
import { useCallback, useEffect, useRef, useState } from 'react';
import { useFeedback } from '../components/ui/feedback';
import { useSession } from './useSession';
import { useMessage } from './useMessage';
import { uploadSessionAttachment } from '../api/chat';
import { compressImages } from '../utils/image';
import { usePreviewProjectStore } from '../stores/previewProjectStore.ts';
import { deleteSessionPreview } from '../utils/sessionPreviewStorage.ts';
import type { UploadedAttachment } from '../types';

export function useChat() {
  const { notify } = useFeedback();
  const [isSessionCacheLoading, setIsSessionCacheLoading] = useState(true);
  const sessionCacheRequestRef = useRef(0);
  const {
    sessions,
    sessionId,
    isSessionReady,
    fetchSessions,
    loadHistory,
    initSession,
    selectSession: selectSessionBase,
    createNewSession: createNewSessionBase,
    waitForSessionCreation,
    isSessionActive,
    deleteSessionById: deleteSessionByIdBase,
  } = useSession();

  const {
    messages,
    fileEditMode,
    fileEditModeLoading,
    setFileEditMode,
    thinkingMode,
    thinkingModeLoading,
    setThinkingMode,
    chatModelId,
    chatModelLoading,
    setChatModel,
    input,
    setInput,
    pendingImages,
    pendingUploadAttachments,
    isLoading,
    contextRemain,
    modelQuotaInfo,
    projectChanges,
    projectRevision,
    previewRevision,
    fileInputRef,
    handleSend: handleSendBase,
    queueUploadSummary: queueUploadSummaryBase,
    clearPendingUploadSummary,
    addGeneratedFileToLatestAssistant,
    hasPendingUploadSummary,
    handleStop,
    handleImageSelect: handleImageSelectBase,
    removePendingImage,
    triggerFileInput,
    setMessagesList,
    clearInput,
  } = useMessage(sessionId);

  const loadSessionCache = useCallback(async (sid: string) => {
    const requestId = ++sessionCacheRequestRef.current;
    setIsSessionCacheLoading(true);
    try {
      const history = await loadHistory(sid);
      if (requestId === sessionCacheRequestRef.current) setMessagesList(history);
    } finally {
      if (requestId === sessionCacheRequestRef.current) setIsSessionCacheLoading(false);
    }
  }, [loadHistory, setMessagesList]);

  /**
   * 页面初始化
   */
  const initApp = useCallback(async () => {
    const sid = await initSession();
    if (sid) {
      await loadSessionCache(sid);
    } else {
      setIsSessionCacheLoading(false);
    }
  }, [initSession, loadSessionCache]);

  /**
   * 切换会话
   */
  const selectSession = useCallback(
    async (sid: string) => {
      const success = await selectSessionBase(sid, isLoading);
      if (success) {
        usePreviewProjectStore.getState().clearProject();
        setMessagesList([]);
        await loadSessionCache(sid);
      }
    },
    [selectSessionBase, isLoading, loadSessionCache, setMessagesList],
  );

  /**
   * 创建新会话
   */
  const createNewSession = useCallback(async () => {
    const previousSessionId = sessionId;
    const sid = await createNewSessionBase(isLoading);
    if (sid) {
      sessionCacheRequestRef.current += 1;
      setIsSessionCacheLoading(false);
      usePreviewProjectStore.getState().clearProject();
      setMessagesList([]);
      clearInput();
      void waitForSessionCreation(sid).then((created) => {
        if (!created && previousSessionId && isSessionActive(previousSessionId)) {
          void loadSessionCache(previousSessionId);
        }
      });
    }
  }, [createNewSessionBase, isLoading, sessionId, setMessagesList, clearInput, waitForSessionCreation, isSessionActive, loadSessionCache]);

  /**
   * 删除会话
   */
  const deleteSessionById = useCallback(
    async (sid: string) => {
      const newSid = await deleteSessionByIdBase(sid);
      if (newSid) {
        void deleteSessionPreview(sid).catch((error) => console.warn('[Preview] 清理已删除会话缓存失败:', error));
      }
      if (newSid && newSid !== sessionId) {
        usePreviewProjectStore.getState().clearProject();
        setMessagesList([]);
        await loadSessionCache(newSid);
      }
    },
    [deleteSessionByIdBase, sessionId, loadSessionCache, setMessagesList],
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

  const queueUploadSummary = useCallback((
    prompt: string,
    images?: string[],
    displayText?: string,
    analysisContext?: string,
    attachments?: UploadedAttachment[],
  ) => {
    queueUploadSummaryBase(prompt, images, displayText, analysisContext, attachments);
  }, [queueUploadSummaryBase]);

  const handleSummarizeImages = useCallback(async (files: File[]) => {
    if (!sessionId) throw new Error('会话尚未准备好，请稍后重试。');
    if (!(await waitForSessionCreation(sessionId))) throw new Error('新会话创建失败，请重试。');
    const compressed = await compressImages(files);
    if (compressed.length === 0) throw new Error('没有可供概述的图片。');
    const displayText = '';
    const prompt = '请根据上传的图片，用中文简洁概述画面主要内容，最多 2 句话。不要输出代码、路径或文件清单；无法确定时请说明。';
    const storedAttachments = await Promise.all(compressed.map(({ file, name }) =>
      uploadSessionAttachment(sessionId, file, name, 'file'),
    ));
    queueUploadSummary(
      prompt,
      compressed.map((image) => image.base64),
      displayText,
      prompt,
      storedAttachments,
    );
  }, [queueUploadSummary, sessionId, waitForSessionCreation]);

  /**
   * 发送消息（包装 base 方法，添加 Toast 错误提示）
   */
  const handleSend = useCallback(
    async (presetText?: string) => {
      if (!sessionId) {
        notify('会话未初始化，请刷新页面');
        return;
      }
      if (!(await waitForSessionCreation(sessionId))) return;
      await handleSendBase(presetText);
      // 刷新会话列表（标题可能已更新）
      await fetchSessions();
    },
    [sessionId, waitForSessionCreation, handleSendBase, fetchSessions, notify],
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
    isSessionCacheLoading,
    // 消息状态
    messages,
    fileEditMode,
    fileEditModeLoading,
    setFileEditMode,
    thinkingMode,
    thinkingModeLoading,
    setThinkingMode,
    chatModelId,
    chatModelLoading,
    setChatModel,
    input,
    setInput,
    pendingImages,
    pendingUploadAttachments,
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
    waitForSessionCreation,
    // 消息方法
    handleSend,
    queueUploadSummary,
    clearPendingUploadSummary,
    addGeneratedFileToLatestAssistant,
    hasPendingUploadSummary,
    handleSummarizeImages,
    handleStop,
    handleImageSelect,
    removePendingImage,
    triggerFileInput,
  };
}

export default useChat;
