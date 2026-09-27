import type { ImportedPreviewArchive } from '../preview/core/importArchive';
import type { UploadedAttachment } from '../types';

const READABLE_TEXT_FILE = /\.(?:html?|[cm]?js|jsx|[cm]?ts|tsx|css|json|svg|txt|md|markdown|ya?ml)$/i;
const MAX_CONTEXT_CHARACTERS = 10_000;
const MAX_CONTEXT_FILES = 10;
const MAX_FILE_EXCERPT = 1_800;

export interface UploadSummaryRequest {
  displayText: string;
  prompt: string;
  analysisContext: string;
  attachments: UploadedAttachment[];
}

function shouldSkipPath(path: string): boolean {
  const normalized = path.replace(/\\/g, '/').replace(/^\/+/, '');
  const segments = normalized.split('/').map((segment) => segment.toLowerCase());
  const ignoredDirectories = new Set([
    'node_modules', '.git', '__macosx', 'dist', 'build', 'coverage',
    '.next', '.nuxt', '.output', 'vendor', 'out',
  ]);
  if (segments.some((segment) => ignoredDirectories.has(segment))) return true;

  const name = segments[segments.length - 1] ?? '';
  return /(?:^|\.)(?:package-lock|yarn\.lock|pnpm-lock|bun\.lock|composer\.lock|cargo\.lock)|\.map$|\.min\.(?:js|css)$|\.d\.ts$/i.test(name);
}

function excerpt(content: string, maxCharacters: number): string {
  const normalized = content.replace(/\r\n/g, '\n').trim();
  if (normalized.length <= maxCharacters) return normalized;
  const headLength = Math.floor(maxCharacters * 0.72);
  const tailLength = maxCharacters - headLength;
  return `${normalized.slice(0, headLength)}\n…（中间内容略）…\n${normalized.slice(-tailLength)}`;
}

function priority(path: string): number {
  const normalized = path.toLowerCase().replace(/\\/g, '/');
  if (/(?:^|\/)readme(?:\.[^/]*)?$/.test(normalized)) return 0;
  if (/(?:^|\/)(?:package\.json|manifest\.json|cargo\.toml|pyproject\.toml)$/.test(normalized)) return 1;
  if (/(?:^|\/)index\.html$/.test(normalized)) return 2;
  if (/(?:^|\/)(?:src\/)?(?:app|main|index)\.[cm]?[jt]sx?$/.test(normalized)) return 3;
  if (/\/src\//.test(normalized)) return 4;
  return 5;
}

export function createUploadSummaryRequest(
  imported: ImportedPreviewArchive,
  attachmentName = imported.name,
  attachmentKind?: UploadedAttachment['kind'],
): UploadSummaryRequest {
  const entries = Object.entries(imported.files)
    .filter(([path]) => READABLE_TEXT_FILE.test(path) && !shouldSkipPath(path));
  entries.sort((left, right) => priority(left[0]) - priority(right[0]) || left[0].localeCompare(right[0]));

  let remaining = MAX_CONTEXT_CHARACTERS;
  const excerpts: string[] = [];
  for (const [path, rawContent] of entries) {
    if (remaining <= 0 || excerpts.length >= MAX_CONTEXT_FILES) break;
    const content = typeof rawContent === 'string'
      ? rawContent
      : new TextDecoder('utf-8', { fatal: false }).decode(rawContent);
    if (!content.trim()) continue;
    const text = excerpt(content, Math.min(MAX_FILE_EXCERPT, remaining));
    if (!text) continue;
    // Paths are sent only as private context to disambiguate excerpts. The UI
    // renders displayText, and the model is explicitly told not to repeat them.
    excerpts.push(`[文件 ${path}]\n${text}`);
    remaining -= text.length;
  }

  const fileLabel = imported.name.replace(/\.zip$/i, '').trim() || '上传项目';
  const displayText = `已上传「${fileLabel}」，请简要概述它的主要内容。`;
  const prompt = '请阅读本次上传的项目文本内容，概括这个项目主要是做什么的、包含哪些核心功能。只用简洁自然的中文回答 1-2 句话，不要输出代码、文件名、路径或清单；不要仅根据名称猜测。若可读内容不足以判断，请直接说明。';
  const analysisContext = excerpts.length
    ? `以下是从上传内容中挑选的可读文本摘录，请依据实际内容概括，不要复述文件名或路径：\n\n${excerpts.join('\n\n')}`
    : '此次上传未发现可读取的文本内容。请说明目前无法从文件内容判断项目用途，不要根据文件名推测。';

  return {
    displayText,
    prompt,
    analysisContext,
    attachments: [{
      name: attachmentName,
      kind: attachmentKind ?? (imported.kind === 'dist' || attachmentName.toLowerCase().endsWith('.zip') ? 'archive' : 'folder'),
    }],
  };
}
