import { parseDiff } from 'react-diff-view';
import type { ChangeData, HunkData, FileData } from 'react-diff-view';

export type DiffSection =
  | { kind: 'hunk'; key: string; hunk: HunkData }
  | { kind: 'gap'; key: string; count: number; hunk?: HunkData };
export interface PresentedDiff {
  type: FileData['type'];
  additions: number;
  deletions: number;
  sections: DiffSection[];
}

function sliceHunk(hunk: HunkData, start: number, end: number): HunkData {
  const before = hunk.changes.slice(0, start);
  const changes = hunk.changes.slice(start, end);
  const oldStart = hunk.oldStart + before.filter((c) => c.type !== 'insert').length;
  const newStart = hunk.newStart + before.filter((c) => c.type !== 'delete').length;
  const oldLines = changes.filter((c) => c.type !== 'insert').length;
  const newLines = changes.filter((c) => c.type !== 'delete').length;
  return { ...hunk, oldStart, newStart, oldLines, newLines, changes,
    content: `@@ -${oldStart},${oldLines} +${newStart},${newLines} @@` };
}

/** Display-only projection. Never mutate the raw diff or its parsed changes. */
export function presentDiff(raw: string): PresentedDiff | null {
  try {
    // Provider receipts use timestamp-free unidiff headers. The library's
    // generic unidiff normalizer assumes timestamps, so supply a view-only Git
    // envelope and keep the actual ---/+++ headers (including /dev/null).
    if (!raw.startsWith('diff --git ') && !/^--- [^\n]+\r?\n\+\+\+ [^\n]+\r?\n/.test(raw)) return null;
    const input = raw.startsWith('diff --git ') ? raw
      : `diff --git a/file b/file\nindex 1111111..2222222 100644\n${raw}`;
    const files = parseDiff(input);
    if (files.length !== 1 || !files[0].hunks.length) return null;
    const file = { ...files[0], hunks: files[0].hunks.map((hunk) => {
      // gitdiff-parser treats explicit zero counts as 1; restore header counts
      // before validating new/deleted files and zero-context insertions.
      const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(hunk.content);
      return header ? { ...hunk, oldLines: header[2] === undefined ? 1 : Number(header[2]),
        newLines: header[4] === undefined ? 1 : Number(header[4]) } : hunk;
    }) };
    // Incomplete/truncated diffs must remain available verbatim, not look complete.
    if (file.hunks.some((h) =>
      h.oldLines !== h.changes.filter((c) => c.type !== 'insert').length
      || h.newLines !== h.changes.filter((c) => c.type !== 'delete').length)) return null;
    if (/diff (?:已截断|truncated)/i.test(raw)) return null;
    const merged: HunkData[] = [];
    for (const hunk of file.hunks) {
      const last = merged[merged.length - 1];
      if (last && last.oldStart + last.oldLines === hunk.oldStart
        && last.newStart + last.newLines === hunk.newStart) {
        merged[merged.length - 1] = { ...last, oldLines: last.oldLines + hunk.oldLines,
          newLines: last.newLines + hunk.newLines, changes: [...last.changes, ...hunk.changes] };
      } else merged.push({ ...hunk, changes: [...hunk.changes] });
    }
    const sections: DiffSection[] = [];
    let additions = 0;
    let deletions = 0;
    merged.forEach((hunk, hunkIndex) => {
      const previous = merged[hunkIndex - 1];
      if (previous) {
        const oldGap = hunk.oldStart - previous.oldStart - previous.oldLines;
        const newGap = hunk.newStart - previous.newStart - previous.newLines;
        if (oldGap > 0 && oldGap === newGap) {
          sections.push({ kind: 'gap', key: `missing-${hunkIndex}`, count: oldGap });
        }
      }
      const changes = hunk.changes;
      additions += changes.filter((c) => c.type === 'insert').length;
      deletions += changes.filter((c) => c.type === 'delete').length;
      const folded: Array<[number, number]> = [];
      for (let start = 0; start < changes.length;) {
        if (changes[start].type !== 'normal') { start++; continue; }
        let end = start;
        while (end < changes.length && changes[end].type === 'normal') end++;
        if (end - start > 6) {
          // Each change keeps 3 lines. Gaps <= 6 naturally merge nearby changes.
          const from = start + (start > 0 ? 3 : 0);
          const to = end - (end < changes.length ? 3 : 0);
          if (to > from) folded.push([from, to]);
        }
        start = end;
      }
      let cursor = 0;
      folded.forEach(([from, to], index) => {
        if (from > cursor) sections.push({ kind: 'hunk', key: `h-${hunkIndex}-${index}`,
          hunk: sliceHunk(hunk, cursor, from) });
        sections.push({ kind: 'gap', key: `fold-${hunkIndex}-${index}`, count: to - from,
          hunk: sliceHunk(hunk, from, to) });
        cursor = to;
      });
      if (cursor < changes.length) sections.push({ kind: 'hunk', key: `h-${hunkIndex}-end`,
        hunk: sliceHunk(hunk, cursor, changes.length) });
    });
    return { type: file.type, additions, deletions, sections };
  } catch { return null; }
}

export function changeMarker(change: ChangeData): string {
  return change.type === 'insert' ? '+' : change.type === 'delete' ? '−' : '';
}
