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
  assert.match(componentSource, /<ExecutionTimeline/);
  assert.match(componentSource, /assistant-loading-label/);
});
