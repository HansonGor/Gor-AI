import React from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import './utils/rem';
import './index.less';
import App from './App';
import { FeedbackProvider } from './components/ui/feedback';
import { installDesktopRuntime } from './desktop/desktopRuntime';

document.documentElement.dataset.gorClientMode = 'web';
// 桌面端：按上次选择的模式（云笺 / 书斋）设定 clientMode；浏览器中没有桥接，保持 web
installDesktopRuntime();

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Root element not found');
}

createRoot(rootElement).render(
  <React.StrictMode>
    <FeedbackProvider>
      <App />
    </FeedbackProvider>
  </React.StrictMode>,
);
