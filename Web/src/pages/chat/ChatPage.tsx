// AI 对话页面组件
import { useEffect, useCallback, useMemo, useState } from 'react';
import {
  ArrowLeft,
  ChevronLeft,
  Menu,
  Bell,
  Sun,
  Moon,
  MonitorPlay,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightOpen,
} from 'lucide-react';
import { Button } from '../../components/ui/button';
import { Badge } from '../../components/ui/badge';
import AppAvatar from '../../components/AppAvatar';
import ChatBox from '../../components/ChatBox';
import WebPreview from '../../components/ChatBox/WebPreview';
import PreviewWorker from '../../components/ChatBox/PreviewWorker';
import type {
  PreviewWorkerMode,
  PreviewWorkerTarget,
} from '../../components/ChatBox/PreviewWorker';
import Sidebar from '../../components/Sidebar/Sidebar';
import { useChat } from '../../hooks/useChat';
import { useLayout } from '../../hooks/useLayout';
import { useTheme } from '../../hooks/useTheme';
import { nativeBridge } from '../../utils/nativeBridge';
import '../../App.less';
import './chat.less';
import type { GeneratedFile } from '../../types';

export default function ChatPage() {
  const {
    sessions,
    sessionId,
    isSessionReady,
    messages,
    projectChanges,
    projectRevision,
    previewRevision,
    input,
    setInput,
    pendingImages,
    isLoading,
    selectSession,
    createNewSession,
    deleteSessionById,
    handleSend,
    handleStop,
    handleImageSelect,
    removePendingImage,
    initApp,
  } = useChat();

  const {
    mobileSidebarVisible,
    sidebarOpen,
    togglePCSidebar,
    openMobileSidebar,
    closeMobileSidebar,
  } = useLayout();

  const { theme, toggleTheme } = useTheme();
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewWorkerOpen, setPreviewWorkerOpen] = useState(false);
  const [previewWorkerMode, setPreviewWorkerMode] = useState<PreviewWorkerMode>('preview');
  const [previewWorkerTarget, setPreviewWorkerTarget] = useState<PreviewWorkerTarget>('project');
  const [activePreviewFile, setActivePreviewFile] = useState<GeneratedFile | null>(null);
  const generatedFiles = useMemo(() => {
    const unique = new Map<string, GeneratedFile>();
    messages.forEach((message) => {
      const files = message.files?.length ? message.files : message.file ? [message.file] : [];
      files.forEach((file) => unique.set(file.downloadUrl, file));
    });
    projectChanges.forEach((change) => {
      if (!/\.html?$/i.test(change.path)) return;
      const downloadUrl = `/${change.path.split('/').map(encodeURIComponent).join('/')}`;
      unique.set(downloadUrl, {
        fileType: 'html',
        displayName: change.path.split('/').pop() || change.path,
        downloadUrl,
      });
    });
    return Array.from(unique.values());
  }, [messages, projectChanges]);
  const hasPreviewWorkerContent =
    generatedFiles.length > 0 || previewWorkerOpen || projectRevision > 0 || previewRevision > 0;

  useEffect(() => {
    if (previewRevision > 0) {
      setPreviewOpen(false);
      setPreviewWorkerMode('preview');
      setPreviewWorkerTarget('project');
      setPreviewWorkerOpen(true);
    }
  }, [previewRevision]);

  useEffect(() => {
    if (projectRevision > 0) {
      const latestChange = projectChanges[projectChanges.length - 1];
      if (latestChange && /\.html?$/i.test(latestChange.path)) {
        const previewUrl = `/${latestChange.path.split('/').map(encodeURIComponent).join('/')}`;
        const htmlFile = generatedFiles.find((file) => file.downloadUrl === previewUrl);
        if (htmlFile) {
          setActivePreviewFile(htmlFile);
          setPreviewWorkerMode('preview');
          setPreviewWorkerTarget('generated');
          setPreviewOpen(false);
          setPreviewWorkerOpen(true);
        }
      } else {
        setPreviewWorkerOpen(false);
        setPreviewOpen(true);
      }
    }
  }, [generatedFiles, projectChanges, projectRevision]);

  useEffect(() => {
    if (generatedFiles.length === 0) {
      setActivePreviewFile(null);
      return;
    }
    if (
      !activePreviewFile ||
      !generatedFiles.some((file) => file.downloadUrl === activePreviewFile.downloadUrl)
    ) {
      setActivePreviewFile(generatedFiles[generatedFiles.length - 1]);
    }
  }, [activePreviewFile, generatedFiles]);

  const openPreviewWorker = useCallback((file?: GeneratedFile) => {
    setPreviewOpen(false);
    if (file) {
      setActivePreviewFile(file);
      setPreviewWorkerTarget('generated');
    } else {
      setPreviewWorkerTarget('project');
    }
    setPreviewWorkerMode('preview');
    setPreviewWorkerOpen(true);
  }, []);

  useEffect(() => {
    initApp();
  }, [initApp]);

  const handleSelectSession = useCallback(
    (id: string) => {
      selectSession(id);
      closeMobileSidebar();
    },
    [selectSession, closeMobileSidebar],
  );

  const showNativeBack = nativeBridge.shouldShowBackButton();
  const handleHeaderLeft = useCallback(() => {
    if (showNativeBack) {
      nativeBridge.goBack();
    } else {
      openMobileSidebar();
    }
  }, [showNativeBack, openMobileSidebar]);

  const goBack = useCallback(() => {
    if (window.history.length > 1) {
      window.history.back();
    } else {
      window.location.hash = '#/';
    }
  }, []);

  return (
    <div
      className={`chat-page theme-${theme} relative flex h-full flex-row overflow-hidden bg-[#0f0f19] text-[#f5f5f7]`}
    >
      {/* PC端常驻左侧边栏 */}
      {sidebarOpen && (
        <aside className="hidden lg:flex lg:h-full lg:w-[280px] lg:shrink-0 lg:border-r lg:border-white/5 lg:bg-[#0b0b14]">
          <Sidebar
            sessions={sessions}
            activeSessionId={sessionId}
            onSelectSession={selectSession}
            onCreateSession={createNewSession}
            onDeleteSession={deleteSessionById}
            isCollapsed={false}
          />
        </aside>
      )}
      <Button
        type="button"
        variant="ghost"
        size="icon"
        onClick={togglePCSidebar}
        className={`desktop-sidebar-toggle absolute top-1/2 z-30 hidden h-9 w-7 -translate-y-1/2 rounded-r-lg border border-white/10 bg-[#171722] text-white/60 shadow-md hover:bg-[#222232] hover:text-white lg:grid ${sidebarOpen ? 'left-[calc(280px-28px)]' : 'left-0'}`}
        aria-label={sidebarOpen ? '收起会话侧边栏' : '展开会话侧边栏'}
        title={sidebarOpen ? '收起会话列表' : '展开会话列表'}
      >
        {sidebarOpen ? <PanelLeftClose size={17} /> : <PanelLeftOpen size={17} />}
      </Button>

      {/* 移动端悬浮侧边栏 */}
      {mobileSidebarVisible && (
        <>
          <div
            className="fixed inset-0 z-40 bg-black/50"
            onClick={closeMobileSidebar}
            aria-hidden="true"
          />
          <div className="fixed inset-y-0 left-0 z-50 lg:hidden">
            <Sidebar
              sessions={sessions}
              activeSessionId={sessionId}
              onSelectSession={handleSelectSession}
              onCreateSession={createNewSession}
              onDeleteSession={deleteSessionById}
              isCollapsed={false}
            />
          </div>
        </>
      )}

      {/* 右侧主内容区 */}
      <div className="chat-main-content relative flex h-full min-w-0 flex-1 flex-col overflow-hidden bg-[#0f0f19]">
        <header className="chat-header relative flex shrink-0 items-center justify-between bg-[#0f0f19]/70 backdrop-blur-xl px-[0.28rem] pb-[0.18rem] pt-[0.22rem] shadow-sm lg:px-8 lg:py-3.5">
          <div className="chat-header-left flex items-center gap-[0.18rem] lg:hidden">
            <Button
              variant="ghost"
              size="icon"
              onClick={goBack}
              aria-label="返回上一页"
              title="返回上一页"
              className="chat-icon-btn h-[0.72rem] w-[0.72rem] rounded-full bg-transparent text-white/80 hover:bg-transparent hover:text-white active:scale-90"
            >
              <ArrowLeft size={22} />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={handleHeaderLeft}
              aria-label={showNativeBack ? '返回首页' : '打开会话列表'}
              className="chat-icon-btn h-[0.72rem] w-[0.72rem] rounded-full text-white hover:bg-white/10 hover:text-white active:scale-95"
            >
              {showNativeBack ? <ChevronLeft size={22} /> : <Menu size={20} />}
            </Button>
          </div>
          <span className="chat-brand absolute left-1/2 -translate-x-1/2 text-[0.3rem] font-medium tracking-wide text-white/60 lg:text-base">
            Assistant
          </span>
          <div className="chat-header-right flex items-center gap-[0.12rem] lg:ml-auto lg:gap-3">
            {projectRevision > 0 && (
              <Button
                variant="ghost"
                size="icon"
                onClick={() =>
                  setPreviewOpen((open) => {
                    const next = !open;
                    if (next) setPreviewWorkerOpen(false);
                    return next;
                  })
                }
                aria-label={previewOpen ? '收起项目网页预览' : '打开项目网页预览'}
                title={previewOpen ? '收起项目网页预览' : '打开项目网页预览'}
                className="chat-icon-btn h-[0.72rem] w-[0.72rem] rounded-full text-white hover:bg-white/10 lg:h-9 lg:w-9"
              >
                <MonitorPlay size={18} />
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon"
              onClick={toggleTheme}
              aria-label={theme === 'dark' ? '切换到白天模式' : '切换到暗黑模式'}
              className="chat-icon-btn h-[0.72rem] w-[0.72rem] rounded-full text-white hover:bg-white/10 hover:text-white active:scale-95 lg:h-9 lg:w-9"
            >
              {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
            </Button>
            <AppAvatar className="chat-header-avatar h-[0.62rem] w-[0.62rem] rounded-full lg:h-9 lg:w-9" />
            <div className="chat-bell relative flex h-[0.72rem] w-[0.72rem] shrink-0 items-center justify-center text-white lg:h-9 lg:w-9">
              <Bell size={18} />
              <Badge className="chat-bell-badge absolute -right-[0.16rem] -top-[0.06rem] h-[0.36rem] min-w-[0.36rem] items-center justify-center rounded-full border-none bg-gradient-to-br from-rose-500 to-red-500 px-[0.06rem] pb-[0.02rem] text-[0.2rem] font-semibold leading-none text-white lg:-right-1 lg:-top-0.5 lg:h-4 lg:min-w-4 lg:text-[10px]">
                2
              </Badge>
            </div>
            {hasPreviewWorkerContent && (
              <Button
                variant="ghost"
                size="icon"
                onClick={() =>
                  previewWorkerOpen ? setPreviewWorkerOpen(false) : openPreviewWorker()
                }
                aria-label={previewWorkerOpen ? '关闭 Preview Worker' : '打开 Preview Worker'}
                title={previewWorkerOpen ? '关闭 Preview Worker' : 'Preview Worker'}
                className={`preview-worker-trigger chat-icon-btn relative h-[0.72rem] w-[0.72rem] rounded-full text-white hover:bg-white/10 lg:h-9 lg:w-9 ${previewWorkerOpen ? 'is-active' : ''}`}
              >
                <PanelRightOpen size={18} />
                {generatedFiles.length > 0 && (
                  <span className="preview-worker-count">{generatedFiles.length}</span>
                )}
              </Button>
            )}
          </div>
        </header>

        <main className="chat-main relative flex min-h-0 flex-1 overflow-hidden bg-[#0f0f19]">
          <div className="chat-conversation min-w-0 flex-1">
            {isSessionReady ? (
              <ChatBox
                messages={messages}
                input={input}
                setInput={setInput}
                pendingImages={pendingImages}
                isLoading={isLoading}
                handleSend={handleSend}
                handleStop={handleStop}
                handleImageSelect={handleImageSelect}
                removePendingImage={removePendingImage}
                onPreviewFile={openPreviewWorker}
                onPreviewProject={() => {
                  setPreviewOpen(false);
                  setPreviewWorkerTarget('project');
                  setPreviewWorkerMode('preview');
                  setPreviewWorkerOpen(true);
                }}
              />
            ) : (
              <div className="app-loading flex h-full flex-col items-center justify-center gap-[0.2rem]">
                <div className="loading-spinner"></div>
                <span className="text-[0.26rem]">正在初始化...</span>
              </div>
            )}
          </div>
          {previewOpen && (
            <WebPreview revision={projectRevision} onClose={() => setPreviewOpen(false)} />
          )}
          {previewWorkerOpen && (
            <PreviewWorker
              files={generatedFiles}
              activeFile={activePreviewFile}
              mode={previewWorkerMode}
              target={previewWorkerTarget}
              onModeChange={setPreviewWorkerMode}
              onTargetChange={setPreviewWorkerTarget}
              onSelect={(file) => {
                setActivePreviewFile(file);
                setPreviewWorkerTarget('generated');
              }}
              onClose={() => setPreviewWorkerOpen(false)}
            />
          )}
        </main>
      </div>
    </div>
  );
}
