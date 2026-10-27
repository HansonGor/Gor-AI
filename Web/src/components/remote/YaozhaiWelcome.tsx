import { MonitorSmartphone, RefreshCw } from 'lucide-react';
import type { YaozhaiWorkspace } from '../../remote/remoteRuntime';
import { computerStatus } from './YaozhaiPanel';
import '../desktop/Shuzhai.less';

export type YaozhaiWelcomeProps = {
  workspaces: YaozhaiWorkspace[];
  selected: YaozhaiWorkspace | null;
  loaded: boolean;
  error: string | null;
  signedIn: boolean;
  onSelect: (remoteId: string) => void;
  onRefresh: () => void;
  onSignIn?: () => void;
};

/** 纯展示：遥斋还不能用（未登录、没有可用电脑、电脑离线或未开远程）时的空状态。 */
export default function YaozhaiWelcome({ workspaces, selected, loaded, error, signedIn, onSelect, onRefresh, onSignIn }: YaozhaiWelcomeProps) {
  const usable = workspaces.filter((item) => computerStatus(item).key === 'online');
  const blocked = selected && computerStatus(selected).key !== 'online';
  const desc = !signedIn ? '遥斋需要登录与电脑上 Gor 桌面端相同的账号。'
    : blocked ? `${selected!.deviceName}${computerStatus(selected!).key === 'offline' ? ' 当前离线' : ' 还没有允许网页遥控'}。在电脑的书斋弹层里打开「允许网页遥控此书斋」。`
      : '在电脑上的 Gor 打开书斋，并在书斋弹层里打开「允许网页遥控此书斋」，这里就能遥控它。';
  return (
    <section className="shuzhai-welcome" aria-labelledby="yaozhai-welcome-title">
      <span className="shuzhai-welcome-icon"><MonitorSmartphone aria-hidden="true" /></span>
      <h2 id="yaozhai-welcome-title">遥控书斋</h2>
      <p className="shuzhai-welcome-desc">{desc}</p>
      {error && <p className="shuzhai-welcome-error">{error}</p>}
      <div className="shuzhai-welcome-actions">
        {!signedIn && onSignIn
          ? <button type="button" className="shuzhai-welcome-primary" onClick={onSignIn}>登录</button>
          : <button type="button" className="shuzhai-welcome-secondary" onClick={onRefresh}><RefreshCw aria-hidden="true" />{loaded ? '刷新' : '正在查找…'}</button>}
      </div>
      {signedIn && usable.length > 0 && (
        <div className="shuzhai-welcome-recent">
          <h3>可以遥控的书斋</h3>
          {usable.map((item) => (
            <button key={item.remoteId} type="button" className="shuzhai-recent" title={item.path} onClick={() => onSelect(item.remoteId)}>
              <span className="shuzhai-recent-copy"><strong>{item.deviceName} · {item.name}</strong><span>{item.path}</span></span>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
