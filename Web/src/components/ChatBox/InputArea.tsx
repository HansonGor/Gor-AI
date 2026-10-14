// 输入区域
import { useRef, useEffect, useLayoutEffect, useState, useCallback } from 'react';
import { Upload, Send, Square, X, FileArchive, FolderUp, Files, Plus, Info } from 'lucide-react';
import { CHAT_CONFIG } from '../../config';
import type { InputAreaProps } from '../../types';
import { Button } from '../ui/button';
import { Textarea } from '../ui/textarea';
import FileEditModeSelector from '../chat/FileEditModeSelector';

const { INPUT_MAX_HEIGHT } = CHAT_CONFIG;

export default function InputArea({
  input,
  setInput,
  isLoading,
  pendingImages,
  pendingUploadAttachments = [],
  onSend,
  onStop,
  onImageSelect,
  onRemoveImage,
  onArchiveSelect,
  onFolderSelect,
  onUploadImages,
  importedUploadName,
  hasPendingUploadSummary = false,
  onRemoveImportedUpload,
  onClearPendingUpload,
  fileEditMode,
  fileEditModeLoading,
  onFileEditModeChange,
}: InputAreaProps) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const importPopoverRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const folderInputRef = useRef<HTMLInputElement | null>(null);
  const archiveControllerRef = useRef<AbortController | null>(null);
  const [archiveStatus, setArchiveStatus] = useState('');
  const [archiveName, setArchiveName] = useState('');
  const [importDialogOpen, setImportDialogOpen] = useState(false);

  const resizeTextarea = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = 'auto';
    const contentHeight = textarea.scrollHeight;
    textarea.style.height = `${Math.min(contentHeight, INPUT_MAX_HEIGHT)}px`;
    textarea.style.overflowY = contentHeight > INPUT_MAX_HEIGHT ? 'auto' : 'hidden';
  }, []);

  const closeImportDialog = () => setImportDialogOpen(false);

  const triggerFileInput = () => {
    closeImportDialog();
    fileInputRef.current?.click();
  };

  const triggerFolderInput = () => {
    closeImportDialog();
    folderInputRef.current?.click();
  };

  const isImageFile = (file: File) => file.type.startsWith('image/') || /\.(?:png|jpe?g|gif|webp|avif|bmp|ico)$/i.test(file.name);

  const startImport = (name: string, importer: (signal: AbortSignal) => Promise<void>) => {
    archiveControllerRef.current?.abort();
    const controller = new AbortController();
    archiveControllerRef.current = controller;
    setArchiveName(name);
    setArchiveStatus('正在识别并导入…');
    void importer(controller.signal)
      .then(() => {
        if (!controller.signal.aborted) setArchiveStatus('导入完成');
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setArchiveStatus(error instanceof Error ? error.message : '导入失败');
      })
      .finally(() => {
        if (archiveControllerRef.current === controller) archiveControllerRef.current = null;
      });
  };

  const cancelArchive = () => {
    const shouldRemoveImportedProject = Boolean(importedUploadName)
      && (archiveStatus === '导入完成' || !archiveStatus);
    archiveControllerRef.current?.abort();
    archiveControllerRef.current = null;
    setArchiveName('');
    setArchiveStatus('');
    if (shouldRemoveImportedProject) onRemoveImportedUpload?.();
    else if (hasPendingUploadSummary) onClearPendingUpload?.();
  };

  useEffect(() => () => {
    archiveControllerRef.current?.abort();
    archiveControllerRef.current = null;
  }, []);

  useLayoutEffect(() => {
    resizeTextarea();
  }, [input, resizeTextarea]);

  useEffect(() => {
    const textarea = textareaRef.current;
    const panel = textarea?.closest('.chat-composer-panel');
    if (!textarea || !panel) return;
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', resizeTextarea);
      return () => window.removeEventListener('resize', resizeTextarea);
    }

    let previousWidth = panel.getBoundingClientRect().width;
    const observer = new ResizeObserver(([entry]) => {
      const nextWidth = entry?.contentRect.width ?? panel.getBoundingClientRect().width;
      if (Math.abs(nextWidth - previousWidth) < 1) return;
      previousWidth = nextWidth;
      resizeTextarea();
    });
    observer.observe(panel);
    return () => observer.disconnect();
  }, [resizeTextarea]);

  useEffect(() => {
    if (!importDialogOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setImportDialogOpen(false);
    };
    const closeOnOutsideClick = (event: MouseEvent) => {
      if (event.target instanceof Node && !importPopoverRef.current?.contains(event.target)) {
        setImportDialogOpen(false);
      }
    };
    window.addEventListener('keydown', closeOnEscape);
    window.addEventListener('mousedown', closeOnOutsideClick);
    return () => {
      window.removeEventListener('keydown', closeOnEscape);
      window.removeEventListener('mousedown', closeOnOutsideClick);
    };
  }, [importDialogOpen]);

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

  const canSend = (input.trim() || pendingImages.length > 0 || hasPendingUploadSummary) && !isLoading;

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

      <div className="input-wrapper chat-composer-panel">
        <div ref={importPopoverRef} className="relative z-20 flex shrink-0 self-center">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="upload-btn relative z-10 flex h-[0.6rem] w-[0.6rem] shrink-0 cursor-pointer items-center justify-center rounded-full border-none bg-transparent text-white/70 transition-all hover:bg-white/10 hover:text-white active:scale-95"
            onClick={() => setImportDialogOpen((open) => !open)}
            title="上传文件或项目"
            aria-label="上传文件或项目"
            aria-expanded={importDialogOpen}
            aria-haspopup="dialog"
          >
            <Plus size={22} />
          </Button>
          {importDialogOpen && (
            <section
              className="chat-import-popover absolute bottom-full left-0 mb-3 w-[min(520px,calc(100vw-24px))] overflow-hidden rounded-[24px] border border-border/80 bg-popover/95 p-3.5 text-popover-foreground shadow-[0_24px_80px_rgba(0,0,0,0.32)] backdrop-blur-2xl sm:p-4"
              role="dialog"
              aria-label="选择导入方式"
            >
              <div className="chat-import-dialog-header mb-3 flex items-center justify-between gap-3 px-1 pb-1">
                <div className="flex min-w-0 items-center gap-3">
                  <span className="chat-import-dialog-mark flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-primary/10 text-primary ring-1 ring-primary/10"><Upload size={20} /></span>
                  <div className="min-w-0">
                    <h2 className="text-base font-semibold tracking-tight">导入文件</h2>
                    <p className="mt-0.5 text-xs text-muted-foreground">选择单个文件，或导入完整项目文件夹。</p>
                  </div>
                </div>
                <Button type="button" variant="ghost" size="icon" className="h-9 w-9 shrink-0 rounded-full text-muted-foreground hover:bg-muted hover:text-foreground" onClick={closeImportDialog} aria-label="关闭导入选项">
                  <X size={16} />
                </Button>
              </div>

              <div className="chat-import-options flex flex-col gap-2">
                <div className="chat-import-option group flex min-h-[88px] items-center gap-3 rounded-2xl border border-border/80 bg-card/80 p-3 transition-all duration-200 hover:border-primary/35 hover:bg-accent/35 sm:gap-3.5 sm:px-3.5">
                  <span className="chat-import-option-icon flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-primary/10 text-primary transition-transform duration-200 group-hover:scale-105"><FileArchive size={20} /></span>
                  <div className="chat-import-option-copy min-w-0 flex-1">
                    <h3 className="text-sm font-semibold">ZIP 或文件</h3>
                    <p className="mt-1 text-xs leading-relaxed text-muted-foreground">ZIP 包请单独选择；也支持图片、HTML、JS、TS、CSS、JSON、SVG、Markdown、TXT。</p>
                  </div>
                  <Button type="button" className="chat-import-file-button min-h-10 w-auto shrink-0 rounded-full px-4 shadow-sm shadow-primary/15" onClick={triggerFileInput}><Files size={15} />选择文件</Button>
                </div>
                <div className="chat-import-option group flex min-h-[88px] items-center gap-3 rounded-2xl border border-border/80 bg-card/80 p-3 transition-all duration-200 hover:border-primary/35 hover:bg-accent/35 sm:gap-3.5 sm:px-3.5">
                  <span className="chat-import-option-icon flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-primary/10 text-primary transition-transform duration-200 group-hover:scale-105"><FolderUp size={20} /></span>
                  <div className="chat-import-option-copy min-w-0 flex-1">
                    <h3 className="text-sm font-semibold">项目文件夹</h3>
                    <p className="mt-1 text-xs leading-relaxed text-muted-foreground">保留完整目录结构，自动识别源码项目或 dist 预览目录。</p>
                  </div>
                  <Button type="button" variant="outline" className="chat-import-folder-button min-h-10 w-auto shrink-0 rounded-full border-border/80 bg-background/60 px-4 transition-colors hover:border-primary/40 hover:bg-accent" onClick={triggerFolderInput}><FolderUp size={15} />选择文件夹</Button>
                </div>
              </div>
              <div className="chat-import-footnote mt-3 flex items-center gap-1.5 px-1 text-[11px] text-muted-foreground/80">
                <Info size={13} aria-hidden="true" />
                上传的图片及可读取文本会发送给模型，用于生成简短概述。
              </div>
            </section>
          )}
        </div>
        <FileEditModeSelector value={fileEditMode} loading={fileEditModeLoading} onChange={onFileEditModeChange} />
        <input
          ref={fileInputRef}
          type="file"
          accept=".zip,application/zip,image/*,.html,.htm,.js,.mjs,.cjs,.jsx,.ts,.tsx,.css,.json,.svg,.txt,.md,.markdown,.yaml,.yml,.png,.jpg,.jpeg,.gif,.webp,.avif,.bmp,.ico"
          multiple
          className="hidden"
          onChange={(e) => {
            const selected = Array.from(e.target.files ?? []);
            const archives = selected.filter((file) => file.name.toLowerCase().endsWith('.zip'));
            if (archives.length && selected.length > 1) {
              setArchiveName('');
              setArchiveStatus('ZIP 项目包请单独选择，不要与其他文件混选。');
              e.target.value = '';
              return;
            }
            if (archives.length === 1 && onArchiveSelect) {
              startImport(archives[0].name, (signal) => onArchiveSelect(archives[0], signal));
              e.target.value = '';
              return;
            }
            const images = selected.filter(isImageFile);
            const projectFiles = selected.filter((file) => !isImageFile(file));
            const imageSummary = images.length && onUploadImages
              ? onUploadImages(images)
              : Promise.resolve().then(() => { if (images.length) onImageSelect(images); });
            if (projectFiles.length && onFolderSelect) {
              const name = projectFiles.length === 1 ? projectFiles[0].name : `${projectFiles.length} 个文件`;
              startImport(name, async (signal) => {
                await imageSummary;
                if (!signal.aborted) await onFolderSelect(projectFiles, signal);
              });
            } else if (images.length) {
              const name = images.length === 1 ? images[0].name : `${images.length} 张图片`;
              startImport(name, () => imageSummary);
            }
            e.target.value = '';
          }}
        />
        <input
          ref={(element) => {
            folderInputRef.current = element;
            element?.setAttribute('webkitdirectory', '');
            element?.setAttribute('directory', '');
          }}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            if (files.length && onFolderSelect) {
              const firstPath = files[0].webkitRelativePath;
              const folderName = firstPath.split('/')[0] || '所选文件夹';
              startImport(folderName, (signal) => onFolderSelect(files, signal));
            }
            e.target.value = '';
          }}
        />

        <Textarea
          ref={textareaRef}
          className="chat-input min-h-0 min-w-0 flex-1 resize-none overflow-hidden border-0 bg-transparent pb-[0.12rem] pl-[0.08rem] pr-0 pt-[0.12rem] text-[0.28rem] leading-[1.6] text-[#f5f5f7] shadow-none outline-none ring-0 placeholder:text-white/40 focus-visible:ring-0 disabled:opacity-50"
          style={{ maxHeight: `${INPUT_MAX_HEIGHT}px` }}
          placeholder="一问一念，皆自此起…"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          rows={1}
          disabled={isLoading}
        />
        <div className="chat-composer-actions">
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
      {(hasPendingUploadSummary || (archiveStatus && archiveStatus !== '导入完成')) && (
        <div className="chat-archive-status" role="status" aria-live="polite" title={archiveName || importedUploadName || undefined}>
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            {(pendingUploadAttachments.length > 0
              ? pendingUploadAttachments
              : [{ name: archiveName || importedUploadName || '', kind: 'archive' as const }]
            ).filter((attachment) => attachment.name).map((attachment, index, all) => {
              const AttachmentIcon = attachment.kind === 'folder' ? FolderUp : attachment.kind === 'file' ? Files : FileArchive;
              return (
                <div className="chat-archive-file-pill" key={`${attachment.name}-${index}`}>
                  <AttachmentIcon size={14} aria-hidden="true" />
                  <span className="chat-archive-name">{attachment.name}</span>
                  {index === all.length - 1 && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="chat-archive-cancel"
                      onClick={cancelArchive}
                      aria-label={archiveStatus === '正在识别并导入…' ? '取消项目导入' : '移除待发送附件'}
                      title={archiveStatus === '正在识别并导入…' ? '取消导入' : '移除附件'}
                    >
                      <X size={14} aria-hidden="true" />
                    </Button>
                  )}
                </div>
              );
            })}
          </div>
          <span className="chat-archive-state">{archiveStatus || '导入完成'}</span>
        </div>
      )}
    </div>
  );
}
