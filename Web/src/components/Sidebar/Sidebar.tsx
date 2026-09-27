// 侧边栏 - 会话列表（移动端，Tailwind）
import { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { formatRelativeTime } from '../../utils/date';
import type { SidebarProps } from '../../types';
import { Button } from '../ui/button';
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

export default function Sidebar({
  sessions,
  activeSessionId,
  onSelectSession,
  onCreateSession,
  onDeleteSession,
  theme = 'dark',
}: SidebarProps) {
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  return (
    <aside className="sidebar flex h-full w-[5.6rem] shrink-0 flex-col overflow-hidden border-r border-white/10 bg-[#0b0b14]">
      {/* 新建会话按钮 */}
      <div className="sidebar-header border-b border-white/10 p-[0.24rem]">
        <Button
          type="button"
          className="new-chat-btn flex w-full cursor-pointer items-center justify-center gap-[0.12rem] rounded-[0.24rem] border-none bg-gradient-to-br from-[#667eea] to-[#8b5cf6] px-[0.24rem] py-[0.16rem] text-[0.26rem] font-medium text-white transition-all hover:opacity-90 hover:translate-y-[-0.02rem] active:translate-y-0"
          onClick={onCreateSession}
        >
          <Plus className="new-chat-icon" aria-hidden="true" />
          <span>新建对话</span>
        </Button>
      </div>

      {/* 会话列表 */}
      <div className="sidebar-sessions flex-1 overflow-y-auto p-[0.16rem]">
        {sessions.length === 0 ? (
          <div className="empty-sessions p-[0.4rem] text-center text-[0.22rem] text-white/30">
            暂无对话
          </div>
        ) : (
          sessions.map((session) => {
            const parsedMessageCount = Number(session.message_count);
            const messageCount = Number.isFinite(parsedMessageCount) ? parsedMessageCount : 0;

            return (
              <div
              key={session.id}
              className={`session-item group mb-[0.08rem] flex cursor-pointer items-center gap-[0.12rem] rounded-[0.16rem] px-[0.16rem] py-[0.16rem] transition-colors hover:bg-white/5 ${
                activeSessionId === session.id
                  ? 'active border-l-[0.04rem] border-[#667eea] bg-[#667eea]/15'
                  : ''
              }`}
              onClick={() => onSelectSession(session.id)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') onSelectSession(session.id);
              }}
              role="button"
              tabIndex={0}
              aria-current={activeSessionId === session.id ? 'page' : undefined}
              title={session.title}
            >
              <div className="session-info min-w-0 flex-1">
                <div className="session-title truncate text-[0.28rem] leading-[1.3] text-white/60">
                  {session.title || '新对话'}
                </div>
                <div className="session-meta mt-[0.05rem] flex items-center gap-[0.12rem]">
                  <span className="session-time text-[0.2rem] text-white/30">
                    {formatRelativeTime(session.updated_at || '')}
                  </span>
                  <span className="session-count rounded-[0.08rem] bg-white/5 px-[0.08rem] text-[0.2rem] text-white/30">
                    {messageCount}条
                  </span>
                </div>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="session-delete-btn flex h-[0.4rem] w-[0.4rem] shrink-0 cursor-pointer items-center justify-center rounded-[0.08rem] text-[0.32rem] leading-none text-white/40 opacity-0 transition-all hover:bg-red-500/20 hover:text-red-400 group-hover:opacity-100"
                onClick={(e) => {
                  e.stopPropagation();
                  setPendingDelete(session.id);
                }}
                title="删除对话"
                aria-label={`删除对话 ${session.title || '新对话'}`}
              >
                <Trash2 aria-hidden="true" />
              </Button>
              </div>
            );
          })
        )}
      </div>
      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
      >
        <AlertDialogContent
          className={`session-delete-dialog w-[min(480px,calc(100%-32px))] max-w-none gap-0 rounded-[20px] p-5 shadow-[0_28px_90px_rgba(0,0,0,0.5)] sm:p-6 ${
            theme === 'dark'
              ? 'border-white/10 bg-[#191923] text-[#f4f3f8]'
              : 'border-slate-200 bg-white text-slate-900 shadow-[0_24px_70px_rgba(15,23,42,0.2)]'
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
