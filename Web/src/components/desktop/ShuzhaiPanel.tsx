import { useCallback, useId, useRef, useState } from 'react';
import { Check, ChevronDown, Cloud, FolderOpen, FolderPlus, FolderSearch, Globe, LampDesk, LogOut, Monitor, Plus, Smartphone } from 'lucide-react';
import { usePopoverDismiss } from '../chat/usePopoverDismiss';
import type { DesktopMode, ShuzhaiState } from '../../desktop/desktopRuntime';
import './Shuzhai.less';

const CONNECTION_TEXT: Record<ShuzhaiState['connection'], string> = {
  idle: '未连接',
  connecting: '连接中…',
  connected: '已连接',
  disconnected: '未连接 · 重连中',
};

export type ShuzhaiPanelProps = {
  mode: DesktopMode;
  state: ShuzhaiState;
  /** 正在切换书斋或模式时禁用操作。 */
  busy?: boolean;
  onSwitchMode: (mode: DesktopMode) => void;
  onPickFolder: () => void;
  onOpenRecent: (folderPath: string) => void;
  onReveal: () => void;
  onCloseFolder: () => void;
  /** 新建空白项目；不提供时弹层里不显示该项。 */
  onCreateProject?: () => void;
  /** 遥斋：「允许网页遥控此书斋」开关；不提供时弹层里不显示遥控一节。 */
  onToggleRemote?: (allowed: boolean) => void;
  /** 断开某台正在遥控的设备。 */
  onDisconnectRemote?: (clientId: string) => void;
};

const NO_REMOTE: ShuzhaiState['remote'] = { allowed: false, available: false, clients: [] };
const isPhone = (label: string) => /iPhone|iPad|Android/.test(label);

function activeText(lastActive: number, now = Date.now()): string {
  const minutes = Math.floor(Math.max(0, now - lastActive) / 60_000);
  return minutes < 1 ? '刚刚' : `${minutes} 分钟前活动`;
}

/** 纯展示：桌面端侧栏顶部的「云笺 | 书斋」切换器与书斋卡片；状态与操作都由宿主通过 props 提供。 */
export default function ShuzhaiPanel({
  mode, state, busy = false, onSwitchMode, onPickFolder, onOpenRecent, onReveal, onCloseFolder, onCreateProject,
  onToggleRemote, onDisconnectRemote,
}: ShuzhaiPanelProps) {
  const remote = state.remote ?? NO_REMOTE;
  const remoteCount = remote.allowed ? remote.clients.length : 0;
  const statusText = state.connection === 'connected' && remoteCount
    ? `已连接 · ${remoteCount} 台设备在遥控` : CONNECTION_TEXT[state.connection];
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  usePopoverDismiss(open, useCallback(() => setOpen(false), []), container, trigger);
  const run = (action: () => void) => () => { setOpen(false); action(); };
  const modes: Array<{ value: DesktopMode; name: string; Icon: typeof Cloud }> = [
    { value: 'yunjian', name: '云笺', Icon: Cloud },
    { value: 'shuzhai', name: '书斋', Icon: FolderOpen },
  ];

  return (
    <div className="shuzhai-panel" ref={container}>
      <div className="shuzhai-mode-switch" role="radiogroup" aria-label="工作模式">
        {modes.map(({ value, name, Icon }) => (
          <button key={value} type="button" role="radio" aria-checked={mode === value}
            className={`shuzhai-mode-option${mode === value ? ' is-selected' : ''}`}
            title={value === 'yunjian' ? '云笺：项目写在云端，Preview 即刻可见' : '书斋：直接读写本机的项目文件夹'}
            disabled={busy}
            onClick={() => { if (mode !== value) onSwitchMode(value); }}>
            <Icon aria-hidden="true" /><span>{name}</span>
          </button>
        ))}
      </div>

      {mode === 'shuzhai' && (state.folder ? (
        <button ref={trigger} type="button" className={`shuzhai-card is-${state.connection}`} aria-haspopup="dialog"
          aria-expanded={open} aria-controls={open ? panelId : undefined} disabled={busy}
          aria-label={`书斋：${state.folder.name}，${statusText}`}
          title={state.folder.path}
          onClick={() => setOpen((value) => !value)}>
          <span className="shuzhai-card-icon"><LampDesk aria-hidden="true" /></span>
          <span className="shuzhai-card-copy">
            <strong>{state.folder.name}</strong>
            <span className="shuzhai-card-path">{state.folder.path}</span>
            <span className="shuzhai-card-status"><span className="shuzhai-dot" aria-hidden="true" />{statusText}</span>
          </span>
          <ChevronDown className="shuzhai-card-chevron" aria-hidden="true" />
        </button>
      ) : (
        <button ref={trigger} type="button" className="shuzhai-card is-empty" disabled={busy} onClick={onPickFolder}>
          <span className="shuzhai-card-icon"><Plus aria-hidden="true" /></span>
          <span className="shuzhai-card-copy"><strong>未择书斋</strong><span className="shuzhai-card-path">选一个本机文件夹</span></span>
        </button>
      ))}

      {open && mode === 'shuzhai' && state.folder && (
        <section id={panelId} role="dialog" aria-label="选择书斋" className="shuzhai-popover">
          <h2>最近的书斋</h2>
          <div className="shuzhai-recent-list">
            {state.recent.map((item) => {
              const current = item.path === state.folder?.path;
              return (
                <button key={item.path} type="button" className={`shuzhai-recent${current ? ' is-current' : ''}`}
                  aria-current={current ? 'true' : undefined} title={item.path}
                  onClick={run(() => { if (!current) onOpenRecent(item.path); })}>
                  <span className="shuzhai-recent-copy"><strong>{item.name}</strong><span>{item.path}{current ? ' · 当前' : ''}</span></span>
                  {current && <Check aria-hidden="true" />}
                </button>
              );
            })}
          </div>
          {onToggleRemote && (
            <>
              <div className="shuzhai-popover-divider" aria-hidden="true" />
              <div className="shuzhai-remote">
                <div className="shuzhai-remote-row">
                  <span className="shuzhai-remote-copy">
                    <strong id={`${panelId}-remote`}>允许网页遥控此书斋</strong>
                    <span>{remote.available || !remote.allowed
                      ? '仅同账号、同局域网的已登录设备' : '登录后，网页才能遥控此书斋'}</span>
                  </span>
                  <button type="button" role="switch" aria-checked={remote.allowed} aria-labelledby={`${panelId}-remote`}
                    className={`shuzhai-switch${remote.allowed ? ' is-on' : ''}`}
                    onClick={() => onToggleRemote(!remote.allowed)}>
                    <span className="shuzhai-switch-knob" aria-hidden="true" />
                  </button>
                </div>
                {remoteCount > 0 && (
                  <>
                    <h2>正在遥控</h2>
                    <ul className="shuzhai-remote-clients">
                      {remote.clients.map((client) => {
                        const Icon = isPhone(client.label) ? Smartphone : /Windows|Mac|Linux/.test(client.label) ? Monitor : Globe;
                        return (
                          <li key={client.id} className="shuzhai-remote-client">
                            <Icon aria-hidden="true" />
                            <span className="shuzhai-remote-copy"><strong>{client.label}</strong><span>{activeText(client.lastActive)}</span></span>
                            {onDisconnectRemote && (
                              <button type="button" className="shuzhai-remote-disconnect" aria-label={`断开 ${client.label}`}
                                onClick={() => onDisconnectRemote(client.id)}>断开</button>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  </>
                )}
              </div>
            </>
          )}
          <div className="shuzhai-popover-divider" aria-hidden="true" />
          <div className="shuzhai-popover-actions">
            <button type="button" className="shuzhai-action is-primary" onClick={run(onPickFolder)}><FolderOpen aria-hidden="true" />打开文件夹…</button>
            {onCreateProject && <button type="button" className="shuzhai-action" onClick={run(onCreateProject)}><FolderPlus aria-hidden="true" />新建空白项目</button>}
            <button type="button" className="shuzhai-action" onClick={run(onReveal)}><FolderSearch aria-hidden="true" />在资源管理器中显示</button>
            <button type="button" className="shuzhai-action" onClick={run(onCloseFolder)}><LogOut aria-hidden="true" />收起书斋</button>
          </div>
        </section>
      )}
    </div>
  );
}
