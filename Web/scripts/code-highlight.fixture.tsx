import { useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import '../src/index.css';
import '../src/components/ChatBox/ChatBox.less';
import '../src/components/chat/styles.less';
import CodeDiff from '../src/components/chat/CodeDiff';
import { presentDiff } from '../src/components/chat/diffPresentation';
import PreviewSourceViewer from '../src/components/preview/PreviewSourceViewer';
import { markdownCodeComponents } from '../src/components/chat/MarkdownCodeBlock';
import { useChatShare } from '../src/share/useChatShare';
import { ChatSharePreview } from '../src/components/chat/ChatShareControls';
import { saveBlob } from '../src/preview/core/saveFile';
const sample =
  '行内代码 `const value = 1` 保留原样。\n\n```tsx\ninterface Props { title: string }\nexport const App = ({ title }: Props) => <section title="Gor">{title}</section>;\n```\n\n```python\ndef greet(name: str):\n    return f"你好，{name}"\n```\n\n```json\n{"name": "Gor", "enabled": true, "count": 3}\n```\n\n```\n未声明语言 <img src=x onerror=alert(1)> & 特殊字符\n```';
function App() {
  const [surfaces, setSurfaces] = useState(false);
  const [split, setSplit] = useState(false);
  const [source, setSource] = useState(
    'import { useState } from "react";\n\ninterface Props { title: string }\nexport const App = ({ title }: Props) => {\n  const [count, setCount] = useState(0);\n  return <section title="Gor"><button onClick={() => setCount(count + 1)}>{title}: {count}</button></section>;\n};\n' +
      Array.from({ length: 80 }, (_, i) => `// 原有源码第 ${i + 1} 行，江南夜色。`).join('\n') +
      '\n',
  );
  const raw =
    '--- a/App.tsx\n+++ b/App.tsx\n@@ -1,4 +1,4 @@\n import { useState } from "react";\n-const title: string = "old";\n+const title: string = "Gor";\n export const App = () => <section>{title}</section>;\n export default App;\n';
  const diff = useMemo(() => presentDiff(raw), [raw]);
  const [content, setContent] = useState(sample);
  const [streaming, setStreaming] = useState(false);
  const components = useMemo(() => markdownCodeComponents({ streaming }), [streaming]);
  const messages = useMemo(
    () => [{ id: 'code-sample', role: 'assistant' as const, content }],
    [content],
  );
  const share = useChatShare('code-fixture', messages);
  return (
    <main style={{ background: '#1d233b', color: '#e7e5f4', minHeight: '100vh', padding: 16 }}>
      <h1>Gor 代码高亮验收 · 示例内容</h1>
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', margin: '16px 0' }}>
        <button onClick={() => setSurfaces(!surfaces)}>源码与 Diff 示例</button>
        <button
          onClick={() => {
            setStreaming(false);
            setContent(sample);
          }}
        >
          多语言示例
        </button>
        <button
          onClick={() => {
            setStreaming(true);
            setContent('```tsx\nconst text = "正在接收');
          }}
        >
          未闭合流式示例
        </button>
        <button
          onClick={() => {
            setStreaming(false);
            setContent(
              '```ts\n' +
                Array.from(
                  { length: 600 },
                  (_, i) => `const item${i}: string = "山水相逢 ${i}";`,
                ).join('\n') +
                '\n```',
            );
          }}
        >
          长代码示例
        </button>
        <button
          onClick={() => {
            share.start();
          }}
        >
          选择分享示例
        </button>
        {share.selecting && (
          <>
            <button onClick={() => share.selection?.onToggle('code-sample')}>勾选代码回复</button>
            <button disabled={!share.count} onClick={() => void share.generate()}>
              生成分享图
            </button>
          </>
        )}
      </div>
      {surfaces ? (
        <section
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit,minmax(min(100%,360px),1fr))',
            gap: 16,
          }}
        >
          <div>
            <h2>Diff 颜色 · 保留差异背景</h2>
            <button onClick={() => setSplit(!split)}>切换 Unified / Split</button>
            <CodeDiff
              path="App.tsx"
              raw={raw}
              model={diff}
              viewType={split ? 'split' : 'unified'}
            />
          </div>
          <div style={{ height: 500, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
            <h2>Preview · 原生文本编辑</h2>
            <PreviewSourceViewer path="App.tsx" source={source} onChange={setSource} />
          </div>
        </section>
      ) : (
        <article className="markdown-body" style={{ maxWidth: 850, margin: '0 auto' }}>
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
            {content}
          </ReactMarkdown>
        </article>
      )}
      <ChatSharePreview share={share} save={saveBlob} />
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<App />);
