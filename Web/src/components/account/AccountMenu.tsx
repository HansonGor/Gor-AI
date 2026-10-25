import { useCallback, useId, useRef, useState, type ReactNode } from 'react';
import { LogIn, LogOut, Settings, UserPlus, UserRoundCog } from 'lucide-react';
import { usePopoverDismiss } from '../chat/usePopoverDismiss';
import type { AuthUser } from '../../user/auth';

export interface AccountMenuProps {
  user: AuthUser | null;
  /** 菜单顶部头像，与侧栏底部头像一致（未登录为默认头像） */
  avatar: ReactNode;
  onLogin: () => void;
  onRegister: () => void;
  onProfile: () => void;
  onLogout: () => void;
}

/** 侧栏齿轮按钮及其弹出的账号菜单（纯 UI，动作全部由回调接入）。 */
export default function AccountMenu({ user, avatar, onLogin, onRegister, onProfile, onLogout }: AccountMenuProps) {
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const close = useCallback(() => setOpen(false), []);
  usePopoverDismiss(open, close, container, trigger);
  const run = (action: () => void) => () => { setOpen(false); action(); };

  return (
    <div ref={container} className="account-menu">
      <button ref={trigger} type="button" className="conversation-settings" aria-label="账号与设置" title="账号"
        aria-haspopup="menu" aria-expanded={open} aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((value) => !value)}>
        <Settings aria-hidden="true" />
      </button>
      {open && (
        <div id={menuId} role="menu" aria-label="账号菜单" className="account-menu-popover">
          <div className="account-menu-identity">
            {avatar}
            <span className="account-menu-identity-copy">
              <strong>{user ? user.nickname : '未登录'}</strong>
              {user && <small>{user.email}</small>}
            </span>
          </div>
          {user ? (
            <>
              <button type="button" role="menuitem" className="account-menu-item" onClick={run(onProfile)}>
                <UserRoundCog aria-hidden="true" />个人资料
              </button>
              <div className="account-menu-divider" role="separator" />
              <button type="button" role="menuitem" className="account-menu-item is-danger" onClick={run(onLogout)}>
                <LogOut aria-hidden="true" />退出登录
              </button>
            </>
          ) : (
            <>
              <button type="button" role="menuitem" className="account-menu-item is-primary" onClick={run(onLogin)}>
                <LogIn aria-hidden="true" />登录
              </button>
              <button type="button" role="menuitem" className="account-menu-item" onClick={run(onRegister)}>
                <UserPlus aria-hidden="true" />注册
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
