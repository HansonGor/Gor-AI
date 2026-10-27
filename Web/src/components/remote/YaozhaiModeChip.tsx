import { Cloud, MonitorSmartphone } from 'lucide-react';
import type { WebMode, YaozhaiWorkspace } from '../../remote/remoteRuntime';
import { computerStatus } from './YaozhaiPanel';
import '../desktop/Shuzhai.less';

export type YaozhaiModeChipProps = {
  mode: WebMode;
  selected: YaozhaiWorkspace | null;
  /** 打开会话侧栏（侧栏顶部有完整的切换器与遥斋卡片）。 */
  onOpen: () => void;
};

/** 纯展示：窄屏菜单按钮旁的模式图标；遥斋时图标颜色表示电脑是否可用，电脑名与书斋名在读屏标签和悬停提示里。 */
export default function YaozhaiModeChip({ mode, selected, onOpen }: YaozhaiModeChipProps) {
  const status = selected ? computerStatus(selected) : null;
  const detail = mode === 'yunjian' ? '云笺' : selected ? `遥斋 · ${selected.deviceName} · ${selected.name}，${status!.text}` : '遥斋 · 未选电脑';
  const stateClass = mode === 'yaozhai' ? ` is-${status?.key === 'online' ? 'connected' : status ? 'disconnected' : 'empty'}` : '';
  return (
    <button type="button" className={`shuzhai-mode-chip is-${mode}${stateClass}`}
      aria-label={`当前模式：${detail}，打开侧栏切换`} title={detail} onClick={onOpen}>
      {mode === 'yunjian' ? <Cloud aria-hidden="true" /> : <MonitorSmartphone aria-hidden="true" />}
      <span className="shuzhai-mode-chip-name">{mode === 'yunjian' ? '云笺' : '遥斋'}</span>
    </button>
  );
}
