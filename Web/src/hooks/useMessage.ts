// 消息发送与 SSE 接收 Hook
// 负责发送消息、接收 SSE 流式响应、管理消息状态
import { useState, useRef, useCallback, useEffect } from 'react';
import { useFeedback } from '../components/ui/feedback';
import { sendChatMessage } from '../api/chat';
import { MODEL_CONFIG } from '../config';
import { useVideoPolling } from './useVideoPolling';
import type {
  ChatMessage,
  TokenUsage,
  ModelQuotaInfo,
  ProjectChange,
  PreviewFileChange,
  GeneratedFile,
} from '../types';
import { usePreviewProjectStore } from '../stores/previewProjectStore.ts';

const { QUOTA_WARNING_THRESHOLD } = MODEL_CONFIG;

interface PendingImage {
  file: File;
  name: string;
  base64: string;
}

interface ContextRemain {
  prompt_tokens: number;
  max_context: number;
  remain_token: number;
  warning: boolean;
}

export function useMessage(sessionId: string | null) {
  const { alert } = useFeedback();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  // 使用 ref 跟踪 messages 最新值，避免 useCallback 依赖 messages 导致重渲染循环
  const messagesRef = useRef(messages);
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);
  const [input, setInput] = useState('');
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [contextRemain, setContextRemain] = useState<ContextRemain | null>(null);
  const [modelQuotaInfo, setModelQuotaInfo] = useState<ModelQuotaInfo | null>(null);
  const [projectChanges, setProjectChanges] = useState<ProjectChange[]>([]);
  const [projectRevision, setProjectRevision] = useState(0);
  const [previewRevision, setPreviewRevision] = useState(0);

  const abortRef = useRef<AbortController | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const { startVideoPolling, stopVideoPolling } = useVideoPolling();

  /**
   * 更新最后一条 assistant 消息
   */
  const updateLastAssistant = useCallback((updater: (last: ChatMessage) => ChatMessage) => {
    setMessages((prev) => {
      const updated = [...prev];
      const lastIndex = updated.length - 1;
      if (lastIndex >= 0 && updated[lastIndex].role === 'assistant') {
        updated[lastIndex] = updater(updated[lastIndex]);
      }
      return updated;
    });
  }, []);

  /**
   * 处理图片文件选择
   */
  const handleImageSelect = useCallback(async (files: FileList | File[]) => {
    if (!files || files.length === 0) return;

    const imageFiles = Array.from(files).filter((f) => f.type.startsWith('image/'));
    if (imageFiles.length === 0) {
      return;
    }

    const processed: PendingImage[] = imageFiles.map((file) => ({
      file,
      name: file.name,
      base64: URL.createObjectURL(file),
    }));
    setPendingImages((prev) => [...prev, ...processed]);
  }, []);

  /**
   * 移除待发送的图片
   */
  const removePendingImage = useCallback((index: number) => {
    setPendingImages((prev) => prev.filter((_, i) => i !== index));
  }, []);

  /**
   * 触发文件选择
   */
  const triggerFileInput = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  /**
   * 设置消息列表（用于加载历史消息）
   */
  const setMessagesList = useCallback((msgList: ChatMessage[]) => {
    setMessages(msgList);
    setProjectChanges([]);
  }, []);

  /**
   * 清空输入和待发送图片
   */
  const clearInput = useCallback(() => {
    setInput('');
    setPendingImages([]);
  }, []);

  /**
   * 发送消息
   */
  const handleSend = useCallback(
    async (presetText?: string) => {
      const content = (presetText ?? input).trim();
      const hasImages = pendingImages.length > 0;

      if ((!content && !hasImages) || isLoading) return;

      if (!sessionId) {
        console.error('[Message] 会话未初始化');
        return;
      }

      const userMsg: ChatMessage = {
        id: Date.now().toString(),
        role: 'user',
        content: content || '（图片）',
        images: hasImages ? pendingImages.map((img) => img.base64) : undefined,
      };
      const assistantMsg: ChatMessage & { isStreaming?: boolean; toolStatus?: string } = {
        id: (Date.now() + 1).toString(),
        role: 'assistant',
        content: '',
        isStreaming: true,
        toolStatus: '',
      };

      setMessages((prev) => [...prev, userMsg, assistantMsg]);
      setInput('');
      setPendingImages([]);
      setIsLoading(true);

      // 构建历史消息（包含图片）——使用 messagesRef 避免依赖 messages
      const history = [...messagesRef.current, userMsg].map((m) => ({
        role: m.role,
        content: m.content,
        images: m.images,
      }));

      const controller = new AbortController();
      abortRef.current = controller;
      let previewFilesChanged = false;

      try {
        await sendChatMessage(
          {
            sessionId,
            message: content,
            messages: history,
            previewProject: structuredClone(usePreviewProjectStore.getState().project),
          },
          {
            onToken: (tokenContent: string) => {
              updateLastAssistant((last) => ({
                ...last,
                content: last.content + tokenContent,
                toolStatus: '',
              }));
            },
            onToolStart: (name: string, _args: string) => {
              updateLastAssistant((last) => ({
                ...last,
                toolStatus: `正在调用 ${name}...`,
              }));
              if (name === 'generate_xiaoyunque_video') {
                startVideoPolling(
                  (videoUrl: string) => {
                    updateLastAssistant((last) => ({
                      ...last,
                      content: last.content + `\n\n视频生成完成：${videoUrl}`,
                      isStreaming: false,
                    }));
                  },
                  (status: string) => {
                    updateLastAssistant((last) => ({
                      ...last,
                      toolStatus: status,
                    }));
                  },
                );
              }
            },
            onToolEnd: () => {
              updateLastAssistant((last) => ({
                ...last,
                toolStatus: '',
              }));
            },
            onFileReady: (fileInfo: GeneratedFile) => {
              updateLastAssistant((last) => ({
                ...last,
                file: fileInfo,
                files: [
                  ...(last.files ?? []).filter((item) => item.downloadUrl !== fileInfo.downloadUrl),
                  fileInfo,
                ],
              }));
            },
            onProjectFileChanged: (change: ProjectChange) => {
              setProjectChanges((previous) => [
                ...previous.filter((item) => item.path !== change.path),
                change,
              ]);
              setProjectRevision((revision) => revision + 1);
              updateLastAssistant((last) => ({
                ...last,
                projectChanges: [...(last.projectChanges ?? []), change],
              }));
            },
            onPreviewFileChanged: (change: PreviewFileChange & { content: string }) => {
              if (!usePreviewProjectStore.getState().applyAiFileChange(change)) return;
              previewFilesChanged = true;
              setPreviewRevision((revision) => revision + 1);
              updateLastAssistant((last) => ({
                ...last,
                previewChanges: [
                  ...(last.previewChanges ?? []).filter((item) => item.path !== change.path),
                  { projectId: change.projectId, path: change.path, diff: change.diff },
                ],
              }));
            },
            onVideoReady: (videoInfo: any) => {
              updateLastAssistant((last) => ({
                ...last,
                videoUrl: videoInfo.videoUrl,
              }));
            },
            onToolProgress: (_name: string, status: string) => {
              updateLastAssistant((last) => ({
                ...last,
                toolStatus: status,
              }));
            },
            onTokenUsage: (usage: TokenUsage) => {
              updateLastAssistant((last) => ({
                ...last,
                tokenUsage: usage,
              }));
            },
            onContextRemain: (contextInfo: ContextRemain) => {
              setContextRemain(contextInfo);
              updateLastAssistant((last) => ({
                ...last,
                contextRemain: contextInfo,
              }));
              if (contextInfo.warning) {
                alert({
                  title: '上下文空间即将耗尽',
                  description: `当前剩余上下文 token：${contextInfo.remain_token}，低于 10000。建议新建会话，否则会触发消息裁剪或者调用报错。`,
                });
              }
            },
            onModelQuotaInfo: (quotaInfo: ModelQuotaInfo) => {
              setModelQuotaInfo(quotaInfo);
              updateLastAssistant((last) => ({
                ...last,
                modelQuotaInfo: quotaInfo,
              }));
              if (quotaInfo.new_remain <= QUOTA_WARNING_THRESHOLD) {
                alert({
                  title: '模型额度即将耗尽',
                  description: `${quotaInfo.model_name} 当前剩余 token：${quotaInfo.new_remain}，低于 ${QUOTA_WARNING_THRESHOLD}。请留意充值，否则可能无法继续对话。`,
                });
              }
            },
            onDone: () => {
              if (previewFilesChanged) usePreviewProjectStore.getState().requestBuildAndRun();
              updateLastAssistant((last) => ({
                ...last,
                isStreaming: false,
                toolStatus: '',
              }));
            },
            onError: (err: Error) => {
              updateLastAssistant((last) => ({
                ...last,
                content: last.content + `\n\n错误：${err.message || '服务异常'}`,
                isStreaming: false,
                toolStatus: '',
              }));
            },
          },
          controller.signal,
        );
      } catch (err: any) {
        if (err.name !== 'AbortError') {
          console.error('[Message] 发送消息失败:', err);
          updateLastAssistant((last) => ({
            ...last,
            content: `错误：${err.message || '发送失败，请重试'}`,
            isStreaming: false,
            toolStatus: '',
          }));
        }
      } finally {
        setIsLoading(false);
        abortRef.current = null;
        stopVideoPolling();
      }
    },
    [
      input,
      isLoading,
      pendingImages,
      sessionId,
      updateLastAssistant,
      startVideoPolling,
      stopVideoPolling,
      alert,
    ],
  );

  /**
   * 停止生成
   */
  const handleStop = useCallback(() => {
    abortRef.current?.abort();
    stopVideoPolling();
  }, [stopVideoPolling]);

  return {
    // 状态
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
    // 方法
    handleSend,
    handleStop,
    handleImageSelect,
    removePendingImage,
    triggerFileInput,
    setMessagesList,
    clearInput,
  };
}

export default useMessage;
