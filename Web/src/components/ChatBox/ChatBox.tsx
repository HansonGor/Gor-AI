// 聊天框主容器
import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowDownToLine } from 'lucide-react';
import WelcomeScreen from './WelcomeScreen';
import MessageList from './MessageList';
import InputArea from './InputArea';
import type { ChatBoxProps } from '../../types';
import './ChatBox.less';

export default function ChatBox({
  messages,
  currentPreviewProject,
  input,
  setInput,
  pendingImages,
  pendingUploadAttachments,
  isLoading,
  handleSend,
  handleStop,
  handleImageSelect,
  removePendingImage,
  onPreviewFile,
  onPreviewProject,
  onPreviewAttachment,
  onArchiveSelect,
  onFolderSelect,
  onUploadImages,
  importedUploadName,
  hasPendingUploadSummary,
  onRemoveImportedUpload,
  onClearPendingUpload,
}: ChatBoxProps) {
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);

  const jumpToLatestMessage = useCallback(() => {
    const container = messagesContainerRef.current;
    if (container) container.scrollTo({ top: container.scrollHeight, behavior: 'smooth' });
  }, []);

  useEffect(() => {
    const container = messagesContainerRef.current;
    if (!container) return;

    const updateScrollButton = () => {
      const distanceToBottom = container.scrollHeight - container.clientHeight - container.scrollTop;
      setShowScrollToBottom(distanceToBottom > 72);
    };

    updateScrollButton();
    container.addEventListener('scroll', updateScrollButton, { passive: true });

    const resizeObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(updateScrollButton);
    resizeObserver?.observe(container);
    const messageList = container.querySelector('.message-list');
    if (messageList) resizeObserver?.observe(messageList);

    return () => {
      container.removeEventListener('scroll', updateScrollButton);
      resizeObserver?.disconnect();
    };
  }, [messages.length]);

  return (
    <div className="relative flex h-full w-full flex-col">
      {/* 消息区域 */}
      <div ref={messagesContainerRef} className="messages-container flex-1 overflow-y-auto overflow-x-hidden px-[0.24rem] py-[0.24rem] lg:px-8 lg:py-6">
        {messages.length === 0 ? (
          <WelcomeScreen onPromptClick={handleSend} />
        ) : (
          <MessageList messages={messages} currentPreviewProject={currentPreviewProject} onPreviewFile={onPreviewFile} onPreviewProject={onPreviewProject} onPreviewAttachment={onPreviewAttachment} />
        )}
      </div>

      {/* 输入区域 */}
      <div className="input-dock">
        {messages.length > 0 && (
          <button
            type="button"
            className={`chat-scroll-to-bottom ${showScrollToBottom ? 'is-visible' : ''}`}
            onClick={jumpToLatestMessage}
            aria-label="滚动到最新消息"
            title="滚动到最新消息"
            aria-hidden={!showScrollToBottom}
            tabIndex={showScrollToBottom ? 0 : -1}
          >
            <ArrowDownToLine aria-hidden="true" />
          </button>
        )}
        <InputArea
          input={input}
          setInput={setInput}
          isLoading={isLoading}
          pendingImages={pendingImages}
          pendingUploadAttachments={pendingUploadAttachments}
          onSend={handleSend}
          onStop={handleStop}
          onImageSelect={handleImageSelect}
          onRemoveImage={removePendingImage}
          onArchiveSelect={onArchiveSelect}
          onFolderSelect={onFolderSelect}
          onUploadImages={onUploadImages}
          importedUploadName={importedUploadName}
          hasPendingUploadSummary={hasPendingUploadSummary}
          onRemoveImportedUpload={onRemoveImportedUpload}
          onClearPendingUpload={onClearPendingUpload}
        />
      </div>
    </div>
  );
}
