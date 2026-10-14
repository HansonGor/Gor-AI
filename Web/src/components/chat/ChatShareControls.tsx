import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { CheckCheck, Download, Image as ImageIcon, LoaderCircle, X } from 'lucide-react';
import { Button } from '../ui/button';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogTitle,
  AlertDialogDescription,
} from '../ui/alert-dialog';
import type { useChatShare } from '../../share/useChatShare';
import type { SaveFileOptions } from '../../preview/core/saveFile';
import './ChatShare.less';

type ShareState = ReturnType<typeof useChatShare>;
export function ChatShareToolbar({ share }: { share: ShareState }) {
  const slotRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const slot = slotRef.current;
    const dock = slot?.closest('.input-dock') as HTMLElement | null;
    if (!slot || !dock) return;
    const measure = () => dock.style.setProperty('--chat-share-toolbar-height', `${slot.getBoundingClientRect().height}px`);
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(slot);
    return () => {
      observer?.disconnect();
      dock.style.removeProperty('--chat-share-toolbar-height');
    };
  }, [share.selecting]);
  return (
    share.selecting && (
      <div ref={slotRef} className="chat-share-toolbar-slot">
        <div className="chat-share-toolbar" role="region" aria-label="分享消息选择">
          <button
            type="button"
            className="chat-share-count"
            disabled={!share.count}
            onClick={share.clearAll}
            aria-label="取消全部勾选"
          >
            <CheckCheck size={16} aria-hidden="true" />
            <span aria-live="polite">已选 {share.count} 条</span>
          </button>
          <span className="chat-share-actions">
            <Button variant="ghost" className="chat-share-cancel" onClick={share.cancel}>
              取消
            </Button>
            <Button
              className="chat-share-generate"
              disabled={!share.count || share.busy}
              onClick={() => void share.generate()}
            >
              <ImageIcon size={16} aria-hidden="true" />
              生成分享图
            </Button>
          </span>
        </div>
      </div>
    )
  );
}
export function ChatSharePreview({
  share,
  save,
}: {
  share: ShareState;
  save: (options: SaveFileOptions) => Promise<boolean>;
}) {
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  useEffect(() => {
    if (share.open) setSaveError('');
  }, [share.open]);
  const download = async () => {
    if (!share.image || saving) return;
    setSaving(true);
    setSaveError('');
    try {
      await save({ suggestedName: 'Gor-聊天.png', blob: share.image.blob });
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : '保存失败，请重试。');
    } finally {
      setSaving(false);
    }
  };
  const closePreview = () => {
    if (saving) return;
    setSaveError('');
    share.close();
  };
  return (
    <AlertDialog
      open={share.open}
      onOpenChange={(open) => {
        if (!open) closePreview();
      }}
    >
      <AlertDialogContent
        className="chat-share-preview"
        onEscapeKeyDown={(event) => {
          if (saving) event.preventDefault();
        }}
      >
        <div className="chat-share-preview-header">
          <div className="chat-share-preview-heading">
            <AlertDialogTitle>一纸对话 · 万千思绪</AlertDialogTitle>
            <AlertDialogDescription>
              预览与下载使用同一份图片，聊天正文仅在本地生成。
            </AlertDialogDescription>
          </div>
          <div className="chat-share-preview-top-actions">
            <button
              type="button"
              className="chat-share-icon-btn chat-share-icon-btn--download"
              onClick={() => void download()}
              disabled={!share.image || saving}
              aria-label="下载 PNG"
              title="下载 PNG"
            >
              {saving ? (
                <LoaderCircle size={18} strokeWidth={1.7} className="animate-spin" aria-hidden="true" />
              ) : (
                <Download size={18} strokeWidth={1.7} aria-hidden="true" />
              )}
            </button>
            <button
              type="button"
              className="chat-share-icon-btn chat-share-icon-btn--close"
              onClick={closePreview}
              disabled={saving}
              aria-label="关闭预览"
              title="关闭"
            >
              <X size={18} strokeWidth={1.7} aria-hidden="true" />
            </button>
          </div>
        </div>
        {share.busy && (
          <div role="status" className="chat-share-preview-status">
            <LoaderCircle size={18} className="animate-spin" />
            正在铺展长卷…
          </div>
        )}
        {(share.error || saveError) && (
          <p role="alert" className="chat-share-error">
            {share.error || saveError}
          </p>
        )}
        {share.error && (
          <Button className="chat-share-retry" onClick={() => void share.generate()}>
            重新生成
          </Button>
        )}
        <div className="chat-share-preview-image">
          {share.image && <img src={share.image.url} alt="聊天长图预览" />}
        </div>
      </AlertDialogContent>
    </AlertDialog>
  );
}
