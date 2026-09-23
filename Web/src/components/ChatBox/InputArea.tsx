// 输入区域
import { useRef, useEffect } from 'react';
import { Upload, Send, Square, X } from 'lucide-react';
import { CHAT_CONFIG } from '../../config';
import type { InputAreaProps } from '../../types';
import { Button } from '../ui/button';
import { Textarea } from '../ui/textarea';

const { INPUT_MAX_HEIGHT } = CHAT_CONFIG;

export default function InputArea({
  input,
  setInput,
  isLoading,
  pendingImages,
  onSend,
  onStop,
  onImageSelect,
  onRemoveImage,
}: InputAreaProps) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const triggerFileInput = () => {
    fileInputRef.current?.click();
  };

  useEffect(() => {
    const ta = textareaRef.current;
    if (ta) {
      ta.style.height = 'auto';
      ta.style.height = Math.min(ta.scrollHeight, INPUT_MAX_HEIGHT) + 'px';
    }
  }, [input]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      onSend();
    }
  };

  const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const imageFiles: File[] = [];
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (file) imageFiles.push(file);
      }
    }
    if (imageFiles.length > 0) {
      e.preventDefault();
      onImageSelect(imageFiles);
    }
  };

  const canSend = (input.trim() || pendingImages.length > 0) && !isLoading;

  return (
    <div className="input-area relative px-[0.24rem] pb-[calc(0.16rem+env(safe-area-inset-bottom))] pt-[0.12rem] lg:px-0 lg:pt-3">
      {pendingImages.length > 0 && (
        <div className="image-preview-bar flex flex-wrap gap-[0.12rem] pb-[0.1rem]">
          {pendingImages.map((img, idx) => (
            <div key={idx} className="image-preview-item">
              <img src={img.base64} alt={img.name} />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="image-remove-btn"
                onClick={() => onRemoveImage(idx)}
                title="移除"
                aria-label={`移除图片 ${img.name}`}
              >
                <X aria-hidden="true" />
              </Button>
            </div>
          ))}
        </div>
      )}

      <div className="input-wrapper flex items-end gap-[0.12rem] rounded-2xl border border-white/10 bg-white/[0.08] px-[0.2rem] py-[0.15rem] transition-all focus-within:border-[#667eea]/40 focus-within:bg-white/[0.12] focus-within:shadow-md focus-within:shadow-purple-500/10 lg:px-5 lg:py-3.5">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="upload-btn relative z-10 flex h-[0.6rem] w-[0.6rem] shrink-0 self-center cursor-pointer items-center justify-center rounded-full border-none bg-transparent text-white/70 transition-all hover:bg-white/10 hover:text-white active:scale-95"
          onClick={triggerFileInput}
          title="上传文件"
          aria-label="上传文件"
        >
          <Upload size={20} />
        </Button>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={(e) => {
            if (e.target.files && e.target.files.length > 0) {
              onImageSelect(e.target.files);
            }
            e.target.value = '';
          }}
        />

        <Textarea
          ref={textareaRef}
          className="chat-input min-h-0 min-w-0 flex-1 resize-none overflow-hidden border-0 bg-transparent pb-[0.12rem] pl-[0.08rem] pr-0 pt-[0.12rem] text-[0.28rem] leading-[1.6] text-[#f5f5f7] shadow-none outline-none ring-0 placeholder:text-white/40 focus-visible:ring-0 disabled:opacity-50"
          style={{ maxHeight: `${INPUT_MAX_HEIGHT}px` }}
          placeholder="输入消息，Enter 发送，Shift + Enter 换行"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          rows={1}
          disabled={isLoading}
        />
        {isLoading ? (
          <Button
            type="button"
            variant="secondary"
            size="icon"
            className="send-btn send-btn-stop flex h-[0.78rem] w-[0.78rem] shrink-0 cursor-pointer items-center justify-center rounded-full border-none bg-white/15 text-white transition-all active:scale-95"
            onClick={onStop}
            aria-label="停止生成"
            title="停止"
          >
            <Square size={18} fill="currentColor" />
          </Button>
        ) : (
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="send-btn flex h-[0.78rem] w-[0.78rem] shrink-0 cursor-pointer items-center justify-center rounded-full border border-white/10 bg-[#1b1b2b] text-[#a78bfa] shadow-[0_0.06rem_0.2rem_rgba(0,0,0,0.4)] transition-all hover:border-white/20 hover:bg-[#232336] hover:text-[#c4b5fd] active:scale-95 disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none"
            onClick={() => onSend()}
            disabled={!canSend}
            aria-label="发送消息"
            title="发送"
          >
            <Send size={19} />
          </Button>
        )}
      </div>
    </div>
  );
}
