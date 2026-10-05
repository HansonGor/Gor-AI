// 侧边栏 - 会话列表（移动端，Tailwind）
import { useMemo, useState } from 'react';
import { Archive, FileImage, FolderOpen, MessageSquareMore, Plus, Search, Settings, Star, Trash2 } from 'lucide-react';
import type { SidebarProps } from '../../types';
import { Button } from '../ui/button';
import AppAvatar from '../AppAvatar';
import GorBrandLogo from '../GorBrandLogo';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../ui/alert-dialog';
import './Sidebar.less';

function sessionGroup(updatedAt?: string): '今天' | '昨天' | '更早' {
  if (!updatedAt) return '更早';
  const date = new Date(updatedAt);
  if (Number.isNaN(date.getTime())) return '更早';
  const today = new Date();
  if (date.toDateString() === today.toDateString()) return '今天';
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  return date.toDateString() === yesterday.toDateString() ? '昨天' : '更早';
}

function sessionClock(updatedAt?: string): string {
  if (!updatedAt) return '';
  const date = new Date(updatedAt);
  if (Number.isNaN(date.getTime())) return '';
  if (sessionGroup(updatedAt) === '今天') {
    return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
  }
  return `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export default function Sidebar({
  sessions,
  activeSessionId,
  onSelectSession,
  onCreateSession,
  onDeleteSession,
  theme = 'dark',
}: SidebarProps) {
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const groupedSessions = useMemo(() => {
    const filtered = sessions.filter((session) => (session.title || '').toLowerCase().includes(query.trim().toLowerCase()));
    return (['今天', '昨天', '更早'] as const)
      .map((label) => ({ label, items: filtered.filter((session) => sessionGroup(session.updated_at) === label) }))
      .filter((group) => group.items.length > 0);
  }, [sessions, query]);

  return (
    <aside className="gor-sidebar">
      <nav className="gor-icon-rail" aria-label="主导航">
        <div className="gor-brand">
          <GorBrandLogo />
        </div>
        <div className="gor-rail-navigation">
          <a className="gor-rail-item is-current" href="#/chat" aria-label="聊天" aria-current="page"><MessageSquareMore /></a>
          <span className="gor-rail-item" role="img" aria-label="项目"><FolderOpen /></span>
          <span className="gor-rail-item" role="img" aria-label="文件"><FileImage /></span>
          <span className="gor-rail-item" role="img" aria-label="收藏"><Star /></span>
          <span className="gor-rail-item" role="img" aria-label="归档"><Archive /></span>
        </div>
      </nav>

      <section className="conversation-panel" aria-label="会话列表">
        <div className="conversation-panel-top">
          <Button type="button" className="new-chat-btn" onClick={onCreateSession}>
            <Plus aria-hidden="true" /><span>新章</span>
          </Button>
          <label className="session-search">
            <Search aria-hidden="true" />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索对话..." aria-label="搜索对话" />
            <kbd>⌘K</kbd>
          </label>
        </div>

        <div className="sidebar-sessions">
          {groupedSessions.length === 0 ? (
            <div className="empty-sessions">{query ? '没有匹配的对话' : '暂无对话'}</div>
          ) : groupedSessions.map((group) => (
            <section className="session-group" key={group.label}>
              <h2>{group.label}</h2>
              {group.items.map((session) => {
            const parsedMessageCount = Number(session.message_count);
            const messageCount = Number.isFinite(parsedMessageCount) ? parsedMessageCount : 0;
            const sessionTitle = !session.title || session.title === '新对话' ? '新章' : session.title;

            return (
              <div
                key={session.id}
                className={`session-item group ${activeSessionId === session.id ? 'active' : ''}`}
                onClick={() => onSelectSession(session.id)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') onSelectSession(session.id);
                }}
                role="button"
                tabIndex={0}
                aria-current={activeSessionId === session.id ? 'page' : undefined}
                title={sessionTitle}
              >
                <FileImage className="session-item-icon" aria-hidden="true" />
                <div className="session-info">
                  <div className="session-title">{sessionTitle}</div>
                  <div className="session-meta">
                    <span className="session-time">{sessionClock(session.updated_at)}</span>
                    <span className="session-count">{messageCount}条</span>
                  </div>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="session-delete-btn"
                  onClick={(event) => {
                    event.stopPropagation();
                    setPendingDelete(session.id);
                  }}
                  title="删除对话"
                  aria-label={`删除对话 ${sessionTitle}`}
                >
                  <Trash2 aria-hidden="true" />
                </Button>
              </div>
            );
              })}
            </section>
          ))}
        </div>

        <footer className="conversation-account">
          <AppAvatar className="conversation-account-avatar" editable />
          <span className="conversation-account-copy"><strong>樺</strong><small>Plus</small></span>
          <button type="button" className="conversation-settings" aria-label="设置" title="设置"><Settings /></button>
        </footer>
      </section>
      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
      >
        <AlertDialogContent
          overlayClassName="chat-theme-dialog-overlay"
          className={`chat-theme-dialog session-delete-dialog w-[min(480px,calc(100%-32px))] max-w-none gap-0 rounded-[20px] p-5 shadow-[0_28px_90px_rgba(0,0,0,0.5)] sm:p-6 ${
            theme === 'dark'
              ? 'border-white/10 text-[#f4f3f8]'
              : 'border-slate-200 text-slate-900 shadow-[0_24px_70px_rgba(15,23,42,0.2)]'
          }`}
        >
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-3 text-[17px] tracking-tight">
              <span className={`flex h-10 w-10 items-center justify-center rounded-xl ${theme === 'dark' ? 'bg-red-500/10 text-red-300' : 'bg-red-50 text-red-600'}`}>
                <Trash2 size={18} aria-hidden="true" />
              </span>
              删除这条会话？
            </AlertDialogTitle>
            <AlertDialogDescription className={`pl-[52px] text-[13px] leading-5 ${theme === 'dark' ? 'text-white/55' : 'text-slate-500'}`}>
              会话与历史消息会从列表中移除，此操作无法撤销。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className={`mt-5 flex-row gap-2 border-t pt-4 ${theme === 'dark' ? 'border-white/[0.08]' : 'border-slate-100'}`}>
            <AlertDialogCancel className={`h-10 min-w-[88px] rounded-xl ${theme === 'dark' ? 'border-white/10 bg-white/[0.04] text-white/75 hover:bg-white/[0.09] hover:text-white' : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50 hover:text-slate-900'}`}>
              取消
            </AlertDialogCancel>
            <AlertDialogAction
              className="h-10 min-w-[88px] rounded-xl bg-red-600 text-white shadow-sm shadow-red-950/20 hover:bg-red-500"
              onClick={() => {
                if (pendingDelete) onDeleteSession(pendingDelete);
                setPendingDelete(null);
              }}
            >
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </aside>
  );
}
