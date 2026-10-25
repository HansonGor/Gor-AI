import type { ReactNode } from 'react';
import { PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import type { Session, ThemeType } from '../../types';
import Sidebar from '../Sidebar/Sidebar';

export interface ChatSidebarLayerProps {
  sessions: Session[];
  activeSessionId: string | null;
  theme: ThemeType;
  sidebarOpen: boolean;
  mobileSidebarVisible: boolean;
  mobileSidebarMounted: boolean;
  onSelectSession: (id: string) => void;
  onSelectMobileSession: (id: string) => void;
  onCreateSession: () => void;
  onCreateMobileSession: () => void;
  onDeleteSession: (id: string) => void;
  onToggleDesktopSidebar: () => void;
  onCloseMobileSidebar: () => void;
  /** 账号区，桌面侧栏与手机抽屉共用。 */
  account?: ReactNode;
}

/** Desktop and mobile session navigation, isolated from chat orchestration. */
export default function ChatSidebarLayer({
  sessions,
  activeSessionId,
  theme,
  sidebarOpen,
  mobileSidebarVisible,
  mobileSidebarMounted,
  onSelectSession,
  onSelectMobileSession,
  onCreateSession,
  onCreateMobileSession,
  onDeleteSession,
  onToggleDesktopSidebar,
  onCloseMobileSidebar,
  account,
}: ChatSidebarLayerProps) {
  return (
    <>
      <aside className="chat-sidebar-desktop hidden lg:flex" aria-hidden={!sidebarOpen}>
        <Sidebar
          sessions={sessions}
          activeSessionId={activeSessionId}
          onSelectSession={onSelectSession}
          onCreateSession={onCreateSession}
          onDeleteSession={onDeleteSession}
          theme={theme}
          isCollapsed={false}
          account={account}
        />
      </aside>
      <button
        type="button"
        className={`chat-sidebar-float-toggle ${sidebarOpen ? 'is-open' : 'is-closed'}`}
        onClick={onToggleDesktopSidebar}
        aria-label={sidebarOpen ? '收起会话侧边栏' : '展开会话侧边栏'}
        title={sidebarOpen ? '收起会话列表' : '展开会话列表'}
      >
        {sidebarOpen ? <PanelLeftClose size={18} /> : <PanelLeftOpen size={18} />}
      </button>
      {mobileSidebarMounted && (
        <>
          <div
            className={`chat-mobile-mask ${mobileSidebarVisible ? 'is-entering' : 'is-closing'}`}
            onClick={onCloseMobileSidebar}
            aria-hidden="true"
          />
          <div
            className={`chat-sidebar-mobile ${mobileSidebarVisible ? 'is-entering' : 'is-closing'}`}
          >
            <Sidebar
              sessions={sessions}
              activeSessionId={activeSessionId}
              onSelectSession={onSelectMobileSession}
              onCreateSession={onCreateMobileSession}
              onDeleteSession={onDeleteSession}
              theme={theme}
              isCollapsed={false}
              account={account}
            />
          </div>
        </>
      )}
    </>
  );
}
