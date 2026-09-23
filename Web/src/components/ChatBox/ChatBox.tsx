// 聊天框主容器
import WelcomeScreen from './WelcomeScreen';
import MessageList from './MessageList';
import InputArea from './InputArea';
import type { ChatBoxProps } from '../../types';
import './ChatBox.less';

export default function ChatBox({
  messages,
  input,
  setInput,
  pendingImages,
  isLoading,
  handleSend,
  handleStop,
  handleImageSelect,
  removePendingImage,
  onPreviewFile,
  onPreviewProject,
}: ChatBoxProps) {
  return (
    <div className="relative flex h-full w-full flex-col">
      {/* 消息区域 */}
      <div className="messages-container flex-1 overflow-y-auto overflow-x-hidden px-[0.24rem] py-[0.24rem] lg:px-8 lg:py-6">
        {messages.length === 0 ? (
          <WelcomeScreen onPromptClick={handleSend} />
        ) : (
          <MessageList messages={messages} onPreviewFile={onPreviewFile} onPreviewProject={onPreviewProject} />
        )}
      </div>

      {/* 输入区域 */}
      <div className="input-dock">
        <InputArea
          input={input}
          setInput={setInput}
          isLoading={isLoading}
          pendingImages={pendingImages}
          onSend={handleSend}
          onStop={handleStop}
          onImageSelect={handleImageSelect}
          onRemoveImage={removePendingImage}
        />
      </div>
    </div>
  );
}
