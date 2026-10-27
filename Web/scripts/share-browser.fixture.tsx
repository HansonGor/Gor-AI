import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import '../src/index.css';
import '../src/index.less';
import '../src/utils/rem';
import '../src/components/ChatBox/ChatBox.less';
import '../src/components/Sidebar/Sidebar.less';
import '../src/components/chat/styles.less';
import MessageList from '../src/components/ChatBox/MessageList';
import Header from '../src/components/ChatLayout/ChatHeader';
import Template from '../src/components/chat/ShareImageTemplate';
import { ChatShareToolbar, ChatSharePreview } from '../src/components/chat/ChatShareControls';
import { useChatShare } from '../src/share/useChatShare';
import { extractShareMessages } from '../src/share/shareContent';
import { saveBlob } from '../src/preview/core/saveFile';
import { FeedbackProvider } from '../src/components/ui/feedback';
const initial = [
  {
    id: 'u1',
    role: 'user',
    content: '11 月适合去中国哪些地方旅行？想看红叶，也想感受江南的秋天。',
  },
  {
    id: 'a1',
    role: 'assistant',
    content:
      '# 秋色入画，山河正好\n\n十一月的中国，既有江南的温婉，也有北方的银杏与红叶。\n\n若喜欢清雅秋色，可以选择苏州天平山、南京栖霞山；若向往壮丽山河，可以考虑北京香山与四川九寨沟。',
    toolStatus: '秘密工具',
    tokenUsage: { prompt_tokens: 700, completion_tokens: 300, total_tokens: 1000 },
    thinkingTrace: {
      status: 'completed',
      rounds: [{ id: 'r', title: '内部思考', content: '秘密推理', status: 'completed' }],
    },
  },
  { id: 'u2', role: 'user', content: '请生成一份 PPT，保留表格和代码。' },
  {
    id: 'a2',
    role: 'assistant',
    content:
      '# 演示文稿已准备\n\n正式回答内容，包含事实 [S1]。\n\n- 第一项\n- 第二项\n\n> 引用正文\n\n| 章节 | 内容 |\n| --- | --- |\n| 开篇 | 江南夜色 |\n| 收笔 | 山水相逢 |\n\n```ts\nconst title = "江南夜色";\nconsole.log(title);\n```\n\n![正文图片](/images/gor-header-logo.png)',
    searchSources: [{ sourceId: 'S1', title: '来源名称', url: 'https://example.com' }],
    files: [{ displayName: '内部 PPT', fileType: 'pptx', downloadUrl: '/fake.pptx' }],
  },
];
function App() {
  const [webview, setWebview] = useState(false);
  const [data, setData] = useState(initial);
  const [session, setSession] = useState('fixture');
  const [result, setResult] = useState('');
  const share = useChatShare(session, data as any);
  const stress = async () => {
    const host = document.createElement('div');
    host.className = 'gor-share-render-host';
    document.body.append(host);
    const mount = document.createElement('div');
    host.append(mount);
    const root = createRoot(mount);
    const md =
      '# 长卷验收\n\n' +
      Array.from({ length: 80 }, (_, i) => `段落 ${i}：江南夜色，文字完整。`).join('\n\n') +
      '\n\n```txt\n' +
      Array.from({ length: 150 }, (_, i) => `代码行 ${i}：abcdefghijklmnopqrstuvwxyz`).join('\n') +
      '\n```\n\n|编号|文字|\n|--|--|\n' +
      Array.from({ length: 100 }, (_, i) => `|${i}|表格单元格 ${i}|`).join('\n') +
      '\n\n' +
      '超长单段落完整文本'.repeat(500) +
      '\n\n1. 一\n2. 二\n3. 三';
    try {
      flushSync(() =>
        root.render(
          <Template
            messages={extractShareMessages(
              [{ id: 'long', role: 'assistant', content: md }] as any,
              new Set(['long']),
            )}
          />,
        ),
      );
      await Promise.all([...mount.querySelectorAll('img')].map((img) => img.decode()));
      await document.fonts.ready;
      const sheet = mount.querySelector('.gor-share-sheet') as HTMLElement;
      setResult(
        JSON.stringify({
          height: Math.round(sheet.getBoundingClientRect().height),
          landscape: sheet.querySelectorAll('.gor-share-landscape').length,
          brand: sheet.querySelectorAll('.gor-share-brand').length,
          footer: sheet.querySelectorAll('.gor-share-footer').length,
          lastText: sheet.querySelector('.gor-share-card')?.textContent?.slice(-40),
        }),
      );
    } catch (e) {
      setResult(String(e));
    } finally {
      root.unmount();
      host.remove();
    }
  };
  return (
    <FeedbackProvider>
      <div
        className={`chat-page${webview ? ' is-vscode-plugin' : ''}`}
        style={{ height: '100vh', display: 'flex', flexDirection: 'column', padding: 12 }}
      >
        <Header
          isVscodePluginMode={webview}
          isEmpty={!data.length}
          isPC={true}
          sidebarOpen={false}
          canGoBack={false}
          title="分享验收 · 独立夹具"
          hasPreviewWorkerContent={true}
          previewWorkerOpen={true}
          previewableGeneratedFileCount={0}
          hasShareableMessages={data.length > 0}
          onBack={() => {}}
          onMenuClick={() => {}}
          onTogglePreviewWorker={() => {}}
          onShare={share.start}
        />
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 12,
            fontSize: 14,
            color: 'white',
            marginTop: 65,
          }}
        >
          <button onClick={() => setWebview(!webview)}>切换窄屏 Webview 样式</button>
          <button
            onClick={() => {
              setData([]);
              setSession('empty');
            }}
          >
            空会话
          </button>
          <button
            onClick={() => {
              setData(initial);
              setSession('restored');
            }}
          >
            历史恢复
          </button>
          <button
            onClick={() =>
              setData([
                { id: 'bad', role: 'assistant', content: '![图片](/not-found-body.png)' },
              ] as any)
            }
          >
            失败图片
          </button>
          <button
            onClick={() =>
              setData([
                {
                  id: 'long',
                  role: 'assistant',
                  content: Array.from(
                    { length: 100 },
                    (_, i) => `## 段落 ${i}\n\n完整正文 江南夜色 ${i}。`,
                  ).join('\n\n'),
                },
              ] as any)
            }
          >
            超长内容
          </button>
          <button onClick={() => void stress()}>检查长图排版</button>
          {[1, 5, 20].map((count) => (
            <button
              key={count}
              onClick={() => {
                setData(
                  Array.from({ length: count }, (_, index) => ({
                    id: `sample-${index}`,
                    role: index % 2 ? 'assistant' : 'user',
                    content: `第 ${index + 1} 条正式正文。江南夜色，山水相逢。`,
                  })) as any,
                );
                setSession(`sample-${count}`);
              }}
            >
              {count} 条消息
            </button>
          ))}
          <button
            onClick={() => {
              setData([
                { id: 'extreme', role: 'assistant', content: '极长内容不应裁切。'.repeat(6000) },
              ] as any);
              setSession('extreme');
            }}
          >
            极长内容
          </button>
        </div>
        <details style={{ color: 'white', fontSize: 14 }}>
          <summary>长图检查结果</summary>
          <output
            style={{ display: 'block', maxHeight: 100, overflow: 'auto', overflowWrap: 'anywhere' }}
          >
            {result}
          </output>
        </details>
        <div className="messages-container" style={{ flex: 1 }}>
          <MessageList messages={data as any} shareSelection={share.selection} />
        </div>
        <div className="input-dock">
        <ChatShareToolbar share={share} />
        <ChatSharePreview share={share} save={saveBlob} />
        <textarea aria-label="聊天输入" placeholder="原有输入不受影响" style={{ height: 50 }} />
        </div>
      </div>
    </FeedbackProvider>
  );
}
createRoot(document.getElementById('root')!).render(<App />);
