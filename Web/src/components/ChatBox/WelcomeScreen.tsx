import type { WelcomeScreenProps } from '../../types';

export default function WelcomeScreen(_props: WelcomeScreenProps) {
  return (
    <div className="welcome-screen new-session-welcome" aria-label="Gor 欢迎页">
      <svg className="welcome-hero-mark" viewBox="690 80 460 580" aria-hidden="true" focusable="false">
        <image href={`${import.meta.env.BASE_URL}images/gor-welcome-mark.png`} width="2170" height="725" />
      </svg>
      <h2 className="welcome-title">你好，我是 <span>Gor</span></h2>
      <div className="welcome-divider" aria-hidden="true"><span /></div>
      <p className="welcome-desc">烟雨入江南，灯火照归舟。</p>
      <p className="welcome-motto">世间万千问，我与你，一程一程寻。</p>
    </div>
  );
}
