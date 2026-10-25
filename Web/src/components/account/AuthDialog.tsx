import { useEffect, useState, type FormEvent } from 'react';
import { Eye, EyeOff, Lock, LockKeyhole, Mail, UserRound, X } from 'lucide-react';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
} from '../ui/alert-dialog';

export type AuthDialogMode = 'login' | 'register';

export interface AuthDialogProps {
  mode: AuthDialogMode | null;
  onModeChange: (mode: AuthDialogMode | null) => void;
  onLogin: (email: string, password: string, remember: boolean) => Promise<void>;
  onRegister: (nickname: string, email: string, password: string) => Promise<void>;
}

const EMAIL = /^[^@\s]{1,64}@[^@\s]+\.[^@\s]{2,}$/;

/** 与后端 services/auth.py 相同的校验，提交前就给出提示；最终以后端结果为准。 */
export function validateAuthForm(mode: AuthDialogMode, form: { nickname: string; email: string; password: string; confirm: string }): string | null {
  if (mode === 'register') {
    const nickname = form.nickname.trim();
    if (!nickname) return '请填写昵称';
    if (nickname.length > 20) return '昵称需为 1 到 20 个字';
  }
  if (!EMAIL.test(form.email.trim())) return '请输入有效的邮箱地址';
  if (!form.password) return '请输入密码';
  if (mode === 'register') {
    if (form.password.length < 8 || form.password.length > 128) return '密码需为 8 到 128 位';
    if (!/[A-Za-z]/.test(form.password) || !/\d/.test(form.password)) return '密码需同时包含字母和数字';
    if (form.password !== form.confirm) return '两次输入的密码不一致';
  }
  return null;
}

/** 登录 / 注册弹窗（纯 UI）：提交通过回调交给外部，失败原因原样显示在表单内。 */
export default function AuthDialog({ mode, onModeChange, onLogin, onRegister }: AuthDialogProps) {
  const [nickname, setNickname] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [remember, setRemember] = useState(true);
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // 切换模式或重新打开时清掉密码与错误，邮箱保留方便来回切换
  useEffect(() => {
    setPassword('');
    setConfirm('');
    setError(null);
    setShowPassword(false);
  }, [mode]);

  const isRegister = mode === 'register';
  const clearError = () => { if (error) setError(null); };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!mode || submitting) return;
    const problem = validateAuthForm(mode, { nickname, email, password, confirm });
    if (problem) {
      setError(problem);
      return;
    }
    setSubmitting(true);
    try {
      if (isRegister) await onRegister(nickname.trim(), email.trim(), password);
      else await onLogin(email.trim(), password, remember);
    } catch (reason) {
      setError(reason instanceof Error && reason.message ? reason.message : '请求失败，请稍后再试');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AlertDialog open={mode !== null} onOpenChange={(open) => { if (!open && !submitting) onModeChange(null); }}>
      <AlertDialogContent overlayClassName="chat-theme-dialog-overlay"
        className="chat-theme-dialog auth-dialog w-[min(400px,calc(100%-32px))] max-w-none gap-0 rounded-[22px] border p-0">
        <form className="auth-dialog-form" onSubmit={submit} noValidate>
          <div className="auth-dialog-header">
            <div>
              <AlertDialogTitle className="auth-dialog-title">{isRegister ? '注册' : '登录'}</AlertDialogTitle>
              <AlertDialogDescription className="sr-only">
                {isRegister ? '填写昵称、邮箱和密码创建账号' : '输入邮箱和密码登录'}
              </AlertDialogDescription>
            </div>
            <button type="button" className="auth-dialog-close" aria-label="关闭" disabled={submitting} onClick={() => onModeChange(null)}>
              <X aria-hidden="true" />
            </button>
          </div>

          {isRegister && (
            <label className="auth-field">
              <span>昵称</span>
              <span className="auth-input">
                <UserRound aria-hidden="true" />
                <input value={nickname} onChange={(event) => { setNickname(event.target.value); clearError(); }}
                  autoComplete="nickname" maxLength={20} placeholder="你的称呼" />
              </span>
            </label>
          )}
          <label className="auth-field">
            <span>邮箱</span>
            <span className="auth-input">
              <Mail aria-hidden="true" />
              <input type="email" value={email} onChange={(event) => { setEmail(event.target.value); clearError(); }}
                autoComplete="email" placeholder="name@example.com" autoFocus />
            </span>
          </label>
          <label className="auth-field">
            <span>密码</span>
            <span className="auth-input">
              <Lock aria-hidden="true" />
              <input type={showPassword ? 'text' : 'password'} value={password}
                onChange={(event) => { setPassword(event.target.value); clearError(); }}
                autoComplete={isRegister ? 'new-password' : 'current-password'}
                placeholder={isRegister ? '至少 8 位，含字母和数字' : '输入密码'} />
              <button type="button" className="auth-input-toggle" aria-label={showPassword ? '隐藏密码' : '显示密码'}
                onClick={() => setShowPassword((value) => !value)}>
                {showPassword ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
              </button>
            </span>
          </label>
          {isRegister && (
            <label className="auth-field">
              <span>确认密码</span>
              <span className="auth-input">
                <LockKeyhole aria-hidden="true" />
                <input type={showPassword ? 'text' : 'password'} value={confirm}
                  onChange={(event) => { setConfirm(event.target.value); clearError(); }}
                  autoComplete="new-password" placeholder="再输入一次" />
              </span>
            </label>
          )}
          {!isRegister && (
            <label className="auth-remember">
              <input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} />
              记住我（30 天内免登录）
            </label>
          )}

          {error && <p className="auth-dialog-error" role="alert">{error}</p>}

          <button type="submit" className="auth-dialog-submit" disabled={submitting}>
            {submitting ? (isRegister ? '正在注册…' : '正在登录…') : isRegister ? '注册并登录' : '登录'}
          </button>
          <p className="auth-dialog-switch">
            {isRegister ? '已有账号？' : '还没有账号？'}
            <button type="button" disabled={submitting} onClick={() => onModeChange(isRegister ? 'login' : 'register')}>
              {isRegister ? '去登录' : '立即注册'}
            </button>
          </p>
        </form>
      </AlertDialogContent>
    </AlertDialog>
  );
}
