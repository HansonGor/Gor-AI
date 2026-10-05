import { useId } from 'react';

export default function SessionCacheLoader({ statusText }: { statusText: string }) {
  const moonMaskId = `moon-flow-${useId().replace(/:/g, '')}`;
  const decorationMaskId = `${moonMaskId}-decorations`;
  const featherId = `${moonMaskId}-feather`;
  return (
    <div className="session-cache-loading" role="status" aria-live="polite" aria-busy="true">
      <div className="session-cache-loading-content">
        <div className="session-cache-art-stage" aria-hidden="true">
          <img
            className="session-cache-illustration-base"
            src={`${import.meta.env.BASE_URL}images/session-cache-moon-ring.png`}
            alt=""
            draggable={false}
          />
          <img className="session-cache-water-texture" src={`${import.meta.env.BASE_URL}images/session-cache-moon-ring.png`} alt="" draggable={false} />
          <img className="session-cache-water-texture session-cache-water-texture-two" src={`${import.meta.env.BASE_URL}images/session-cache-moon-ring.png`} alt="" draggable={false} />
          <span className="session-cache-ripple-wave session-cache-ripple-wave-one" />
          <span className="session-cache-ripple-wave session-cache-ripple-wave-two" />
          <span className="session-cache-ripple-wave session-cache-ripple-wave-three" />
          <span className="session-cache-moon-window">
            <svg className="session-cache-moon-layers" viewBox="0 0 1254 1254" focusable="false">
              <defs>
                <filter id={featherId}><feGaussianBlur stdDeviation="8" /></filter>
                {/* Mask the source BEFORE rotation, keeping its blossoms and orbital details still. */}
                <mask id={moonMaskId} maskUnits="userSpaceOnUse" x="0" y="0" width="1254" height="1254">
                  <circle cx="655" cy="560" r="362" fill="none" stroke="white" strokeWidth="166" filter={`url(#${featherId})`} />
                  <path d="M 110 420 Q 225 415 350 545 Q 430 650 550 880 L 360 930 Q 110 800 80 620 Z" fill="black" filter={`url(#${featherId})`} />
                  <path d="M 795 500 Q 965 355 1254 370 L 1254 650 Q 975 685 780 570 Z" fill="black" filter={`url(#${featherId})`} />
                  <path d="M 0 620 Q 140 570 230 645 L 270 780 L 0 800 Z" fill="black" filter={`url(#${featherId})`} />
                </mask>
                <mask id={decorationMaskId} maskUnits="userSpaceOnUse" x="0" y="0" width="1254" height="1254">
                  <path d="M 110 420 Q 225 415 350 545 Q 430 650 550 880 L 360 930 Q 110 800 80 620 Z" fill="white" filter={`url(#${featherId})`} />
                  <path d="M 795 500 Q 965 355 1254 370 L 1254 650 Q 975 685 780 570 Z" fill="white" filter={`url(#${featherId})`} />
                  <path d="M 0 620 Q 140 570 230 645 L 270 780 L 0 800 Z" fill="white" filter={`url(#${featherId})`} />
                </mask>
              </defs>
              <g className="session-cache-moon-rotor">
                <image href={`${import.meta.env.BASE_URL}images/session-cache-moon-ring.png`} width="1254" height="1254" mask={`url(#${moonMaskId})`} />
              </g>
              <image href={`${import.meta.env.BASE_URL}images/session-cache-moon-ring.png`} width="1254" height="1254" mask={`url(#${decorationMaskId})`} />
            </svg>
          </span>
          <span className="session-cache-falling-petals">
            {Array.from({ length: 9 }, (_, index) => (
              <span className="session-cache-petal-track" key={index}>
                <i className="session-cache-petal" />
                <i className="session-cache-petal-splash" />
              </span>
            ))}
          </span>
        </div>

        <p className="session-cache-loading-title">月轮既起，万象徐明…</p>
        <div className="session-cache-loading-status">
          <i aria-hidden="true" />
          <span>{statusText}</span>
          <i aria-hidden="true" />
        </div>
      </div>
    </div>
  );
}
