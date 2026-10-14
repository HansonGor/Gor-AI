import assert from 'node:assert/strict';
import test from 'node:test';
import { presentDiff } from '../src/components/chat/diffPresentation.ts';

function rawDiff(lines: string[], oldStart = 1, newStart = 1) {
  return `--- a/src/App.jsx\n+++ b/src/App.jsx\n@@ -${oldStart},${lines.filter((l) => !l.startsWith('+')).length} +${newStart},${lines.filter((l) => !l.startsWith('-')).length} @@\n${lines.join('\n')}\n`;
}
const normal = (count: number) => Array.from({ length: count }, (_, i) => ` context ${i}`);

test('keeps 3 context lines on each side, folds only the middle and preserves raw input', () => {
  const raw = rawDiff([...normal(10), '-old', '+new', ...normal(24), '-old2', '+new2', ...normal(10)]);
  const model = presentDiff(raw)!;
  assert.equal(model.additions, 2);
  assert.equal(model.deletions, 2);
  const gaps = model.sections.filter((s) => s.kind === 'gap');
  assert.deepEqual(gaps.map((s) => s.count), [7, 18, 7]);
  const blocks = model.sections.filter((s) => s.kind === 'hunk');
  assert.equal(blocks.length, 2);
  for (const block of blocks) {
    assert.deepEqual(block.hunk.changes.slice(0, 3).map((c) => c.type), ['normal', 'normal', 'normal']);
    assert.deepEqual(block.hunk.changes.slice(-3).map((c) => c.type), ['normal', 'normal', 'normal']);
  }
  assert.equal(model.sections.reduce((sum, s) => sum + (s.kind === 'hunk' ? s.hunk.changes.length : s.hunk?.changes.length ?? 0), 0), 48);
  assert.deepEqual(presentDiff(raw), model);
});

test('6 unchanged lines merge nearby edits; 7 lines fold exactly 1 line', () => {
  for (const count of [0, 1, 6, 7]) {
    const model = presentDiff(rawDiff(['-a', '+b', ...normal(count), '-c', '+d']))!;
    const gaps = model.sections.filter((s) => s.kind === 'gap');
    assert.equal(gaps.length, count > 6 ? 1 : 0);
    if (count > 6) assert.equal(gaps[0].count, 1);
  }
});

test('adjacent hunks merge without separators and retain correct line numbers', () => {
  const raw = rawDiff(['-a', '+b'], 12, 12) + '@@ -13,2 +13,2 @@\n context\n context2\n';
  const model = presentDiff(raw)!;
  assert.equal(model.sections.length, 1);
  const first = model.sections[0];
  assert.equal(first.kind, 'hunk');
  if (first.kind === 'hunk') {
    assert.equal(first.hunk.oldStart, 12);
    assert.equal(first.hunk.newStart, 12);
    assert.equal(first.hunk.oldLines, 3);
    assert.equal(first.hunk.newLines, 3);
  }
});

test('pre-existing missing source is counted but never invented or marked expandable', () => {
  const raw = rawDiff(['-a', '+b'], 12, 12) + '@@ -40,1 +40,1 @@\n-c\n+d\n';
  const gaps = presentDiff(raw)!.sections.filter((s) => s.kind === 'gap');
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0].count, 27);
  assert.equal(gaps[0].hunk, undefined);
});

test('insert/delete only, zero-count ranges and newlines remain renderable', () => {
  const insert = presentDiff('--- /dev/null\n+++ b/new.jsx\n@@ -0,0 +1,2 @@\n+first\n+second\n')!;
  assert.equal(insert.additions, 2);
  assert.equal(insert.deletions, 0);
  const remove = presentDiff('--- a/old.jsx\n+++ /dev/null\n@@ -1,1 +0,0 @@\n-old\n\\ No newline at end of file\n')!;
  assert.equal(remove.deletions, 1);
  assert.equal(remove.additions, 0);
});

test('truncated, malformed and multiple-file data fall back to unchanged raw text', () => {
  for (const raw of ['', 'not a diff', '@@ -1,1 +1,1 @@\n-a\n+b\n',
    '--- a/x\n+++ b/x\n@@ -1,3 +1,3 @@\n-a\n+b\n',
    rawDiff(['-a', '+b']) + '... diff truncated ...']) assert.equal(presentDiff(raw), null);
});
