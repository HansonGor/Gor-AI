import {
  ArrowLeft,
  ChevronLeft,
  Menu,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
} from 'lucide-react';
import { Button } from '../ui/button';
import GorBrandLogo from '../GorBrandLogo';

export interface ChatHeaderProps {
  isVscodePluginMode: boolean;
  isEmpty: boolean;
  isPC: boolean;
  sidebarOpen: boolean;
  canGoBack: boolean;
  showNativeBack: boolean;
  title: string;
  hasPreviewWorkerContent: boolean;
  previewWorkerOpen: boolean;
  previewableGeneratedFileCount: number;
  onBack: () => void;
  onMenuClick: () => void;
  onTogglePreviewWorker: () => void;
}

/** Presentation-only chat header; responsive positioning remains in chat styles. */
export default function ChatHeader({
  isVscodePluginMode,
  isEmpty,
  isPC,
  sidebarOpen,
  canGoBack,
  showNativeBack,
  title,
  hasPreviewWorkerContent,
  previewWorkerOpen,
  previewableGeneratedFileCount,
  onBack,
  onMenuClick,
  onTogglePreviewWorker,
}: ChatHeaderProps) {
  return (
    <header className="chat-header">
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
            aria-label={
              isEmpty
                ? isPC && sidebarOpen
                  ? '收起会话列表'
                  : '打开会话列表'
                : !showNativeBack
                  ? '打开会话列表'
                  : '返回首页'
            }
            className="chat-icon-btn h-[0.72rem] w-[0.72rem] rounded-full text-white hover:bg-white/10 hover:text-white active:scale-95"
          >
            {isEmpty && isPC ? (
              sidebarOpen ? (
                <PanelLeftClose size={22} />
              ) : (
                <PanelLeftOpen size={22} />
              )
            ) : isEmpty || !showNativeBack ? (
              <Menu size={22} />
            ) : (
              <ChevronLeft size={22} />
            )}
          </Button>
        </div>
        <div className="chat-mobile-brand">
          <GorBrandLogo />
        </div>
        <div className="chat-session-title" title={title}>
          <span>{title}</span>
        </div>
      </div>
      <div className="chat-header-right">
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
