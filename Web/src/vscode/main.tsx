import React from 'react';
import { createRoot } from 'react-dom/client';
import { FeedbackProvider } from '../components/ui/feedback';
import ChatPage from '../pages/chat/ChatPage';
import '../index.css';
import '../utils/rem';
import '../index.less';
import './vscode.css';
import { installVscodeWebviewRuntime } from './vscodeRuntime';
import { configureCodeHighlightWorker } from '../components/chat/codeHighlight/client';
import { VscodeCodeHighlightWorker } from './codeHighlightWorker';

installVscodeWebviewRuntime();
configureCodeHighlightWorker(() => new VscodeCodeHighlightWorker());

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <FeedbackProvider>
      <ChatPage />
    </FeedbackProvider>
  </React.StrictMode>,
);
