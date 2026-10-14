import assert from 'node:assert/strict';
import test from 'node:test';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Module, { createRequire } from 'node:module';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

// Exercise the real host selection + Worker tab gating. Mock only host I/O,
// unrelated chat presentation, and the compiler/runtime child surface.
const sources = {
  chat: `import React from 'react';
    export { default as PreviewWorker } from '../src/components/ChatBox/PreviewWorker.tsx';
    export function ChatBox(p) { globalThis.chatProps = p; return null; }
    export function ChatPageLayout(p) { return React.createElement('main', null, p.header, p.children); }
    export { default as ChatHeader } from '../src/components/ChatLayout/ChatHeader.tsx';
    export const ChatSidebarLayer = () => null,
      SessionCacheLoader = () => null, WebPreview = () => null;`,
  useChat: `export function useChat() { return globalThis.chatFixture; }`,
  useLayout: `export function useLayout() { return {isPC:true,sidebarOpen:true}; }`,
  useTheme: `export function useTheme() { return {theme:'dark'}; }`,
  feedback: `export function useFeedback() { return {notify:globalThis.noop}; }`,
  GorBrandLogo: `export default function GorBrandLogo() { return null; }`,
  sessionPreviewStorage: `export const getSessionPreview=async()=>null,
    getSessionPreviewArtifact=async()=>null, saveSessionPreview=async()=>{}, saveSessionPreviewUi=async()=>{};`,
  previewProject: `export const getSessionPreviewProject=async()=>globalThis.serverFixture,
    saveSessionPreviewProject=async()=>({revision:1});`,
  PreviewProject: `import React from 'react';
    export default function PreviewProject(p) {
      globalThis.sourceProps=p;
      return React.createElement('pre', {'data-source':p.view}, p.projectSnapshot?.files['/src/App.jsx'] ?? 'current');
    }`,
};
const filename = fileURLToPath(new URL('./preview-message.fixture.cjs', import.meta.url));
const compiled = await build({
  entryPoints: [fileURLToPath(new URL('../src/pages/chat/ChatPage.tsx', import.meta.url))],
  bundle:true, platform:'node', format:'cjs', write:false, packages:'external',
  define:{'import.meta.env':'{"BASE_URL":"/"}'},
  plugins:[{name:'host-fixtures',setup(b){
    b.onResolve({filter:/./},args=>{
      if (/\.(less|css)$/.test(args.path)) return {path:'styles',namespace:'fixture'};
      const key = args.path.endsWith('/components/chat') ? 'chat' : args.path.endsWith('/api/chat') ? 'unused-api' : args.path.split('/').pop().replace(/\.tsx?$/, '');
      if (key in sources) return {path:key,namespace:'fixture'};
    });
    b.onLoad({filter:/.*/,namespace:'fixture'},args=>({contents:sources[args.path] ?? '',loader:'js',resolveDir:dirname(filename)}));
  }}],
});
const fixture = new Module(filename);
fixture.filename=filename; fixture.paths=Module._nodeModulePaths(dirname(filename)); fixture.require=createRequire(filename);
fixture._compile(compiled.outputFiles[0].text,filename);
const ChatPage=fixture.exports.default;
const dom=new JSDOM('<html><body><div id="root"></div></body></html>',{url:'http://localhost/'});
for (const name of ['window','document','HTMLElement','Element','Node','MutationObserver','Event','CustomEvent']) globalThis[name]=name==='window'?dom.window:name==='document'?dom.window.document:dom.window[name];
globalThis.getComputedStyle=dom.window.getComputedStyle.bind(dom.window);
globalThis.IS_REACT_ACT_ENVIRONMENT=true;
globalThis.noop=()=>{};
const snapshot=(id,messageId,text)=>({id,messageId,name:'Demo',template:'react',revision:2,files:{
  '/index.html':'<html><body><div id="root"></div><script type="module" src="/src/main.jsx"></script></body></html>',
  '/src/main.jsx':'import App from "./App.jsx";',
  '/src/App.jsx':text,
}});
const older=snapshot('p','old','OLD MESSAGE SOURCE');
const newer=snapshot('p','new','NEW MESSAGE SOURCE');
const other=snapshot('other','other-message','OTHER PROJECT SOURCE');
globalThis.chatFixture={sessions:[],sessionId:'session',isSessionReady:true,isSessionCacheLoading:false,
  messages:[older,newer,other].map(s=>({id:s.messageId,role:'assistant',content:'',previewSnapshot:s})),
  projectChanges:[],projectRevision:0,previewRevision:0,pendingImages:[],pendingUploadAttachments:[],
  isLoading:false,input:'',initApp:globalThis.noop};
globalThis.serverFixture={project:{id:'p',name:'Demo',template:'react',files:newer.files,revision:2},revision:2,origin:'generated'};

test('Web message sources survive current-project filtering and sidebar deduplication',async()=>{
  const root=createRoot(document.getElementById('root'));
  try {
    await act(async()=>root.render(React.createElement(ChatPage)));
    for (const selected of [older,newer,other,older]) {
      await act(async()=>globalThis.chatProps.onPreviewProject(undefined,'preview','/src/App.jsx',selected));
      assert.ok(document.querySelector('[role="tab"][data-state="inactive"]'));
      assert.equal(document.querySelector('[data-source="preview"]').textContent,selected.files['/src/App.jsx']);
      const code=[...document.querySelectorAll('[role="tab"]')].find(t=>t.textContent==='Code');
      assert.ok(code,'Code must exist even when selected snapshot is not in sidebar');
      await act(async()=>globalThis.chatProps.onPreviewProject(undefined,'source','/src/App.jsx',selected));
      assert.equal(document.querySelector('[data-source="code"]').textContent,selected.files['/src/App.jsx']);
      assert.equal(globalThis.sourceProps.projectSnapshot.messageId,selected.messageId);
      assert.equal(globalThis.sourceProps.initialSelectedFilePath,'/src/App.jsx');
      assert.equal([...document.querySelectorAll('[role="tab"]')].find(t=>t.textContent==='Code').getAttribute('data-state'),'active');
    }
  } finally { await act(async()=>root.unmount()); }
});

test('VS Code host never mounts Preview Worker or exposes Web source callbacks',async()=>{
  document.documentElement.dataset.gorClientMode='vscode';
  const root=createRoot(document.getElementById('root'));
  try {
    await act(async()=>root.render(React.createElement(ChatPage)));
    assert.equal(globalThis.chatProps.onPreviewProject,undefined);
    assert.equal(document.querySelector('[aria-label="Preview Worker 文件预览"]'),null);
  } finally { await act(async()=>root.unmount()); delete document.documentElement.dataset.gorClientMode; }
});

test('Web share follows messages/history and plugin never exposes share controls',async()=>{
  const original = globalThis.chatFixture;
  for (const mode of ['web','vscode']) {
    document.documentElement.dataset.gorClientMode=mode;
    const root=createRoot(document.getElementById('root'));
    const render=async(messages, extra={})=>{
      globalThis.chatFixture={...original,messages,isSessionReady:true,isSessionCacheLoading:false,...extra};
      await act(async()=>root.render(React.createElement(ChatPage)));
      return document.querySelector('.chat-share-button');
    };
    try {
      assert.equal(await render([]),null);
      for (const message of [
        {role:'user',content:'  '}, {role:'assistant',content:'',isStreaming:true,toolStatus:'准备中'},
        {role:'system',content:'内部状态'},
        {role:'user',content:'',images:[' '],attachments:[{name:' '}]},
        {role:'assistant',content:'',files:[{displayName:' ',downloadUrl:''}]},
      ]) assert.equal(await render([{id:'empty',...message}]),null);
      const messages=[{id:'user',role:'user',content:'你好'}];
      const button=await render(messages);
      if (mode==='vscode') {
        assert.equal(button,null);
        assert.equal(globalThis.chatProps.shareSelection,undefined);
        assert.equal(globalThis.chatProps.shareToolbar,undefined);
        assert.equal(document.querySelector('.chat-share-preview'),null);
        assert.equal(await render([{id:'restored',role:'assistant',content:'历史答复'}],{sessionId:'other'}),null);
        continue;
      }
      assert.ok(button);
      assert.equal(button.getAttribute('title'),'分享聊天');
      assert.equal(button.getAttribute('aria-label'),'分享聊天');
      assert.equal(button.getAttribute('aria-disabled'),null);
      assert.equal(button.disabled,false,'sharing stays keyboard focusable');
      assert.equal(button.getAttribute('type'),'button');
      assert.ok(button.querySelector('.lucide-square-arrow-out-up-right'));
      assert.equal(button.querySelector('svg').getAttribute('width'),'18');
      assert.equal(button.querySelector('svg').getAttribute('stroke-width'),'1.7');
      button.focus(); assert.equal(document.activeElement,button);
      await act(async()=>button.click());
      assert.ok(globalThis.chatProps.shareSelection,'click enters real selection mode');
      assert.equal(await render(messages,{sessionId:'other',isSessionCacheLoading:true}),null);
      assert.equal(await render([],{sessionId:'other'}),null);
      assert.equal(globalThis.chatProps.shareSelection,undefined,'switching sessions clears selection');
      assert.ok(await render([{id:'restored',role:'assistant',content:'历史答复'}],{sessionId:'other'}));
      assert.equal(await render(messages,{isSessionReady:false}),null);
      assert.ok(await render([{id:'image',role:'user',content:'',images:['data:image/png;base64,example']}]));
      for (const attachment of [
        {attachments:[{name:'说明.pdf',url:'/attachment'}]},
        {files:[{displayName:'报告.pdf',downloadUrl:'/file',fileType:'pdf'}]},
        {file:{displayName:'报告.pdf',downloadUrl:'/file',fileType:'pdf'}},
      ]) assert.equal(await render([{id:'attachment',role:'user',content:'',...attachment}]),null,'internal/attachment cards have no formal body');
    } finally {
      await act(async()=>root.unmount());
      globalThis.chatFixture=original;
      delete document.documentElement.dataset.gorClientMode;
    }
  }
});
