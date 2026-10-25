import { useEffect, useState } from 'react';
import { LogOut, UserRoundCog } from 'lucide-react';
import AppAvatar from '../AppAvatar';
import { useFeedback } from '../ui/feedback';
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
import AccountMenu from './AccountMenu';
import AuthDialog, { type AuthDialogMode } from './AuthDialog';
import { ensureCurrentUser, login, logout, register, reloadForIdentityChange, useAuth } from '../../user/auth';
import { migrateLegacyAvatar, uploadAccountAvatar } from '../../user/avatar';
import './Account.less';

export interface AccountControlProps {
  /** 有回复正在生成时为 true：切换身份会整页重载，此时不允许登录/退出。 */
  busy?: boolean;
}

/** 侧栏底部账号区：头像、昵称、账号菜单及登录/注册/退出流程，接入 user/auth 的登录状态。 */
export default function AccountControl({ busy = false }: AccountControlProps) {
  const { user, status } = useAuth();
  const { notify } = useFeedback();
  const [dialog, setDialog] = useState<AuthDialogMode | null>(null);
  const [confirmLogout, setConfirmLogout] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);

  useEffect(() => {
    // 桌面与手机抽屉各渲染一份侧栏，只查询一次当前用户；账号还没有头像时迁移本机原有头像
    void ensureCurrentUser().then(migrateLegacyAvatar);
  }, []);

  const guard = (action: () => void) => () => {
    if (busy) {
      notify('请等待当前回复完成');
      return;
    }
    action();
  };

  const finishIdentityChange = () => {
    setDialog(null);
    reloadForIdentityChange(true);
  };

  const doLogout = async () => {
    setLoggingOut(true);
    try {
      await logout();
    } catch {
      // 后端注销失败也已清除本机凭证，照常按未登录重载
    }
    setConfirmLogout(false);
    reloadForIdentityChange();
  };

  const displayName = user ? user.nickname : status === 'loading' ? '' : '未登录';

  return (
    <>
      {/* 头像绑定账号：登录后可修改并保存到账号下，未登录只显示默认头像 */}
      <AppAvatar className="conversation-account-avatar" editable
        onSaveAvatar={user ? async (image) => { await uploadAccountAvatar(image); } : undefined} />
      <span className="conversation-account-copy">
        {/* 未登录时点击「未登录」直接打开登录弹窗，与菜单里的「登录」相同 */}
        {!user && status === 'ready' ? (
          <button type="button" className="account-signin-link" onClick={guard(() => setDialog('login'))} title="登录">
            未登录
          </button>
        ) : (
          <strong>{displayName}</strong>
        )}
        {user && <small>Plus</small>}
      </span>
      <AccountMenu
        user={user}
        avatar={<AppAvatar className="account-menu-avatar" />}
        onLogin={guard(() => setDialog('login'))}
        onRegister={guard(() => setDialog('register'))}
        onProfile={() => setProfileOpen(true)}
        onLogout={guard(() => setConfirmLogout(true))}
      />

      <AuthDialog
        mode={dialog}
        onModeChange={setDialog}
        onLogin={async (email, password, remember) => { await login(email, password, remember); finishIdentityChange(); }}
        onRegister={async (nickname, email, password) => { await register(nickname, email, password); finishIdentityChange(); }}
      />

      <AlertDialog open={confirmLogout} onOpenChange={(open) => { if (!loggingOut) setConfirmLogout(open); }}>
        <AlertDialogContent overlayClassName="chat-theme-dialog-overlay"
          className="chat-theme-dialog w-[min(440px,calc(100%-32px))] max-w-none gap-0 rounded-2xl border p-5 text-[#f4f3f8] sm:p-6">
          <AlertDialogHeader className="gap-[10px]">
            <AlertDialogTitle className="flex items-center gap-3 text-base tracking-tight">
              <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-red-500/10 text-red-300">
                <LogOut size={18} aria-hidden="true" />
              </span>
              退出登录？
            </AlertDialogTitle>
            <AlertDialogDescription className="pl-[52px] text-[13px] leading-[1.6]">
              退出后本机不再保留登录状态。已保存的会话仍在你的账号下，重新登录即可继续。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="mt-5 flex-row gap-2 border-t border-white/[0.08] pt-4">
            <AlertDialogCancel disabled={loggingOut}
              className="h-10 min-w-[88px] flex-1 rounded-xl border-white/10 bg-white/[0.04] text-white/75 hover:bg-white/[0.09] hover:text-white">
              取消
            </AlertDialogCancel>
            <AlertDialogAction disabled={loggingOut}
              className="h-10 min-w-[88px] flex-1 rounded-xl bg-red-600 text-white hover:bg-red-500"
              onClick={(event) => { event.preventDefault(); void doLogout(); }}>
              {loggingOut ? '正在退出…' : '退出登录'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={profileOpen && Boolean(user)} onOpenChange={setProfileOpen}>
        <AlertDialogContent overlayClassName="chat-theme-dialog-overlay"
          className="chat-theme-dialog w-[min(400px,calc(100%-32px))] max-w-none gap-0 rounded-2xl border p-5 text-[#f4f3f8] sm:p-6">
          <AlertDialogHeader className="gap-[10px]">
            <AlertDialogTitle className="flex items-center gap-3 text-base tracking-tight">
              <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-violet-500/15 text-violet-200">
                <UserRoundCog size={18} aria-hidden="true" />
              </span>
              个人资料
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <dl className="account-profile">
                <dt>昵称</dt><dd>{user?.nickname}</dd>
                <dt>邮箱</dt><dd>{user?.email}</dd>
              </dl>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="mt-5 border-t border-white/[0.08] pt-4">
            <AlertDialogCancel className="h-10 min-w-[88px] rounded-xl border-white/10 bg-white/[0.04] text-white/80 hover:bg-white/[0.09] hover:text-white">
              关闭
            </AlertDialogCancel>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
