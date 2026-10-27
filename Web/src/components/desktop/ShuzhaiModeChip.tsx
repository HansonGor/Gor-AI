import { Cloud, LampDesk } from 'lucide-react';
import type { DesktopMode, ShuzhaiState } from '../../desktop/desktopRuntime';
import './Shuzhai.less';

export type ShuzhaiModeChipProps = {
  mode: DesktopMode;
  state: ShuzhaiState;
  /** 打开会话侧栏（侧栏顶部有完整的切换器与书斋卡片）。 */
  onOpen: () => void;
};

/** 纯展示：桌面端窄窗口下菜单按钮旁的模式图标；宽屏侧栏常驻时隐藏。模式与书斋名在读屏标签和悬停提示里。 */
export default function ShuzhaiModeChip({ mode, state, onOpen }: ShuzhaiModeChipProps) {
  // 胶囊只显示模式名，避免压住窄屏标题；书斋名与路径放在读屏标签和悬停提示里，连接状态用图标颜色表示
  const name = mode === 'yunjian' ? '云笺' : '书斋';
  const detail = mode === 'yunjian' ? '云笺' : state.folder ? `书斋 · ${state.folder.name}` : '书斋 · 未择书斋';
  return (
    <button type="button" className={`shuzhai-mode-chip is-${mode}${mode === 'shuzhai' ? ` is-${state.folder ? state.connection : 'empty'}` : ''}`}
      aria-label={`当前模式：${detail}，打开侧栏切换`} title={state.folder?.path ?? detail} onClick={onOpen}>
      {mode === 'yunjian' ? <Cloud aria-hidden="true" /> : <LampDesk aria-hidden="true" />}
      <span className="shuzhai-mode-chip-name">{name}</span>
    </button>
  );
}
