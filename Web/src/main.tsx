import React from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import './utils/rem';
import './index.less';
import App from './App';
import { FeedbackProvider } from './components/ui/feedback';

document.documentElement.dataset.gorClientMode = 'web';

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
