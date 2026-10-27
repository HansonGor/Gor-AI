import { useCallback, useId, useRef, useState } from 'react';
import { Check, ChevronDown, Cloud, MonitorSmartphone, Monitor, Plus, RefreshCw } from 'lucide-react';
import { usePopoverDismiss } from '../chat/usePopoverDismiss';
import type { WebMode, YaozhaiWorkspace } from '../../remote/remoteRuntime';
import '../desktop/Shuzhai.less';

export type YaozhaiPanelProps = {
  mode: WebMode;
  workspaces: YaozhaiWorkspace[];
  selected: YaozhaiWorkspace | null;
  loaded: boolean;
  error: string | null;
  /** 未登录时只保留「云笺」，遥斋需要登录。 */
  signedIn: boolean;
  onSwitchMode: (mode: WebMode) => void;
  onSelect: (remoteId: string) => void;
  onRefresh: () => void;
};

export function computerStatus(workspace: YaozhaiWorkspace): { key: 'online' | 'blocked' | 'offline'; text: string } {
  if (!workspace.online) return { key: 'offline', text: '离线' };
  if (!workspace.remoteAllowed) return { key: 'blocked', text: '未开远程' };
  return { key: 'online', text: '在线' };
}

/** 纯展示：浏览器侧栏顶部的「云笺 | 遥斋」切换器与遥斋卡片（选中的电脑与书斋、在线电脑列表）；状态与操作由宿主通过 props 提供。 */
export default function YaozhaiPanel({
  mode, workspaces, selected, loaded, error, signedIn, onSwitchMode, onSelect, onRefresh,
}: YaozhaiPanelProps) {
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  usePopoverDismiss(open, useCallback(() => setOpen(false), []), container, trigger);
  const modes: Array<{ value: WebMode; name: string; Icon: typeof Cloud }> = [
    { value: 'yunjian', name: '云笺', Icon: Cloud },
    { value: 'yaozhai', name: '遥斋', Icon: MonitorSmartphone },
  ];
  const status = selected ? computerStatus(selected) : null;
  const statusText = status?.key === 'online' ? '在线 · 远程已允许' : status?.text;

  return (
    <div className="shuzhai-panel" ref={container}>
      <div className="shuzhai-mode-switch" role="radiogroup" aria-label="工作模式">
        {modes.map(({ value, name, Icon }) => (
          <button key={value} type="button" role="radio" aria-checked={mode === value}
            className={`shuzhai-mode-option${mode === value ? ' is-selected' : ''}`}
            title={value === 'yunjian' ? '云笺：项目写在云端，Preview 即刻可见' : signedIn ? '遥斋：遥控电脑上 Gor 桌面端的书斋' : '遥斋需要先登录'}
            disabled={value === 'yaozhai' && !signedIn && mode !== 'yaozhai'}
            onClick={() => { if (mode !== value) onSwitchMode(value); }}>
            <Icon aria-hidden="true" /><span>{name}</span>
          </button>
        ))}
      </div>

      {mode === 'yaozhai' && (selected ? (
        <button ref={trigger} type="button" className={`shuzhai-card is-${status?.key === 'online' ? 'connected' : 'disconnected'}`}
          aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? panelId : undefined}
          aria-label={`遥斋：${selected.deviceName} · ${selected.name}，${statusText}`} title={selected.path}
          onClick={() => setOpen((value) => !value)}>
          <span className="shuzhai-card-icon"><Monitor aria-hidden="true" /></span>
          <span className="shuzhai-card-copy">
            <strong>{selected.deviceName} · {selected.name}</strong>
            <span className="shuzhai-card-path">{selected.path}</span>
            <span className="shuzhai-card-status"><span className="shuzhai-dot" aria-hidden="true" />{statusText}</span>
          </span>
          <ChevronDown className="shuzhai-card-chevron" aria-hidden="true" />
        </button>
      ) : (
        <button ref={trigger} type="button" className="shuzhai-card is-empty" aria-haspopup="dialog" aria-expanded={open}
          onClick={() => { onRefresh(); setOpen((value) => !value); }}>
          <span className="shuzhai-card-icon"><Plus aria-hidden="true" /></span>
          <span className="shuzhai-card-copy"><strong>未选电脑</strong>
            <span className="shuzhai-card-path">{loaded ? '选一台电脑上的书斋' : '正在查找电脑…'}</span></span>
        </button>
      ))}

      {open && mode === 'yaozhai' && (
        <section id={panelId} role="dialog" aria-label="选择要遥控的书斋" className="shuzhai-popover">
          <h2>本账号的电脑</h2>
          <div className="shuzhai-recent-list">
            {workspaces.map((item) => {
              const current = item.remoteId === selected?.remoteId;
              const itemStatus = computerStatus(item);
              return (
                <button key={item.remoteId} type="button" className={`shuzhai-recent yaozhai-computer is-${itemStatus.key}${current ? ' is-current' : ''}`}
                  aria-current={current ? 'true' : undefined} disabled={itemStatus.key !== 'online' && !current} title={item.path}
                  onClick={() => { setOpen(false); if (!current) onSelect(item.remoteId); }}>
                  <span className="shuzhai-dot" aria-hidden="true" />
                  <span className="shuzhai-recent-copy"><strong>{item.deviceName} · {item.name}</strong><span>{itemStatus.text} · {item.path}</span></span>
                  {current && <Check aria-hidden="true" />}
                </button>
              );
            })}
            {loaded && !workspaces.length && <p className="shuzhai-welcome-hint">还没有电脑登记书斋：在电脑上的 Gor 打开书斋并登录同一账号。</p>}
          </div>
          {error && <p className="shuzhai-welcome-error">{error}</p>}
          <div className="shuzhai-popover-divider" aria-hidden="true" />
          <div className="shuzhai-popover-actions">
            <button type="button" className="shuzhai-action" onClick={onRefresh}><RefreshCw aria-hidden="true" />刷新列表</button>
          </div>
        </section>
      )}
    </div>
  );
}
