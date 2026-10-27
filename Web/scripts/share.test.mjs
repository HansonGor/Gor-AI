import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import less from 'less';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Module, { createRequire } from 'node:module';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';

const filename = fileURLToPath(new URL('./share.fixture.cjs', import.meta.url));
const compiled = await build({
  stdin: {
    contents: `
 export { extractShareMessages, isShareableMessage, shareCitations } from '../src/share/shareContent';
 export { default as Template } from '../src/components/chat/ShareImageTemplate';
 export { default as MessageList } from '../src/components/ChatBox/MessageList';
 export { useChatShare } from '../src/share/useChatShare';
 export { default as Header } from '../src/components/ChatLayout/ChatHeader';
 export { ChatShareToolbar, saveShareImage } from '../src/components/chat/ChatShareControls';
 export { getUserNickname, FALLBACK_USER_LABEL } from '../src/user/profile';
 export { getAuthState, subscribeAuth } from '../src/user/auth';
`,
    resolveDir: dirname(filename),
    loader: 'ts',
  },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  write: false,
  external: ['react', 'react-dom/*', 'lucide-react', '@radix-ui/*'],
  define: { 'import.meta.env': '{"BASE_URL":"/"}' },
  plugins: [
    {
      name: 'fixtures',
      setup(b) {
        b.onResolve({ filter: /\.(less|css)$/ }, () => ({ path: 'styles', namespace: 'fixture' }));
        b.onResolve({ filter: /\.\/MessageBubble$/ }, () => ({
          path: 'bubble',
          namespace: 'fixture',
        }));
        b.onResolve({ filter: /\.\/exportShareImage$/ }, () => ({
          path: 'export',
          namespace: 'fixture',
        }));
        b.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({
          contents:
            path === 'export'
              ? `export const disposeShareImage=p=>{if(p)globalThis.disposed.push(p)}; export const exportShareImage=(m,s,u)=>globalThis.exporter(m,s,u);`
              : path === 'bubble'
                ? `import React from 'react'; export default function Bubble(p){React.useEffect(()=>{globalThis.bubbleMounts=(globalThis.bubbleMounts||0)+1;},[]);return React.createElement('p',{'data-bubble':p.message.id},p.message.content)}`
                : '',
          loader: 'js',
          resolveDir: dirname(filename),
        }));
      },
    },
  ],
});
const fixture = new Module(filename);
fixture.filename = filename;
fixture.paths = Module._nodeModulePaths(dirname(filename));
fixture.require = createRequire(filename);
fixture._compile(compiled.outputFiles[0].text, filename);
const {
  Header,
  extractShareMessages,
  isShareableMessage,
  Template,
  MessageList,
  useChatShare,
  ChatShareToolbar,
  saveShareImage,
  getUserNickname,
  FALLBACK_USER_LABEL,
} = fixture.exports;
const messages = [
  { id: 'u1', role: 'user', content: '原始提问 [S1]' },
  {
    id: 'a1',
    role: 'assistant',
    content:
      '# 正式回复\n\n答案 [S1] [S99]\n\n- 列表\n\n> 引用\n\n|列|值|\n|--|--|\n|甲|乙|\n\n```ts\nconst ref="[S1]";\n```',
    searchSources: [{ sourceId: 'S1', title: '资料标题', url: 'https://source.test' }],
    thinkingTrace: { rounds: [{ content: '秘密推理' }] },
    toolStatus: '秘密工具',
    tokenUsage: { total_tokens: 123 },
    files: [{ displayName: '内部产物' }],
    previewSnapshot: { name: '内部项目' },
  },
  { id: 'u2', role: 'user', content: '第二轮' },
  { id: 'a2', role: 'assistant', content: '末轮回答' },
];
test('body projection preserves order and original Markdown, excludes all execution fields', () => {
  const result = extractShareMessages(messages, new Set(['a2', 'a1', 'u1']));
  assert.deepEqual(
    result.map((m) => m.id),
    ['u1', 'a1', 'a2'],
  );
  assert.equal(result[1].content, messages[1].content);
  assert.deepEqual(Object.keys(result[1]).sort(), [
    'citationNames',
    'content',
    'id',
    'images',
    'role',
  ]);
  assert.equal(JSON.stringify(result).includes('秘密'), false);
  assert.equal(extractShareMessages([messages[0], messages[0]], new Set(['u1'])).length, 1);
  for (const m of [
    { role: 'system', content: 'status' },
    { role: 'assistant', content: '', toolStatus: 'tool' },
    { role: 'assistant', content: 'stream', isStreaming: true },
    { role: 'user', content: ' ', files: [{}] },
  ])
    assert.equal(isShareableMessage(m), false);
  assert.ok(isShareableMessage({ role: 'user', content: '', images: ['data:image/png;base64,x'] }));
});
test('template renders formal Markdown, readable citations, literal code/user text and no runtime UI', () => {
  const html = renderToStaticMarkup(
    React.createElement(Template, {
      messages: extractShareMessages(messages, new Set(['a1', 'u1'])),
    }),
  );
  const doc = new JSDOM(html).window.document;
  assert.equal(doc.querySelectorAll('.gor-share-message').length, 2);
  assert.deepEqual([...doc.querySelectorAll('.gor-share-label')].map((node) => node.textContent), ['你', 'Gor']);
  for (const selector of ['h1', 'ul li', 'blockquote', 'table td', 'pre code'])
    assert.ok(doc.querySelector(selector), selector);
  assert.ok(doc.querySelector('pre').textContent.includes('[S1]'));
  assert.ok(doc.querySelector('[data-message-id="u1"]').textContent.includes('[S1]'));
  assert.ok(doc.querySelector('[data-message-id="a1"] p').textContent.includes('（资料标题）'));
  assert.equal(html.includes('[S99]'), false);
  for (const text of [
    '秘密推理',
    '内部项目',
    '内部产物',
    '思考已完成',
    '预览演示文稿',
    '阅览源码',
    'Token',
  ])
    assert.equal(html.includes(text), false, text);
});
const dom = new JSDOM('<html><body><div id="root"></div></body></html>', {
  url: 'http://localhost/',
});
for (const name of ['window', 'document', 'Node', 'Element', 'HTMLElement', 'MutationObserver'])
  globalThis[name] =
    name === 'window' ? dom.window : name === 'document' ? dom.window.document : dom.window[name];
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.disposed = [];
let state;
const Harness = ({ session = 'one', data = messages }) => {
  state = useChatShare(session, data);
  return React.createElement(
    React.Fragment,
    null,
    React.createElement(MessageList, { messages: data, shareSelection: state.selection }),
    React.createElement(ChatShareToolbar, { share: state }),
  );
};
test('select single/multiple/cross-round, deselect, cancel, restore and session reset without scroll revision', async () => {
  const root = createRoot(document.getElementById('root'));
  try {
    await act(async () => root.render(React.createElement(Harness)));
    assert.equal(document.querySelector('input'), null);
    const mounts = globalThis.bubbleMounts;
    const bubble = document.querySelector('[data-bubble="u1"]');
    document.getElementById('root').scrollTop = 99;
    await act(async () => state.start());
    assert.equal(document.querySelectorAll('input').length, 4);
    assert.equal(globalThis.bubbleMounts, mounts);
    assert.equal(document.querySelector('[data-bubble="u1"]'), bubble);
    assert.equal(document.getElementById('root').scrollTop, 99);
    assert.ok(
      [...document.querySelectorAll('button')].find((b) => b.textContent === '生成分享图').disabled,
    );
    await act(async () => {
      state.selection.onToggle('a2');
      state.selection.onToggle('u1');
    });
    assert.equal(state.count, 2);
    assert.deepEqual(
      extractShareMessages(messages, state.selection.selectedIds).map((m) => m.id),
      ['u1', 'a2'],
    );
    await act(async () => state.selection.onToggle('u1'));
    assert.equal(state.count, 1);
    await act(async () => root.render(React.createElement(Harness, { session: 'two' })));
    assert.equal(state.selecting, false);
    assert.equal(state.count, 0);
    await act(async () => state.start());
    await act(async () => state.selection.onToggle('a1'));
    await act(async () => state.cancel());
    assert.equal(state.count, 0);
    assert.equal(document.querySelector('input'), null);
  } finally {
    await act(async () => root.unmount());
  }
});
test('preview freezes selection, close retains it; errors, cancellation and stale export are contained', async () => {
  const root = createRoot(document.getElementById('root'));
  let resolveJob, captured;
  globalThis.exporter = (m, s) => {
    captured = m;
    return new Promise((resolve) => {
      resolveJob = resolve;
    });
  };
  try {
    await act(async () => root.render(React.createElement(Harness)));
    await act(async () => {
      state.start();
    });
    await act(async () => state.selection.onToggle('a1'));
    let pending;
    await act(async () => {
      pending = state.generate();
    });
    assert.equal(state.open, true);
    assert.equal(state.busy, true);
    assert.equal(captured[0].content, messages[1].content);
    await act(async () => {
      resolveJob({ url: 'blob:one', blob: {} });
      await pending;
    });
    assert.equal(state.image.url, 'blob:one');
    await act(async () => state.close());
    assert.equal(state.count, 1);
    assert.equal(state.image, null);
    assert.equal(globalThis.disposed.at(-1).url, 'blob:one');
    globalThis.exporter = async () => {
      throw new Error('跨域失败');
    };
    await act(async () => state.generate());
    assert.equal(state.error, '跨域失败');
    assert.equal(state.count, 1);
    await act(async () => state.close());
    globalThis.exporter = () =>
      new Promise((resolve) => {
        resolveJob = resolve;
      });
    await act(async () => {
      pending = state.generate();
    });
    await act(async () => state.cancel());
    await act(async () => {
      resolveJob({ url: 'blob:late', blob: {} });
      await pending;
    });
    assert.equal(state.open, false);
    assert.equal(state.image, null);
    assert.equal(globalThis.disposed.at(-1).url, 'blob:late');
  } finally {
    await act(async () => root.unmount());
  }
});

test('share image signs user messages with the nickname, falling back to 你 when it is missing or blank', () => {
  const labels = (props) => [...new JSDOM(renderToStaticMarkup(React.createElement(Template, {
    messages: extractShareMessages(messages, new Set(['a1', 'u1'])), ...props,
  }))).window.document.querySelectorAll('.gor-share-label')].map((node) => node.textContent);
  assert.deepEqual(labels({ userName: '樺' }), ['樺', 'Gor']);
  assert.deepEqual(labels({}), ['你', 'Gor']);
  assert.deepEqual(labels({ userName: '   ' }), ['你', 'Gor']);
  assert.deepEqual(labels({ userName: '<b>x</b>' }), ['<b>x</b>', 'Gor'], '昵称按文本显示，不当作 HTML');
  assert.equal(getUserNickname(), FALLBACK_USER_LABEL, '未登录时分享图署名为「你」');
  assert.equal(FALLBACK_USER_LABEL, '你');
});

test('generating the share image passes the current nickname to the exporter', async () => {
  const root = createRoot(document.getElementById('root'));
  let received;
  globalThis.exporter = async (_messages, _signal, userName) => { received = userName; return { url: 'blob:nick', blob: {} }; };
  try {
    await act(async () => root.render(React.createElement(Harness)));
    await act(async () => state.start());
    await act(async () => state.selection.onToggle('u1'));
    await act(async () => state.generate());
    assert.equal(received, getUserNickname());
  } finally {
    await act(async () => root.unmount());
  }
});

test('successful PNG download exits share mode; cancellation or failure keeps selection for retry', async () => {
  const root = createRoot(document.getElementById('root'));
  globalThis.exporter = async () => ({ url: 'blob:download', blob: {} });
  try {
    await act(async () => root.render(React.createElement(Harness)));
    await act(async () => state.start());
    await act(async () => state.selection.onToggle('u1'));
    await act(async () => state.generate());
    assert.equal(state.selecting, true);
    const onSaved = () => state.completeDownload();
    await act(async () => {
      assert.equal(await saveShareImage(async () => false, { suggestedName: 'Gor-聊天.png', blob: {} }, onSaved), false);
    });
    assert.equal(state.selecting, true);
    assert.equal(state.count, 1);
    await assert.rejects(saveShareImage(async () => { throw new Error('保存失败'); }, { suggestedName: 'Gor-聊天.png', blob: {} }, onSaved), /保存失败/);
    assert.equal(state.selecting, true);
    assert.equal(state.count, 1);
    await act(async () => {
      assert.equal(await saveShareImage(async () => true, { suggestedName: 'Gor-聊天.png', blob: {} }, onSaved), true);
    });
    assert.equal(state.selecting, false);
    assert.equal(state.count, 0);
    assert.equal(state.open, false);
    assert.equal(globalThis.disposed.at(-1).url, 'blob:download');
  } finally {
    await act(async () => root.unmount());
  }
});

test('share is left of Preview, plugin omits Preview, and empty sessions omit share', () => {
  const props = { isVscodePluginMode: false, isEmpty: false, isPC: true, sidebarOpen: false,
    canGoBack: false, title: '会话', hasPreviewWorkerContent: true,
    previewWorkerOpen: true, previewableGeneratedFileCount: 0, hasShareableMessages: true,
    onShare() {}, onBack() {}, onMenuClick() {}, onTogglePreviewWorker() {} };
  const html = renderToStaticMarkup(React.createElement(Header, props));
  assert.ok(html.indexOf('chat-share-button') < html.indexOf('chat-preview-worker-toggle'));
  const plugin = renderToStaticMarkup(React.createElement(Header, {...props, isVscodePluginMode:true}));
  assert.equal(plugin.includes('chat-share-button'),false);
  assert.equal(plugin.includes('chat-preview-worker-toggle'),false);
  const empty = renderToStaticMarkup(React.createElement(Header, {...props, hasShareableMessages:false}));
  assert.equal(empty.includes('chat-share-button'),false);
});
test('native checkbox target and Lucide mark toggle once without bubbling into message actions', async () => {
  const root = createRoot(document.getElementById('root'));
  let outerClicks = 0;
  try {
    await act(async () => root.render(React.createElement('div', {onClick:()=>outerClicks++}, React.createElement(Harness))));
    await act(async () => state.start());
    const inputs = [...document.querySelectorAll('input')];
    for (const input of inputs) {
      assert.equal(input.parentElement.className,'chat-share-checkbox-target');
      const mark = input.nextElementSibling.querySelector('svg');
      assert.equal(mark.getAttribute('width'),'14');
      assert.equal(mark.getAttribute('stroke-width'),'1.8');
    }
    await act(async () => inputs[1].parentElement.click());
    assert.equal(state.count,1); assert.equal(inputs[1].checked,true); assert.equal(outerClicks,0);
    await act(async () => inputs[1].click());
    assert.equal(state.count,0); assert.equal(inputs[1].checked,false); assert.equal(outerClicks,0);
  } finally { await act(async () => root.unmount()); }
});

test('share controls compile with the exact session scrollbar skin and requested colors', async () => {
  const files = ['../src/components/chat/ChatShare.less', '../src/components/Sidebar/Sidebar.less', '../src/components/ChatBox/ChatBox.less'];
  const compiled = await Promise.all(files.map(async path => less.render(await readFile(new URL(path,import.meta.url),'utf8'), {filename:fileURLToPath(new URL(path,import.meta.url))})));
  const styleDom = new JSDOM(`<style>${compiled.map(r=>r.css).join('\n')}</style>`);
  const rules = [...styleDom.window.document.styleSheets[0].cssRules];
  const rule = selector => rules.find(r=>r.selectorText===selector)?.style;
  for (const [pseudo,properties] of [
    ['', ['scrollbar-width','scrollbar-color']],
    ['::-webkit-scrollbar',['width']],
    ['::-webkit-scrollbar-track',['background']],
    ['::-webkit-scrollbar-thumb',['background','border-radius']],
    ['::-webkit-scrollbar-thumb:hover',['background']],
  ]) for (const property of properties) {
    assert.equal(rule('.chat-share-preview-image'+pseudo).getPropertyValue(property),
      rule('.sidebar .sidebar-sessions'+pseudo).getPropertyValue(property));
  }
  const css=compiled[0].css;
  assert.equal(rule('.chat-share-checkbox-target').width,'44px');
  assert.equal(rule('.chat-share-checkbox-target').height,'44px');
  assert.equal(rule('.chat-share-checkbox-visual').width,'23px');
  assert.equal(rule('.chat-share-checkbox-visual::before').background,'var(--preview-toggle-active-bg)');
  assert.equal(rule('.chat-share-cancel').background,'rgb(45, 54, 80)');
  assert.equal(rule('.chat-share-cancel').color,'rgb(197, 204, 223)');
  assert.equal(rule('.chat-share-cancel:hover').background,'rgb(55, 65, 93)');
  assert.equal(rule('.chat-share-toolbar-slot').getPropertyValue('margin-bottom'),'0px');
  assert.equal(rule('.chat-share-toolbar-slot').position,'absolute');
  assert.equal(rule('.chat-share-toolbar-slot').bottom,'calc(100% + 12px)');
  assert.equal(rule('.chat-share-toolbar-slot ~ .chat-scroll-to-bottom').bottom,'calc(100% + 12px + var(--chat-share-toolbar-height, 64px) + 12px)');
  assert.equal(rule('.input-dock').getPropertyValue('--chat-bottom-control-layer'),'5');
  const bottomControlLayer=rule('.chat-scroll-to-bottom').getPropertyValue('z-index');
  assert.equal(bottomControlLayer,'var(--chat-bottom-control-layer, 5)');
  assert.equal(rule('.chat-share-toolbar-slot').getPropertyValue('z-index'),bottomControlLayer);
  assert.equal(rule('.chat-page .input-dock:has(.chat-share-toolbar-slot)').getPropertyValue('z-index'),bottomControlLayer);
  assert.equal(css.includes('.message-list:has(.chat-share-row)'),false);
  assert.equal(css.includes('.messages-container:has(.chat-share-row)'),false);
  assert.ok(css.includes('prefers-reduced-motion'));
  assert.equal(css.includes('chat-share-placeholder'),false);
  assert.equal(rule('.chat-page .messages-container:has(.message-list)').getPropertyValue('scrollbar-gutter'),'stable');
  assert.equal(rule('.chat-page .messages-container:has(.message-list)').getPropertyValue('margin-bottom'),'4px');
  assert.equal(rule('.chat-page .messages-container:has(.message-list)').position,'relative');
  assert.equal(rule('.chat-page .messages-container:has(.message-list)').getPropertyValue('z-index'),'1');
  assert.ok(rule('.chat-page .message-list').getPropertyValue('padding').endsWith(' 4px'));
  const smallScrollRules=rules.find(r=>r.conditionText==='(max-width: 520px)' && [...r.cssRules].some(r=>r.selectorText==='.chat-scroll-to-bottom'));
  assert.equal([...smallScrollRules.cssRules].find(r=>r.selectorText==='.chat-scroll-to-bottom').style.bottom,'calc(100% + 10px)');
  const smallOverlayRules=rules.find(r=>r.conditionText==='(max-width: 520px)' && [...r.cssRules].some(r=>r.selectorText==='.chat-share-toolbar-slot ~ .chat-scroll-to-bottom'));
  assert.equal([...smallOverlayRules.cssRules].find(r=>r.selectorText==='.chat-share-toolbar-slot ~ .chat-scroll-to-bottom').style.bottom,'calc(100% + 12px + var(--chat-share-toolbar-height, 64px) + 10px)');
  assert.equal(rule('.chat-scroll-to-bottom').bottom,'calc(100% + 12px)');
  const mobileLayout=rules.find(r=>r.conditionText==='(max-width: 1023px)' && [...r.cssRules].some(r=>r.selectorText==='.chat-share-row'));
  assert.equal([...mobileLayout.cssRules].find(r=>r.selectorText==='.chat-share-row').style.getPropertyValue('padding-left'),'44px');
  assert.equal([...mobileLayout.cssRules].find(r=>r.selectorText==='.chat-share-checkbox-target').style.left,'0px');
  const mobileRules=rules.filter(r=>r.conditionText?.includes('max-width'));
  for (const [breakpoint,bottom] of [['1023px','4px'],['520px','4px']]) {
    const spacing=mobileRules.flatMap(r=>r.conditionText.includes(breakpoint)?[...r.cssRules]:[]).find(r=>r.selectorText==='.chat-page .message-list');
    assert.ok(spacing.style.getPropertyValue('padding').endsWith(' '+bottom));
  }
  styleDom.window.close();
});


test('overlay toolbar measures only its button anchor and clears it on cancel', async () => {
  const originalRect=HTMLElement.prototype.getBoundingClientRect;
  const originalObserver=globalThis.ResizeObserver;
  let height=55, resize, disconnected=false;
  HTMLElement.prototype.getBoundingClientRect=function(){return {height:this.classList.contains('chat-share-toolbar-slot')?height:0};};
  globalThis.ResizeObserver=class { constructor(callback){resize=callback;} observe(){} disconnect(){disconnected=true;} };
  const Dock=()=>{
    state=useChatShare('dock',messages);
    return React.createElement('div',{id:'chat-root'},React.createElement('div',{className:'input-dock'},
      React.createElement(ChatShareToolbar,{share:state}), React.createElement('div',{className:'input-area'})));
  };
  const root=createRoot(document.getElementById('root'));
  try {
    await act(async()=>root.render(React.createElement(Dock)));
    await act(async()=>state.start());
    const chat=document.getElementById('chat-root');
    const toolbar=chat.querySelector('.chat-share-toolbar-slot');
    assert.equal(toolbar.nextElementSibling.className,'input-area');
    const dock=chat.querySelector('.input-dock');
    assert.equal(dock.style.getPropertyValue('--chat-share-toolbar-height'),'55px');
    height=78; resize();
    assert.equal(dock.style.getPropertyValue('--chat-share-toolbar-height'),'78px');
    assert.equal(chat.style.getPropertyValue('--chat-share-toolbar-height'),'');
    await act(async()=>state.selection.onToggle('u1'));
    assert.equal(chat.querySelector('.chat-share-toolbar-slot'),toolbar);
    await act(async()=>state.cancel());
    assert.equal(chat.style.getPropertyValue('--chat-share-toolbar-height'),'');
    assert.equal(chat.querySelector('.chat-share-toolbar-slot'),null);
    assert.equal(dock.style.getPropertyValue('--chat-share-toolbar-height'),'');
    assert.equal(disconnected,true);
  } finally {
    await act(async()=>root.unmount());
    HTMLElement.prototype.getBoundingClientRect=originalRect;
    globalThis.ResizeObserver=originalObserver;
  }
});

test('标题栏左侧：有上一页才显示返回；第二个按钮始终是打开会话列表（App 内同样）', () => {
  const props = { isVscodePluginMode: false, isEmpty: false, isPC: false, sidebarOpen: false,
    canGoBack: true, title: '你好', hasPreviewWorkerContent: false,
    previewWorkerOpen: false, previewableGeneratedFileCount: 0, hasShareableMessages: false,
    onShare() {}, onBack() {}, onMenuClick() {}, onTogglePreviewWorker() {} };
  const withBack = renderToStaticMarkup(React.createElement(Header, props));
  assert.match(withBack, /aria-label="返回上一页"/);
  assert.match(withBack, /aria-label="打开会话列表"/);
  assert.match(withBack, /lucide-menu/, '有消息的会话里第二个按钮是菜单图标，不是返回箭头');
  assert.doesNotMatch(withBack, /lucide-chevron-left/);
  const noBack = renderToStaticMarkup(React.createElement(Header, { ...props, canGoBack: false }));
  assert.doesNotMatch(noBack, /返回上一页/, '没有上一页时不显示返回按钮');
  assert.match(noBack, /aria-label="打开会话列表"/);
});
