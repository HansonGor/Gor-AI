/**
 * 移动端 REM 适配工具（仅移动端）
 *
 * 设计稿基准：375px 宽度
 * 1rem = 50px（375px 宽时）
 * 标准文字 14px = 0.28rem
 *
 * 设备参考（真实物理 dpr，与标准 flexible.js 一致）：
 * - iPhone SE:       375px 宽, dpr=2
 * - iPhone XR/11:    414px 宽, dpr=2
 * - iPhone XS Max/11 Pro: 414px 宽, dpr=3
 *
 * 换算公式：
 *   html font-size = (屏幕宽度 / 375) * 50
 *   设计稿 px 值 / 50 = rem 值
 */

(function flexible() {
  const docEl = document.documentElement;
  // 标准 flexible.js：直接用真实 devicePixelRatio，取整，移动端最小为2
  // iPhone SE dpr=2, iPhone XR dpr=2, iPhone XS Max/11 Pro dpr=3
  const dpr = Math.max(2, Math.round(window.devicePixelRatio || 2));

  // 设置 body 字体大小，防止 rem 继承导致文字异常
  function setBodyFontSize() {
    if (document.body) {
      document.body.style.fontSize = 12 * dpr + 'px';
    } else {
      document.addEventListener('DOMContentLoaded', setBodyFontSize);
    }
  }
  setBodyFontSize();

  // 设置 html font-size
  // 移动端：(屏幕宽度 / 375) * 50，375px 宽 → 1rem = 50px
  // PC端（≥1024px）：固定 1rem = 50px（和移动端 375 宽时一致，现有 rem 值不变形）
  function setRemUnit() {
    const width = docEl.clientWidth;
    let rem;
    if (width >= 1024) {
      // PC端：固定基准，现有 rem 值和移动端一致
      rem = 50;
    } else {
      // 移动端：按设计稿缩放
      rem = (width / 375) * 50;
    }
    docEl.style.fontSize = rem + 'px';
  }
  setRemUnit();

  // 监听窗口尺寸变化
  window.addEventListener('resize', setRemUnit);
  window.addEventListener('orientationchange', setRemUnit);
  window.addEventListener('pageshow', (e) => {
    if (e.persisted) setRemUnit();
  });

  // 标记 dpr，供 CSS 媒体查询使用（如 1px 边框、高清图适配）
  docEl.setAttribute('data-dpr', String(dpr));
})();

export {};
