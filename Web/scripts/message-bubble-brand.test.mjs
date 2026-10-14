import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const componentPath = fileURLToPath(new URL('../src/components/ChatBox/MessageBubble.tsx', import.meta.url));
const componentSource = await readFile(componentPath, 'utf8');

test('every assistant bubble keeps the Gor brand and omits the transient intro line', () => {
  assert.match(componentSource, /\{!isUser\s*&&\s*\(\s*<div className="assistant-stream-brand">/);
  assert.match(componentSource, /className="assistant-stream-brand-mark"/);
  assert.match(componentSource, /<strong>Gor<\/strong>/);
  assert.match(componentSource, /const logoGradientId = useId\(\)/);
  assert.match(componentSource, /id=\{logoGradientId\}/);
  assert.doesNotMatch(componentSource, /streamIntro|assistant-stream-intro|好的，我先处理你的请求/);
  assert.match(componentSource, /<ThinkingPanel/);
  assert.match(componentSource, /assistant-loading-label/);
});

test('project action subtitles preserve exactly two spaces without punctuation', async () => {
  assert.match(componentSource, /\{'推窗见新景 {2}笔墨生诗意'\}/);
  assert.match(componentSource, /\{'展卷寻其源 {2}墨韵见初心'\}/);
  const stylesheet = await readFile(new URL('../src/components/ChatBox/ChatBox.less', import.meta.url), 'utf8');
  const rule = stylesheet.match(/\.project-action-description\s*\{([^}]+)\}/)[1];
  assert.match(rule, /white-space:\s*pre\s*;/);
  assert.match(rule, /overflow:\s*hidden\s*;/);
  assert.match(rule, /text-overflow:\s*ellipsis\s*;/);
});
