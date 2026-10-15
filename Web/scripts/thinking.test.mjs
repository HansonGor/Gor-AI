import assert from 'node:assert/strict';
import test from 'node:test';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Module, { createRequire } from 'node:module';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

const filename = fileURLToPath(new URL('./thinking.fixture.cjs', import.meta.url));
const compiled = await build({ stdin: { contents: `
  export { getThinkingIcon } from '../src/utils/thinkingIcons';
  export { default as Panel } from '../src/components/chat/ThinkingPanel';
  export { acceptThinkingEvent, finishThinking, restoreThinking, isToolStatusInThinking } from '../src/utils/thinking';
  export { sendChatMessage } from '../src/api/chat';
  export { default as MessageList } from '../src/components/ChatBox/MessageList';
`, resolveDir: dirname(filename), loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', write: false, packages: 'external', define: { 'import.meta.env': '{}' },
  plugins: [{ name: 'fixture', setup(builder) {
    builder.onResolve({ filter: /\.less$/ }, args => ({ path: args.path, namespace: 'styles' }));
    builder.onLoad({ filter: /.*/, namespace: 'styles' }, () => ({ contents: '', loader: 'js' }));
    builder.onResolve({ filter: /\.\/MessageBubble$/ }, args => ({ path: args.path, namespace: 'bubble' }));
    builder.onLoad({ filter: /.*/, namespace: 'bubble' }, () => ({ contents: 'export default () => null', loader: 'js' }));
  } }],
});
const fixture = new Module(filename);
fixture.filename = filename;
fixture.paths = Module._nodeModulePaths(dirname(filename));
fixture.require = createRequire(filename);
fixture._compile(compiled.outputFiles[0].text, filename);
const { getThinkingIcon, Panel, acceptThinkingEvent, finishThinking, restoreThinking, isToolStatusInThinking, sendChatMessage, MessageList } = fixture.exports;
const dom = new JSDOM('<!doctype html><body><div id="scroll"><div id="root"></div></div></body>');
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.Node = dom.window.Node;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const event = (type, id, content) => ({ type, roundId: String(id), content, title: '核对天气信息', summary: content });

const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 280)); });
const latest = () => document.querySelector('.thinking-latest');
const update = (id, title, summary, source = 'tool', steps = []) => ({type:'thinking_update',roundId:String(id),title,summary,source,steps});

test('five rounds keep card identity, softly fold predecessors and finish automatically', async () => {
  const root = createRoot(document.getElementById('root'));
  let trace;
  try {
    let previous;
    for (let i = 1; i <= 5; i++) {
      trace = acceptThinkingEvent(trace, {type:'thinking_start',roundId:String(i)});
      trace = acceptThinkingEvent(trace, update(i, `读取文件${i}`, `正在读取文件${i}。`, 'tool', ['已检查目录。',`正在读取文件${i}。`]));
      await act(async () => root.render(React.createElement(Panel, {trace})));
      assert.equal(latest().querySelector('button').getAttribute('aria-expanded'), 'true');
      assert.equal(latest().querySelector('.thinking-summary').textContent, `正在读取文件${i}。`);
      assert.equal(latest().querySelector('button').textContent, `读取文件${i}`);
      assert.equal(latest().querySelector('.thinking-fold').getAttribute('aria-hidden'), 'false');
      assert.equal(document.querySelectorAll('.thinking-round-shell.is-open').length, 1);
      if (previous) {
        assert.equal(previous.isConnected, true);
        assert.equal(previous.querySelector('button').getAttribute('aria-expanded'), 'false');
        assert.equal(previous.closest('.thinking-round-shell').getAttribute('aria-hidden'), 'true');
        assert.equal(document.querySelector('.thinking-previous button').getAttribute('aria-expanded'),'false');
      }
      previous = latest();
    }
    await act(async () => latest().querySelector('button').click());
    trace = acceptThinkingEvent(trace, update(5, '读取文件5', '已返回结果。','tool',['已检查目录。','已返回结果。']));
    trace = acceptThinkingEvent(trace, {type:'thinking_end',roundId:'5'});
    await act(async () => root.render(React.createElement(Panel, {trace})));
    assert.equal(latest().querySelector('button').getAttribute('aria-expanded'),'false');
    assert.equal(document.querySelector('.thinking-finished'),null);
    assert.ok(latest().querySelector('.thinking-spinner'));
    trace = finishThinking(trace,'completed');
    await act(async () => root.render(React.createElement(Panel, {trace})));
    assert.equal(document.querySelector('.thinking-running').getAttribute('aria-hidden'),'true');
    assert.ok(document.querySelector('.thinking-running .thinking-rounds')); // exit is retained
    const heading = document.querySelector('.thinking-finished > button');
    assert.equal(heading.textContent,'思考已完成共 5 轮思考');
    assert.equal(heading.getAttribute('aria-expanded'),'false');
    await settle();
    assert.equal(document.querySelector('.thinking-running .thinking-rounds'),null);
    await act(async () => heading.click());
    const rounds = document.querySelectorAll('.thinking-history .thinking-heading');
    assert.equal(rounds.length,5);
    assert.ok([...rounds].every(node => node.getAttribute('aria-expanded') === 'false'));
    await act(async () => rounds[0].click());
    assert.equal(rounds[0].getAttribute('aria-expanded'),'true');
    await act(async () => heading.click());
    assert.equal(document.querySelector('.thinking-terminal-history').getAttribute('aria-hidden'),'true');
    await settle();
    assert.equal(document.querySelector('.thinking-history'),null);
  } finally { await act(async () => root.unmount()); }
});

test('delayed title and summary use no empty subtitle and preserve disclosure on rapid updates', async () => {
  const root = createRoot(document.getElementById('root'));
  let trace = acceptThinkingEvent(undefined,{type:'thinking_start',roundId:'1'});
  try {
    await act(async () => root.render(React.createElement(Panel,{trace})));
    assert.equal(latest().querySelector('strong').textContent,'思考中');
    assert.equal(latest().querySelector('small'),null);
    const heading = latest().querySelector('button');
    await act(async () => heading.click());
    trace = acceptThinkingEvent(trace,update(1,'读取 App.tsx',undefined));
    await act(async () => root.render(React.createElement(Panel,{trace})));
    assert.equal(latest().querySelector('strong').textContent,'读取 App.tsx');
    assert.equal(latest().querySelector('small'),null);
    for (let i=0;i<20;i++) {
      trace = acceptThinkingEvent(trace,update(1,'读取 App.tsx',`正在核对文件，第${i}段信息。`));
      await act(async () => root.render(React.createElement(Panel,{trace})));
      assert.equal(latest().querySelector('button'),heading);
      assert.equal(heading.getAttribute('aria-expanded'),'false');
    }
    assert.equal(latest().querySelector('button small'), null);
    assert.equal(latest().querySelector('.thinking-fold').getAttribute('aria-hidden'), 'true');
    assert.equal(latest().querySelector('.thinking-summary').textContent,'正在核对文件，第19段信息。');
    assert.equal(latest().querySelectorAll('.thinking-summary').length, 1);
    await act(async () => heading.click());
    assert.equal(latest().querySelector('.thinking-fold').getAttribute('aria-hidden'), 'false');
    assert.equal(heading.textContent, '读取 App.tsx');
    const stable = trace;
    assert.equal(acceptThinkingEvent(trace,update(1,'分析计划','计划','model')),stable);
    trace = acceptThinkingEvent(trace,{type:'thinking_start',roundId:'2'});
    assert.equal(acceptThinkingEvent(trace,update(1,'迟到结果','迟到')),trace);
    await act(async () => root.render(React.createElement(Panel,{trace})));
    assert.equal(latest().querySelector('strong').textContent,'思考中');
    assert.equal(latest().querySelector('small'),null);
  } finally { await act(async () => root.unmount()); }
});

test('failed, cancelled and interrupted history preserve confirmed summaries and default closed', async () => {
  for (const [status,title] of [['failed','思考未完成'],['cancelled','思考已取消'],['running','思考已中断']]) {
    const root = createRoot(document.getElementById('root'));
    const trace = restoreThinking({status,rounds:[{id:'1',content:'raw',title:'读取 App.tsx',summary:'读取未成功。',source:'tool',steps:['已检查目录。','读取未成功。'],ended:false}]});
    try {
      await act(async () => root.render(React.createElement(Panel,{trace})));
      const heading = document.querySelector('.thinking-finished > button');
      assert.equal(heading.textContent,`${title}共 1 轮思考`);
      assert.equal(heading.getAttribute('aria-expanded'),'false');
      await act(async () => heading.click());
      const round = document.querySelector('.thinking-history .thinking-card');
      assert.equal(round.querySelector('.thinking-summary').textContent,'读取未成功。');
      assert.equal(round.querySelector('button').getAttribute('aria-expanded'),'false');
      await act(async () => round.querySelector('button').click());
      assert.equal(round.querySelector('.thinking-fold').getAttribute('aria-hidden'),'false');
      assert.equal(document.querySelector('.thinking-spinner'),null);
    } finally { await act(async () => root.unmount()); }
  }
});

test('existing SSE transports thoughts independently of tools, changes and final done in both hosts', async () => {
  for (const mode of ['web', 'vscode']) {
    document.documentElement.dataset.gorClientMode = mode;
    let trace;
    const tools = [], changes = [];
    const frames = [];
    for (let i = 1; i <= 5; i++) frames.push(event('thinking_start', i), event('thinking_delta', i, `内容${i}`), event('thinking_end', i), update(i, '读取 App.tsx', '文件已返回结果。', 'tool'));
    frames.push({ type: 'tool_start', name: 'read_project_file', args: '{}' },
      { type: 'project_file_changed', path: '/file.ts', diff: 'diff', workspaceId: 'workspace' }, { type: 'done' });
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join(''));
    try {
      await sendChatMessage({ sessionId: 's', message: '请求' }, {
        onThinking: event => { trace = acceptThinkingEvent(trace, event); assert.equal(trace.status, 'running'); },
        onToolStart: name => tools.push(name), onProjectFileChanged: change => changes.push(change),
        onDone: status => { trace = finishThinking(trace, status); },
      });
      assert.equal(trace.status, 'completed');
      assert.equal(trace.rounds.length, 5);
      assert.equal(trace.rounds[4].source, 'tool');
      assert.deepEqual(tools, ['read_project_file']);
      assert.equal(changes.length, 1);
    } finally { globalThis.fetch = previousFetch; }
  }
});

test('SSE error or missing done never reports successful thinking completion', async () => {
  for (const tail of [[], [{ type: 'error', message: '执行失败' }]]) {
    let trace, done = false;
    const frames = [event('thinking_start', 1), event('thinking_delta', 1, '保留'), event('thinking_end', 1), ...tail];
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join(''));
    try {
      await assert.rejects(sendChatMessage({ sessionId: 's', message: '请求' }, {
        onThinking: event => { trace = acceptThinkingEvent(trace, event); },
        onError: () => { trace = finishThinking(trace, 'failed'); }, onDone: () => { done = true; },
      }));
      assert.equal(done, false);
      assert.equal(trace.status, 'failed');
      assert.equal(trace.rounds[0].content, '保留');
    } finally { globalThis.fetch = previousFetch; }
  }
});

test('thinking-only streaming updates do not scroll the message container', async () => {
  const root = createRoot(document.getElementById('root'));
  const container = document.getElementById('scroll');
  let writes = 0, top = 123;
  Object.defineProperty(container, 'scrollTop', { configurable: true, get: () => top, set: value => { top = value; writes++; } });
  const message = { id: '1', role: 'assistant', content: '', isStreaming: true };
  await act(async () => root.render(React.createElement(MessageList, { messages: [message] })));
  const initial = writes;
  let trace = acceptThinkingEvent(undefined, event('thinking_start', 1));
  for (let i = 0; i < 3; i++) {
    trace = acceptThinkingEvent(trace, event('thinking_delta', 1, '增量'));
    await act(async () => root.render(React.createElement(MessageList, { messages: [{ ...message, thinkingTrace: trace }] })));
  }
  assert.equal(writes, initial);
  trace = acceptThinkingEvent(trace, {...update(1,'读取 App.tsx','正在读取文件。'), toolName:'read_project_file',toolRunning:true});
  await act(async () => root.render(React.createElement(MessageList, {messages:[{...message,thinkingTrace:trace,toolStatus:'正在调用 read_project_file...',executionToolName:'read_project_file'}]})));
  assert.equal(writes,initial);
  trace = acceptThinkingEvent(trace,{...update(1,'读取 App.tsx','工具已返回结果。'),toolName:'read_project_file',toolRunning:false});
  await act(async () => root.render(React.createElement(MessageList, {messages:[{...message,thinkingTrace:trace,toolStatus:'正在调用 read_project_file...',executionToolName:'read_project_file'}]})));
  assert.equal(writes,initial);
  await act(async () => root.unmount());
});

 test('empty and legacy raw reasoning have no placeholder or content body', async () => {
  for (const content of ['', 'Raw English reasoning']) {
    const root = createRoot(document.getElementById('root'));
    const trace = {status:'running', rounds:[{id:'1',content,ended:false,title:'核对天气信息'}]};
    await act(async () => root.render(React.createElement(Panel, {trace})));
    await act(async () => document.querySelector('.thinking-latest button').click());
    assert.equal(document.querySelector('.thinking-content'), null);
    assert.equal(document.querySelector('small'), null);
    assert.ok(!document.body.textContent.includes('第 1 轮'));
    await act(async () => root.unmount());
  }
 });

test('terminal fields cannot override real tool presentation or resurrect completed runs', () => {
  let trace = acceptThinkingEvent(undefined,{type:'thinking_start',roundId:'1'});
  trace = acceptThinkingEvent(trace,update(1,'读取 App.tsx','已返回失败结果。'));
  trace = acceptThinkingEvent(trace,{type:'thinking_end',roundId:'1',title:'准备读取',summary:'计划',source:'model'});
  assert.equal(trace.rounds[0].title,'读取 App.tsx');
  assert.equal(trace.rounds[0].summary,'已返回失败结果。');
  trace = finishThinking(trace,'cancelled');
  assert.equal(acceptThinkingEvent(trace,update(1,'成功','成功')),trace);
});

 test('animation and reduced-motion rules compile without a runtime animation dependency', async () => {
   const {readFile} = await import('node:fs/promises');
   const less = await import('less');
   const text = await readFile(new URL('../src/components/chat/ThinkingPanel.less', import.meta.url),'utf8');
   const {css} = await less.default.render(text);
   assert.match(css,/grid-template-rows 250ms ease-out/);
   assert.match(css,/opacity 250ms ease-out/);
   assert.match(css,/prefers-reduced-motion: reduce/);
   assert.match(css,/animation: none !important/);
   assert.match(css,/transition: none !important/);
   assert.match(css,/overflow-anchor: none/);
 });

 test('only the matching active tool status is deduplicated; independent polling stays visible', () => {
   let trace = acceptThinkingEvent(undefined,{type:'thinking_start',roundId:'1'});
   trace = acceptThinkingEvent(trace,{...update(1,'读取 App.tsx','正在读取文件。'),toolName:'read_project_file',toolRunning:true});
   assert.equal(isToolStatusInThinking({thinkingTrace:trace,executionToolName:'read_project_file'}),true);
   assert.equal(isToolStatusInThinking({thinkingTrace:trace,executionToolName:'video_tool'}),false);
   trace = acceptThinkingEvent(trace,{...update(1,'读取 App.tsx','已返回结果。'),toolName:'read_project_file',toolRunning:false});
   assert.equal(isToolStatusInThinking({thinkingTrace:trace,executionToolName:'read_project_file'}),false);
   trace = finishThinking(trace,'completed');
   assert.equal(isToolStatusInThinking({thinkingTrace:trace,executionToolName:'read_project_file'}),false);
 });

 test('central icon mapping covers all task kinds and real tools outrank titles', () => {
   const cases = [
     ['分析需求','PencilLine'], ['整理答复','PencilLine'], ['理解上下文','PencilLine'], ['搜索资料','Search'], ['读取 App.tsx','FileSearch'],
     ['检查项目文件结构','FolderSearch'], ['制定方案','ListTodo'], ['制定修改方案','ListTodo'], ['修改代码','FilePenLine'],
     ['检查依赖','GitBranch'], ['运行命令','Terminal'], ['检查 TypeScript 错误','Bug'],
     ['验证修改结果','ListChecks'], ['构建项目','Hammer'], ['思考中','PencilLine'], ['未知内容','PencilLine'],
   ];
   for (const [title,name] of cases) assert.equal(getThinkingIcon({title}).name,name);
   assert.equal(getThinkingIcon({title:'制定修改方案',toolName:'read_project_file'}).name,'FileSearch');
   assert.equal(getThinkingIcon({title:'检查项目',toolName:'list_project_files'}).name,'FolderSearch');
   assert.equal(getThinkingIcon({title:'思考中',toolName:'read_project_file'}).name,'PencilLine');
   assert.equal(getThinkingIcon({title:'思考中',toolName:'unknown_tool'}).name,'PencilLine');
   assert.equal(getThinkingIcon({title:'思考中',toolName:'constructor'}).name,'PencilLine');
   // 真实 Git 工具与根据其结果命名的最后一轮使用 GitBranch
   for (const toolName of ['git_status','git_commit','git_push']) {
     assert.equal(getThinkingIcon({title:'读取改动差异',toolName}).name,'GitBranch');
   }
   assert.equal(getThinkingIcon({title:'汇总提交结果'}).name,'GitBranch');
   assert.equal(getThinkingIcon({title:'汇总推送结果'}).name,'GitBranch');
   assert.equal(getThinkingIcon({title:'汇总修改结果'}).name,'FilePenLine');
   assert.equal(getThinkingIcon({title:'汇总检索结果'}).name,'Search');
 });

 test('delayed title switches the icon once, summary deltas do not restart it, completion uses a book', async () => {
   const root = createRoot(document.getElementById('root'));
   let trace = acceptThinkingEvent(undefined,{type:'thinking_start',roundId:'1'});
   try {
     await act(async () => root.render(React.createElement(Panel,{trace})));
     assert.ok(latest().querySelector('.thinking-kind-icon .lucide-pencil-line'));
     trace = acceptThinkingEvent(trace,update(1,'整理答复','正在结合已收到的信息组织答复。','phase'));
     await act(async () => root.render(React.createElement(Panel,{trace})));
     assert.ok(latest().querySelector('.thinking-kind-icon .lucide-pencil-line'));
     assert.equal(latest().querySelector('button').textContent,'整理答复');
     assert.equal(latest().querySelector('.thinking-summary').textContent,'正在结合已收到的信息组织答复。');
     trace = acceptThinkingEvent(trace,update(1,'读取 App.tsx','正在读取文件。'));
     await act(async () => root.render(React.createElement(Panel,{trace})));
     const icon = latest().querySelector('.thinking-kind-icon');
     const title = latest().querySelector('strong');
     assert.ok(icon.querySelector('.lucide-file-search'));
     assert.equal(icon.querySelector('svg').getAttribute('stroke-width'),'1.7');
     assert.equal(icon.querySelector('svg').getAttribute('width'),'18');
     for (let i=0;i<5;i++) {
       trace = acceptThinkingEvent(trace,update(1,'读取 App.tsx',`正在读取文件，第${i}段。`));
       await act(async () => root.render(React.createElement(Panel,{trace})));
       assert.equal(latest().querySelector('.thinking-kind-icon'),icon);
       assert.equal(latest().querySelector('strong'),title);
     }
     trace = finishThinking(trace,'completed');
     await act(async () => root.render(React.createElement(Panel,{trace})));
     const book = document.querySelector('.thinking-finished .lucide-book-open-check');
     assert.ok(book);
     assert.equal(book.getAttribute('width'),'20');
     assert.equal(book.getAttribute('stroke-width'),'1.7');
   } finally { await act(async () => root.unmount()); }
 });

 test('failed and cancelled states never use the successful book icon', async () => {
   for (const status of ['failed','cancelled','interrupted']) {
     const root = createRoot(document.getElementById('root'));
     try {
       const trace = {status,rounds:[{id:'1',content:'',title:'读取文件',ended:false}]};
       await act(async () => root.render(React.createElement(Panel,{trace})));
       assert.equal(document.querySelector('.thinking-finished .lucide-book-open-check'),null);
       assert.ok(document.querySelector('.thinking-finished .lucide-brain'));
     } finally { await act(async () => root.unmount()); }
   }
 });
