const assert = require('node:assert/strict');
const test = require('node:test');
const { TITLE_BAR_OVERLAY, TITLE_BAR_HEIGHT, usesOverlayTitleBar, WINDOW_CHROME_CSS } = require('../out/windowChrome.js');

test('only Windows drops the system title bar for now', () => {
  assert.equal(usesOverlayTitleBar('win32'), true);
  assert.equal(usesOverlayTitleBar('darwin'), false, 'macOS 红绿灯位置未适配，暂保留系统标题栏');
  assert.equal(usesOverlayTitleBar('linux'), false);
});

test('window buttons float over a transparent background at the title-bar height', () => {
  assert.equal(TITLE_BAR_OVERLAY.color, '#00000000', '背景透明，页面背景图一直延伸到顶部');
  assert.equal(TITLE_BAR_OVERLAY.height, TITLE_BAR_HEIGHT);
  assert.match(TITLE_BAR_OVERLAY.symbolColor, /^#[0-9a-f]{6}$/i);
});

test('injected CSS makes the header draggable, keeps controls clickable, and moves the share button aside', () => {
  const rule = (selector) => WINDOW_CHROME_CSS.match(new RegExp(`${selector}[^{]*\\{([^}]*)\\}`))?.[1] ?? '';
  assert.match(rule('\\.gor-brand, \\.chat-header'), /-webkit-app-region: drag;/);
  const noDrag = WINDOW_CHROME_CSS.replace(/\/\*[\s\S]*?\*\//g, '').match(/([^{}]+)\{ -webkit-app-region: no-drag; \}/)?.[1] ?? '';
  for (const selector of ['button', 'a', 'input', 'textarea', 'select', '[role="button"]', '[role="menuitem"]', '[role="dialog"]']) {
    assert.ok(noDrag.split(',').map((part) => part.trim()).includes(selector), `${selector} 不参与拖动`);
  }
  assert.match(rule('\\.chat-header-right'), /margin-right: max\(140px, calc\(100vw - env\(titlebar-area-x, 0px\) - env\(titlebar-area-width, 100vw\)\)\);/);
  const strip = rule('body::before');
  assert.match(strip, /position: fixed;/);
  assert.match(strip, /pointer-events: none;/, '细带本身不吃点击');
  assert.match(strip, new RegExp(`height: ${TITLE_BAR_HEIGHT}px;`));
});
