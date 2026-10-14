import { useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import ReactMarkdown from 'react-markdown';
import { configureCodeHighlightWorker } from '../src/components/chat/codeHighlight/client';
import { VscodeCodeHighlightWorker } from '../src/vscode/codeHighlightWorker';
import { markdownCodeComponents } from '../src/components/chat/MarkdownCodeBlock';
import CodeDiff from '../src/components/chat/CodeDiff';
import { presentDiff } from '../src/components/chat/diffPresentation';
import '../src/index.css';
import '../src/components/ChatBox/ChatBox.less';
document.documentElement.dataset.gorClientMode = 'vscode';
configureCodeHighlightWorker(() => new VscodeCodeHighlightWorker());
function App() {
  const [split, setSplit] = useState(false);
  const raw =
    '--- a/App.tsx\n+++ b/App.tsx\n@@ -1 +1 @@\n-export const App = () => <section>old</section>;\n+export const App = () => <section>Gor</section>;\n';
  const model = useMemo(() => presentDiff(raw), [raw]);
  return (
    <main
      style={{
        background: '#1d233b',
        color: '#e7e5f4',
        minHeight: '100vh',
        padding: 16,
        maxWidth: '100%',
      }}
    >
      <h1>VS Code Blob Worker · 严格 CSP 验收夹具</h1>
      <article className="markdown-body">
        <ReactMarkdown components={markdownCodeComponents()}>
          {
            '```tsx\nexport const App = () => <section title="Gor">山水相逢</section>;\n```\n\n```python\ndef greet(name):\n    return f"你好，{name}"\n```\n\n```json\n{"name":"Gor","enabled":true}\n```'
          }
        </ReactMarkdown>
      </article>
      <button onClick={() => setSplit(!split)}>切换 Diff 视图</button>
      <CodeDiff path="App.tsx" raw={raw} model={model} viewType={split ? 'split' : 'unified'} />
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<App />);
