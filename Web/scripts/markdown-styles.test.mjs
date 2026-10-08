import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import less from 'less';
import postcss from 'postcss';

const lessPath = fileURLToPath(new URL('../src/components/ChatBox/ChatBox.less', import.meta.url));
const lessSource = await readFile(lessPath, 'utf8');
const { css } = await less.render(lessSource, { filename: lessPath });
const stylesheet = postcss.parse(css);

function declarationsFor(selector) {
  const normalize = (value) => value.replace(/\s+/g, ' ').replace(/\s*,\s*/g, ',');
  const rule = stylesheet.nodes.find(
    (node) =>
      node.type === 'rule' &&
      normalize(node.selector) === normalize(selector),
  );
  assert.ok(rule, `Expected compiled selector: ${selector}`);

  return Object.fromEntries(rule.nodes.filter((node) => node.type === 'decl').map(({ prop, value }) => [prop, value]));
}

test('Markdown text and code typography stay independent of the responsive root rem size', () => {
  assert.equal(declarationsFor('.markdown-body')['font-size'], '14px');
  assert.equal(declarationsFor('.markdown-body code')['font-size'], '0.95em');
  assert.equal(declarationsFor('.markdown-body pre code')['font-size'], '13px');
  assert.equal(declarationsFor('.markdown-body table')['font-size'], '14px');

  stylesheet.walkRules((rule) => {
    if (!rule.selectors?.some((selector) => selector.includes('.markdown-body'))) return;
    rule.walkDecls('font-size', ({ value }) => {
      assert.doesNotMatch(value, /rem/i, `Markdown selector ${rule.selector} must not size text in rem`);
    });
  });
});

test('Markdown tables, links and code blocks remain constrained and can wrap or scroll', () => {
  const table = declarationsFor('.markdown-body table');
  assert.equal(table['max-width'], '100%');
  assert.equal(table['overflow-x'], 'auto');

  const cells = declarationsFor('.markdown-body table th, .markdown-body table td');
  assert.equal(cells['font-size'], 'inherit');
  assert.equal(cells['white-space'], 'normal');
  assert.equal(cells['overflow-wrap'], 'anywhere');

  const link = declarationsFor('.markdown-body a');
  assert.equal(link['background-color'], 'transparent');
  assert.equal(link['overflow-wrap'], 'anywhere');

  const pre = declarationsFor('.markdown-body pre');
  assert.equal(pre['max-width'], '100%');
  assert.equal(pre['overflow-x'], 'auto');
});

test('responsive media rules do not override Markdown typography', () => {
  stylesheet.walkAtRules('media', (media) => {
    media.walkRules((rule) => {
      if (!rule.selectors?.some((selector) => selector.includes('.markdown-body'))) return;
      assert.equal(
        rule.nodes.some((node) => node.type === 'decl' && node.prop === 'font-size'),
        false,
        `Responsive rule ${rule.selector} must not override Markdown font size`,
      );
    });
  });
});

test('token usage and user message typography do not scale with responsive root rem', () => {
  assert.equal(declarationsFor('.token-usage')['font-size'], '12px');
  assert.equal(declarationsFor('.token-usage')['padding-top'], '6px');
  assert.equal(declarationsFor('.token-usage .token-icon')['font-size'], '12px');
  assert.equal(declarationsFor('.chat-page .row-user .message-bubble')['font-size'], '14px');

  stylesheet.walkRules((rule) => {
    if (!rule.selectors?.some((selector) => selector.includes('.token-usage') || selector.includes('.chat-page .row-user .message-bubble'))) return;
    rule.walkDecls('font-size', ({ value }) => {
      assert.doesNotMatch(value, /rem/i, `Chat typography selector ${rule.selector} must not size text in rem`);
    });
  });
});
