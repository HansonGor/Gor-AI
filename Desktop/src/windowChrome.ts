/**
 * 无系统标题栏的窗口外观（目前只用于 Windows）：隐藏标题栏，最小化/最大化/关闭浮在页面右上角，
 * 背景透明；页面顶部的品牌区与标题栏区域作为拖动区。样式由主进程注入，Web 代码不感知桌面端。
 */

// Windows 三枚窗口按钮约 138px 宽（100% 缩放下的 CSS 像素），高度与页面顶部标题文字对齐
export const TITLE_BAR_HEIGHT = 36;
export const WINDOW_CONTROLS_MIN_WIDTH = 140;

export const TITLE_BAR_OVERLAY = {
  color: '#00000000',
  symbolColor: '#e8e6f5',
  height: TITLE_BAR_HEIGHT,
};

export function usesOverlayTitleBar(platform: NodeJS.Platform): boolean {
  return platform === 'win32';
}

// 窗口按钮实际宽度：优先用 Chromium 提供的 titlebar-area 环境变量，拿不到时按固定宽度留位
const controlsWidth = `max(${WINDOW_CONTROLS_MIN_WIDTH}px, calc(100vw - env(titlebar-area-x, 0px) - env(titlebar-area-width, 100vw)))`;

export const WINDOW_CHROME_CSS = `
/* Gor Desktop：页面顶部作为窗口拖动区（双击可最大化/还原） */
.gor-brand, .chat-header { -webkit-app-region: drag; }
/* 其余页面没有标题栏时，顶部一条细带同样可拖动，右侧让出窗口按钮 */
body::before {
  content: '';
  position: fixed;
  z-index: 2147483646;
  top: 0;
  left: 0;
  right: ${controlsWidth};
  height: ${TITLE_BAR_HEIGHT}px;
  pointer-events: none;
  -webkit-app-region: drag;
}
/* 可交互元素不参与拖动，保持可点 */
button, a, input, textarea, select, label, summary, [role="button"], [role="menuitem"], [role="tab"],
[role="dialog"], [role="menu"], [contenteditable="true"] { -webkit-app-region: no-drag; }
/* 标题栏右侧按钮（分享等）让出右上角的窗口按钮 */
.chat-header-right { margin-right: ${controlsWidth}; }
`;
