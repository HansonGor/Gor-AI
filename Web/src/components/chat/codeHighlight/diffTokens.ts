import type { HunkTokens, TokenNode } from 'react-diff-view';
import type { PresentedDiff } from '../diffPresentation';
import { highlightCode } from './client';
import { codeLanguageFromPath } from './languages';

/** Color only the source supplied by the Diff; do not fetch or invent missing lines. */
export async function highlightDiff(
  model: PresentedDiff | null,
  path: string,
): Promise<HunkTokens | null> {
  const language = codeLanguageFromPath(path);
  if (!model || !language) return null;
  const result: HunkTokens = { old: [], new: [] };
  for (const side of ['old', 'new'] as const) {
    const lines = new Map<number, string>();
    for (const section of model.sections) {
      if (!section.hunk) continue;
      for (const change of section.hunk.changes) {
        if (
          (side === 'old' && change.type === 'insert') ||
          (side === 'new' && change.type === 'delete')
        )
          continue;
        const number =
          change.type === 'normal'
            ? side === 'old'
              ? change.oldLineNumber
              : change.newLineNumber
            : change.lineNumber;
        if (number < 1 || number > 1_000_000) return null;
        lines.set(number, change.content);
      }
    }
    if (lines.size > 2500 || [...lines.values()].join('\n').length > 100_000) return null;
    const groups: [number, string][][] = [];
    for (const line of [...lines].sort((a, b) => a[0] - b[0])) {
      const last = groups[groups.length - 1];
      if (last && last[last.length - 1][0] + 1 === line[0]) last.push(line);
      else groups.push([line]);
    }
    for (const group of groups) {
      const tokens = await highlightCode(group.map(([, text]) => text).join('\n'), language);
      if (!tokens) continue;
      for (const [index, [number, text]] of group.entries()) {
        const line = tokens[index];
        if (!line || line.map((token) => token.content).join('') !== text) continue;
        result[side][number - 1] = line.map(
          (token) => ({ type: 'shiki', value: token.content, color: token.color }) as TokenNode,
        );
      }
    }
  }
  return result;
}
