import type { Diagnostic, Diagnostics } from './types';

/** 从常见工具输出中提取结构化结果；识别不了就返回 undefined，不猜测。 */

const MAX_ITEMS = 20;

function toInt(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function parseTestSummary(text: string): Diagnostics | undefined {
  // vitest:  Tests  2 failed | 46 passed (48)
  const vitest = text.match(/Tests\s+(?:(\d+)\s+failed\s*\|\s*)?(?:(\d+)\s+passed)?[^\n(]*\((\d+)\)/);
  if (vitest && (vitest[1] || vitest[2])) {
    return { failed: toInt(vitest[1]) ?? 0, passed: toInt(vitest[2]) ?? 0, total: toInt(vitest[3]), items: failedTests(text) };
  }
  // jest:  Tests:       2 failed, 46 passed, 48 total
  const jest = text.match(/Tests:\s+(?:(\d+)\s+failed,\s*)?(?:\d+\s+skipped,\s*)?(?:(\d+)\s+passed,\s*)?(\d+)\s+total/);
  if (jest) {
    return { failed: toInt(jest[1]) ?? 0, passed: toInt(jest[2]) ?? 0, total: toInt(jest[3]), items: failedTests(text) };
  }
  // node --test:  # pass 27 / # fail 0  （新版本为 ℹ pass 27）
  const pass = text.match(/^(?:#|ℹ)\s*pass\s+(\d+)\s*$/m);
  const fail = text.match(/^(?:#|ℹ)\s*fail\s+(\d+)\s*$/m);
  if (pass && fail) {
    const passed = toInt(pass[1]) ?? 0;
    const failed = toInt(fail[1]) ?? 0;
    return { passed, failed, total: passed + failed, items: failedTests(text) };
  }
  return undefined;
}

function failedTests(text: string): Diagnostic[] {
  const items: Diagnostic[] = [];
  const seen = new Set<string>();
  // 失败位置：path/to/file.test.ts:42:7 或 (path/to/file.js:42:7)
  for (const match of text.matchAll(/(?:^|[\s(])((?:[\w@.-]+\/)*[\w@.-]+\.(?:test|spec)\.[cm]?[jt]sx?):(\d+)(?::\d+)?/gm)) {
    const key = `${match[1]}:${match[2]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({ file: match[1], line: toInt(match[2]), severity: 'error', message: '测试失败' });
    if (items.length >= MAX_ITEMS) break;
  }
  return items;
}

export function parseTscOutput(text: string): Diagnostics | undefined {
  const items: Diagnostic[] = [];
  let count = 0;
  for (const match of text.matchAll(/^(.+?)\((\d+),\d+\):\s+(error|warning)\s+TS\d+:\s*(.+)$/gm)) {
    count += 1;
    if (items.length < MAX_ITEMS) {
      items.push({ file: match[1].trim(), line: toInt(match[2]), severity: match[3] as 'error' | 'warning', message: match[4].trim().slice(0, 300) });
    }
  }
  const summary = text.match(/Found (\d+) errors?/);
  if (!count && !summary) return undefined;
  return { failed: toInt(summary?.[1]) ?? count, items };
}

export function parseEslintOutput(text: string): Diagnostics | undefined {
  const summary = text.match(/✖\s+(\d+)\s+problems?\s+\((\d+)\s+errors?,\s+(\d+)\s+warnings?\)/);
  if (!summary) return undefined;
  const items: Diagnostic[] = [];
  let file: string | undefined;
  for (const line of text.split(/\r?\n/)) {
    if (/^\S.*\.[cm]?[jt]sx?$|^\S.*\.vue$/.test(line.trim()) && !line.startsWith(' ')) {
      file = line.trim();
      continue;
    }
    const entry = line.match(/^\s+(\d+):\d+\s+(error|warning)\s+(.+?)(?:\s{2,}\S+)?$/);
    if (entry && items.length < MAX_ITEMS) {
      items.push({ file, line: toInt(entry[1]), severity: entry[2] as 'error' | 'warning', message: entry[3].trim().slice(0, 300) });
    }
  }
  return { failed: toInt(summary[2]) ?? 0, total: toInt(summary[1]), items };
}

/** 先按测试摘要识别，再按 tsc / eslint 识别。 */
export function parseAny(text: string): Diagnostics | undefined {
  return parseTestSummary(text) ?? parseTscOutput(text) ?? parseEslintOutput(text);
}
