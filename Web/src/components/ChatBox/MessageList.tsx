// 消息列表 — Tailwind 布局
import { useRef, useEffect, useCallback } from 'react';
import MessageBubble from './MessageBubble';
import type { MessageListProps } from '../../types';

export default function MessageList({ messages, currentPreviewProject, onPreviewFile, onPreviewProject, onPreviewAttachment }: MessageListProps) {
  const listRef = useRef<HTMLDivElement | null>(null);
  const latestAssistantMessageId = [...messages].reverse().find((message) => message.role === 'assistant')?.id;

  // 只滚动消息容器，不影响页面整体布局
  const scrollToBottom = useCallback(() => {
    const container = listRef.current?.parentElement;
    if (container) {
      container.scrollTop = container.scrollHeight;
    }
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, scrollToBottom]);

  return (
    <div
      ref={listRef}
      className="message-list mx-auto flex w-full max-w-[1080px] flex-col gap-[0.24rem] px-[0.06rem] pb-[0.3rem] pt-[0.1rem] lg:gap-4 lg:px-0 lg:pb-6"
    >
      {messages.map((msg, index) => (
        <MessageBubble
          key={msg.id}
          message={msg}
          currentPreviewProject={msg.id === latestAssistantMessageId ? currentPreviewProject : undefined}
          uploadedAttachments={msg.role === 'assistant' && messages[index - 1]?.role === 'user'
            ? messages[index - 1].attachments
            : undefined}
          onPreviewFile={onPreviewFile}
          onPreviewProject={onPreviewProject}
          onPreviewAttachment={onPreviewAttachment}
        />
      ))}
    </div>
  );
}
