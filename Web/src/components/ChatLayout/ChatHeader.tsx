import {
  ArrowLeft,
  Menu,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  SquareArrowOutUpRight,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from '../ui/button';
import GorBrandLogo from '../GorBrandLogo';

export interface ChatHeaderProps {
  isVscodePluginMode: boolean;
  isEmpty: boolean;
  isPC: boolean;
  sidebarOpen: boolean;
  /** 有上一页（页面自身的浏览记录）时显示返回按钮；App 内与浏览器一致。 */
  canGoBack: boolean;
  title: string;
  hasPreviewWorkerContent: boolean;
  previewWorkerOpen: boolean;
  previewableGeneratedFileCount: number;
  hasShareableMessages?: boolean;
  shareSelecting?: boolean;
  onShare?: () => void;
  onBack: () => void;
  onMenuClick: () => void;
  onTogglePreviewWorker: () => void;
  /** 菜单按钮旁的附加内容（桌面端窄窗口下的云笺/书斋模式胶囊）；未提供时不占位。 */
  extra?: ReactNode;
}

/** Presentation-only chat header; responsive positioning remains in chat styles. */
export default function ChatHeader({
  isVscodePluginMode,
  isEmpty,
  isPC,
  sidebarOpen,
  canGoBack,
  title,
  hasPreviewWorkerContent,
  previewWorkerOpen,
  previewableGeneratedFileCount,
  hasShareableMessages = false,
  shareSelecting = false,
  onShare,
  onBack,
  onMenuClick,
  onTogglePreviewWorker,
  extra,
}: ChatHeaderProps) {
  return (
    <header className={`chat-header${hasShareableMessages && !isVscodePluginMode ? ' has-share-button' : ''}`}>
      <div className="chat-header-heading">
        <div className={`chat-header-left ${isVscodePluginMode ? '' : 'lg:hidden'}`}>
          {canGoBack && (
            <Button
              variant="ghost"
              size="icon"
              onClick={onBack}
              aria-label="返回上一页"
              title="返回上一页"
              className="chat-icon-btn h-[0.72rem] w-[0.72rem] rounded-full bg-transparent text-white/80 hover:bg-transparent hover:text-white active:scale-90"
            >
              <ArrowLeft size={22} />
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon"
            onClick={onMenuClick}
            aria-label={isEmpty && isPC && sidebarOpen ? '收起会话列表' : '打开会话列表'}
            className="chat-icon-btn h-[0.72rem] w-[0.72rem] rounded-full text-white hover:bg-white/10 hover:text-white active:scale-95"
          >
            {isEmpty && isPC ? (
              sidebarOpen ? (
                <PanelLeftClose size={22} />
              ) : (
                <PanelLeftOpen size={22} />
              )
            ) : (
              <Menu size={22} />
            )}
          </Button>
          {extra}
        </div>
        <div className="chat-mobile-brand">
          <GorBrandLogo />
        </div>
        <div className="chat-session-title" title={title}>
          <span>{title}</span>
        </div>
      </div>
      <div className="chat-header-right">
        {!isVscodePluginMode && hasShareableMessages && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className={`chat-share-button${shareSelecting ? ' is-active' : ''}`}
            aria-label={shareSelecting ? '退出分享模式' : '分享聊天'}
            aria-pressed={shareSelecting}
            aria-disabled={!onShare || undefined}
            onClick={onShare}
            title="分享聊天"
          >
            <SquareArrowOutUpRight size={18} strokeWidth={1.7} aria-hidden="true" />
          </Button>
        )}
        {!isVscodePluginMode && hasPreviewWorkerContent && (
          <button
            type="button"
            className="chat-preview-worker-toggle"
            onClick={onTogglePreviewWorker}
            aria-label={previewWorkerOpen ? '收起 Preview Worker' : '展开 Preview Worker'}
            aria-expanded={previewWorkerOpen}
            title={previewWorkerOpen ? '收起 Preview Worker' : '展开 Preview Worker'}
          >
            {previewWorkerOpen ? <PanelRightClose size={19} /> : <PanelRightOpen size={19} />}
            {previewableGeneratedFileCount > 0 && <span>{previewableGeneratedFileCount}</span>}
          </button>
        )}
      </div>
    </header>
  );
}
