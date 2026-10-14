import { Check } from 'lucide-react';
import { isToolStatusInThinking } from '../../utils/thinking';
// 消息列表 — Tailwind 布局
import { useRef, useEffect, useCallback } from 'react';
import MessageBubble from './MessageBubble';
import type { MessageListProps } from '../../types';
import { isShareableMessage } from '../../share/shareContent';

export default function MessageList({ messages, shareSelection, currentPreviewProject, onPreviewFile, onPreviewProject, onPreviewAttachment }: MessageListProps) {
  const listRef = useRef<HTMLDivElement | null>(null);
  const latestAssistantMessageId = [...messages].reverse().find((message) => message.role === 'assistant')?.id;
  // Thinking deltas update their bounded panel, without moving the conversation.
  const scrollRevision = messages.map(message => [message.id, message.content,
    isToolStatusInThinking(message, false) ? '' : message.toolStatus,
    message.isStreaming, message.files?.length, message.projectChanges?.length, message.previewChanges?.length].join(':')).join('|');

  // 只滚动消息容器，不影响页面整体布局
  const scrollToBottom = useCallback(() => {
    const container = listRef.current?.parentElement;
    if (container) {
      container.scrollTop = container.scrollHeight;
    }
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [scrollRevision, scrollToBottom]);

  return (
    <div
      ref={listRef}
      className="message-list mx-auto flex w-full max-w-[1080px] flex-col gap-[0.24rem] px-[0.06rem] pb-[0.3rem] pt-[0.1rem] lg:gap-4 lg:px-0 lg:pb-6"
    >
      {messages.map((msg, index) => {
        const bubble = <MessageBubble
          key={msg.id}
          message={msg}
          currentPreviewProject={msg.id === latestAssistantMessageId ? currentPreviewProject : undefined}
          uploadedAttachments={msg.role === 'assistant' && messages[index - 1]?.role === 'user'
            ? messages[index - 1].attachments
            : undefined}
          onPreviewFile={onPreviewFile}
          onPreviewProject={onPreviewProject}
          onPreviewAttachment={onPreviewAttachment}
        />;
        return <div key={msg.id} className={shareSelection ? 'chat-share-row' : undefined} style={shareSelection ? undefined : { display: 'contents' }}>
          {shareSelection && (isShareableMessage(msg)
            ? <label className="chat-share-checkbox-target" onClick={(event) => event.stopPropagation()}>
                <input type="checkbox" className="chat-share-checkbox"
                  aria-label={`选择${msg.role === 'user' ? '提问' : 'Gor 回答'} ${index + 1}`}
                  checked={shareSelection.selectedIds.has(msg.id)} onChange={() => shareSelection.onToggle(msg.id)} />
                <span className="chat-share-checkbox-visual" aria-hidden="true">
                  <Check size={14} strokeWidth={1.8} />
                </span>
              </label>
            : null)}
          {bubble}
        </div>;
      })}
    </div>
  );
}
