import * as vscode from 'vscode';
import { EditableWorkspaceDocument, looksLikeBinaryContent, openEditableWorkspaceDocument } from './files';
import { WorkspaceRequestError } from './paths';

const MAX_PATCHES = 100;
const MAX_WRITE_CONTENT_CHARS = 1_000_000;
const MAX_DIFF_CHARS = 24_000;

type PatchInput = {
  path: unknown;
  oldText: unknown;
  newText: unknown;
  expectedFileVersion?: unknown;
  root?: unknown;
};

type ResolvedPatch = {
  file: EditableWorkspaceDocument;
  start: number;
  end: number;
  startLine: number;
  endLineExclusive: number;
  oldText: string;
  newText: string;
};

type PreparedFile = {
  file: EditableWorkspaceDocument;
  version: number;
  patches: ResolvedPatch[];
};

const documentVersions = new WeakMap<vscode.TextDocument, number>();

/** Called by the VS Code document-change listener; source text is never sent or logged. */
export function rememberTextDocumentVersion(document: vscode.TextDocument): void {
  documentVersions.set(document, document.version);
}

function currentFileVersion(document: vscode.TextDocument): number {
  const remembered = documentVersions.get(document);
  return remembered === undefined ? document.version : Math.max(document.version, remembered);
}

function expectedVersion(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new WorkspaceRequestError('WORKSPACE_REQUEST_FAILED', 'expectedFileVersion 必须是非负整数。');
  }
  return value as number;
}

function requireVersion(document: vscode.TextDocument, expected: number | undefined, path: string): number {
  const actual = currentFileVersion(document);
  if (expected !== undefined && actual !== expected) {
    throw new WorkspaceRequestError('VERSION_CONFLICT', `文件版本已变化，请重新读取后再修改：${path}`);
  }
  return actual;
}

function exactMatch(content: string, oldText: string, path: string): number {
  if (!oldText) {
    throw new WorkspaceRequestError('WORKSPACE_REQUEST_FAILED', 'oldText 不能为空。');
  }
  let count = 0;
  let match = -1;
  let cursor = 0;
  while (cursor <= content.length - oldText.length) {
    const found = content.indexOf(oldText, cursor);
    if (found < 0) break;
    count += 1;
    match = found;
    cursor = found + oldText.length;
    if (count > 1) break;
  }
  if (count === 0) {
    throw new WorkspaceRequestError('PATCH_TARGET_NOT_FOUND', `在文件中找不到需要精确替换的文本：${path}`);
  }
  if (count > 1) {
    throw new WorkspaceRequestError('PATCH_TARGET_NOT_UNIQUE', `待替换文本在文件中出现多次，请提供更具体的上下文：${path}`);
  }
  return match;
}

function splitDiffLines(text: string): string[] {
  if (!text) return [];
  const lines = text.split(/\r\n|\n|\r/);
  if (/(?:\r\n|\n|\r)$/.test(text)) lines.pop();
  return lines;
}

function offsetAtLineStart(content: string, line: number): number {
  if (line <= 0) return 0;
  const separator = /\r\n|\n|\r/g;
  let offset = 0;
  for (let current = 0; current < line; current += 1) {
    const match = separator.exec(content);
    if (!match) return content.length;
    offset = match.index + match[0].length;
  }
  return offset;
}

function boundedDiff(diff: string): { diff: string; diffTruncated: boolean } {
  if (diff.length <= MAX_DIFF_CHARS) return { diff, diffTruncated: false };
  return {
    diff: `${diff.slice(0, MAX_DIFF_CHARS)}\n... diff truncated ...`,
    diffTruncated: true,
  };
}

function fileHeader(path: string): string {
  const relative = path.replace(/^\//, '');
  return `--- a/${relative}\n+++ b/${relative}\n`;
}

function fragmentUnifiedDiff(path: string, patches: ResolvedPatch[]): { diff: string; diffTruncated: boolean } {
  const ordered = [...patches].sort((left, right) => left.start - right.start);
  let lineDelta = 0;
  const hunks: string[] = [];
  const groups: Array<{ startLine: number; endLineExclusive: number; patches: ResolvedPatch[] }> = [];
  for (const patch of ordered.filter((item) => item.oldText !== item.newText)) {
    const previous = groups[groups.length - 1];
    if (previous && patch.startLine <= previous.endLineExclusive) {
      previous.endLineExclusive = Math.max(previous.endLineExclusive, patch.endLineExclusive);
      previous.patches.push(patch);
    } else {
      groups.push({ startLine: patch.startLine, endLineExclusive: patch.endLineExclusive, patches: [patch] });
    }
  }
  for (const group of groups) {
    const originalContent = group.patches[0].file.content;
    const startOffset = offsetAtLineStart(originalContent, group.startLine);
    const endOffset = offsetAtLineStart(originalContent, group.endLineExclusive);
    const originalSegment = originalContent.slice(startOffset, endOffset);
    let replacementSegment = originalSegment;
    for (const patch of [...group.patches].sort((left, right) => right.start - left.start)) {
      const start = patch.start - startOffset;
      const end = patch.end - startOffset;
      replacementSegment = replacementSegment.slice(0, start) + patch.newText + replacementSegment.slice(end);
    }
    const oldLines = splitDiffLines(originalSegment);
    const newLines = splitDiffLines(replacementSegment);
    const oldStart = group.startLine + 1;
    const newStart = Math.max(1, oldStart + lineDelta);
    const oldCount = oldLines.length;
    const newCount = newLines.length;
    hunks.push(
      `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@\n`
      + oldLines.map((line) => `-${line}\n`).join('')
      + newLines.map((line) => `+${line}\n`).join(''),
    );
    lineDelta += newCount - oldCount;
  }
  return boundedDiff(fileHeader(path) + hunks.join(''));
}

function wholeFileUnifiedDiff(path: string, before: string, after: string): { diff: string; diffTruncated: boolean } {
  const oldLines = splitDiffLines(before);
  const newLines = splitDiffLines(after);
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < oldLines.length - prefix
    && suffix < newLines.length - prefix
    && oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) suffix += 1;

  const hasBeforeContext = prefix > 0;
  const hasAfterContext = suffix > 0;
  const contextStart = hasBeforeContext ? prefix - 1 : prefix;
  const oldMiddle = oldLines.slice(prefix, oldLines.length - suffix);
  const newMiddle = newLines.slice(prefix, newLines.length - suffix);
  const oldChunkCount = Number(hasBeforeContext) + oldMiddle.length + Number(hasAfterContext);
  const newChunkCount = Number(hasBeforeContext) + newMiddle.length + Number(hasAfterContext);
  const beforeContext = hasBeforeContext ? ` ${oldLines[prefix - 1]}\n` : '';
  const afterContext = hasAfterContext ? ` ${oldLines[oldLines.length - suffix]}\n` : '';
  const hunk = `@@ -${contextStart + 1},${oldChunkCount} +${contextStart + 1},${newChunkCount} @@\n`
    + beforeContext
    + oldMiddle.map((line) => `-${line}\n`).join('')
    + newMiddle.map((line) => `+${line}\n`).join('')
    + afterContext;
  return boundedDiff(fileHeader(path) + hunk);
}

function validatePatch(value: unknown): PatchInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new WorkspaceRequestError('WORKSPACE_REQUEST_FAILED', 'patch 必须是对象。');
  }
  const patch = value as Record<string, unknown>;
  if (typeof patch.oldText !== 'string' || typeof patch.newText !== 'string') {
    throw new WorkspaceRequestError('WORKSPACE_REQUEST_FAILED', 'patch 必须包含字符串 oldText 和 newText。');
  }
  if (looksLikeBinaryContent(patch.newText)) {
    throw new WorkspaceRequestError('UNSUPPORTED_FILE_TYPE', 'patch 内容包含二进制数据。');
  }
  return {
    path: patch.path,
    oldText: patch.oldText,
    newText: patch.newText,
    expectedFileVersion: patch.expectedFileVersion ?? patch.expectedVersion,
    root: patch.root,
  };
}

function ensureNoOverlaps(prepared: PreparedFile): void {
  const ordered = [...prepared.patches].sort((left, right) => left.start - right.start || left.end - right.end);
  for (let index = 1; index < ordered.length; index += 1) {
    if (ordered[index].start < ordered[index - 1].end) {
      throw new WorkspaceRequestError('PATCH_OVERLAP_CONFLICT', `同一文件中的 patch 范围重叠：${prepared.file.path}`);
    }
  }
}

async function applyEdit(edit: vscode.WorkspaceEdit): Promise<void> {
  try {
    if (!await vscode.workspace.applyEdit(edit)) {
      throw new WorkspaceRequestError('WORKSPACE_EDIT_FAILED', 'VS Code 未能应用本次工作区修改。');
    }
  } catch (error) {
    if (error instanceof WorkspaceRequestError) throw error;
    throw new WorkspaceRequestError('WORKSPACE_EDIT_FAILED', 'VS Code 未能应用本次工作区修改。');
  }
}

export async function patchProjectFile(params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const patch: PatchInput = {
    path: params.path,
    oldText: params.oldText,
    newText: params.newText,
    expectedFileVersion: params.expectedFileVersion ?? params.expectedVersion,
    root: params.root,
  };
  const result = await applyProjectPatches({ patches: [patch], root: params.root });
  const changedFile = (result.changedFiles as Array<Record<string, unknown>>)[0];
  return {
    success: true,
    path: changedFile?.path ?? params.path,
    changed: result.changed,
    diff: changedFile?.diff ?? '',
    fileVersion: (result.fileVersions as Record<string, number> | undefined)?.[String(changedFile?.path ?? params.path)],
    ...(changedFile?.diffTruncated ? { diffTruncated: true } : {}),
  };
}

export async function applyProjectPatches(params: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (!Array.isArray(params.patches) || params.patches.length < 1 || params.patches.length > MAX_PATCHES) {
    throw new WorkspaceRequestError('WORKSPACE_REQUEST_FAILED', `patches 必须包含 1–${MAX_PATCHES} 项。`);
  }
  const inputs = params.patches.map(validatePatch);
  const preparedByUri = new Map<string, PreparedFile>();

  // Open every requested document first. No edits are queued until all files and
  // all exact-text/version checks have succeeded.
  const opens = new Map<string, Promise<EditableWorkspaceDocument>>();
  const opened = await Promise.all(inputs.map(async (input) => {
    const requestedRoot = input.root ?? params.root;
    const key = `${String(requestedRoot ?? '')}\0${String(input.path ?? '')}`;
    let pending = opens.get(key);
    if (!pending) {
      pending = openEditableWorkspaceDocument(input.path, requestedRoot);
      opens.set(key, pending);
    }
    const file = await pending;
    return { input, file };
  }));
  for (const { input, file } of opened) {
    const key = file.uri.toString();
    let prepared = preparedByUri.get(key);
    if (!prepared) {
      prepared = {
        file,
        version: file.fileVersion,
        patches: [],
      };
      if (file.document.version !== file.fileVersion) {
        throw new WorkspaceRequestError('VERSION_CONFLICT', `文件在读取期间发生变化，请重新读取后再修改：${file.path}`);
      }
      preparedByUri.set(key, prepared);
    }
    const expected = expectedVersion(input.expectedFileVersion);
    requireVersion(file.document, expected, file.path);
    if (file.document.version !== prepared.version) {
      throw new WorkspaceRequestError('VERSION_CONFLICT', `文件在本次请求中发生变化，请重新读取后再修改：${file.path}`);
    }
    const oldText = input.oldText as string;
    const newText = input.newText as string;
    const start = exactMatch(prepared.file.content, oldText, file.path);
    prepared.patches.push({
      file: prepared.file,
      start,
      end: start + oldText.length,
      startLine: file.document.positionAt(start).line,
      endLineExclusive: (() => {
        const end = file.document.positionAt(start + oldText.length);
        return Math.max(file.document.positionAt(start).line + 1, end.character === 0 ? end.line : end.line + 1);
      })(),
      oldText,
      newText,
    });
  }

  for (const prepared of preparedByUri.values()) ensureNoOverlaps(prepared);

  // Recheck immediately before committing. A single WorkspaceEdit is used for
  // the entire batch, preserving VS Code's undo and dirty-document behavior.
  for (const prepared of preparedByUri.values()) {
    if (currentFileVersion(prepared.file.document) !== prepared.version) {
      throw new WorkspaceRequestError('VERSION_CONFLICT', `文件在提交前发生变化，请重新读取后再修改：${prepared.file.path}`);
    }
  }

  const edit = new vscode.WorkspaceEdit();
  let patchCount = 0;
  for (const prepared of preparedByUri.values()) {
    for (const patch of prepared.patches) {
      if (patch.oldText === patch.newText) continue;
      const range = new vscode.Range(
        prepared.file.document.positionAt(patch.start),
        prepared.file.document.positionAt(patch.end),
      );
      edit.replace(prepared.file.uri, range, patch.newText);
      patchCount += 1;
    }
  }

  if (patchCount > 0) await applyEdit(edit);

  const changedFiles: Array<Record<string, unknown>> = [];
  const fileVersions: Record<string, number> = {};
  for (const prepared of preparedByUri.values()) {
    const changedPatches = prepared.patches.filter((patch) => patch.oldText !== patch.newText);
    const afterDocument = vscode.workspace.textDocuments.find((doc) => doc.uri.toString() === prepared.file.uri.toString());
    const version = afterDocument ? currentFileVersion(afterDocument) : prepared.version;
    fileVersions[prepared.file.path] = version;
    if (changedPatches.length) {
      changedFiles.push({
        path: prepared.file.path,
        ...fragmentUnifiedDiff(prepared.file.path, changedPatches),
      });
    }
  }
  return {
    success: true,
    changed: patchCount > 0,
    changedFiles,
    patchCount: inputs.length,
    fileVersions,
  };
}

export async function writeProjectFile(params: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (typeof params.content !== 'string') {
    throw new WorkspaceRequestError('WORKSPACE_REQUEST_FAILED', 'content 必须是字符串。');
  }
  if (params.content.length > MAX_WRITE_CONTENT_CHARS) {
    throw new WorkspaceRequestError('FILE_TOO_LARGE', '新内容超过安全写入限制。');
  }
  if (looksLikeBinaryContent(params.content)) {
    throw new WorkspaceRequestError('UNSUPPORTED_FILE_TYPE', 'write 内容包含二进制数据。');
  }
  const file = await openEditableWorkspaceDocument(params.path, params.root);
  const expected = expectedVersion(params.expectedFileVersion ?? params.expectedVersion);
  const version = requireVersion(file.document, expected, file.path);
  if (file.content === params.content) {
    return { success: true, path: file.path, changed: false, diff: '', fileVersion: version };
  }
  const range = new vscode.Range(file.document.positionAt(0), file.document.positionAt(file.content.length));
  const edit = new vscode.WorkspaceEdit();
  edit.replace(file.uri, range, params.content);
  await applyEdit(edit);
  const afterDocument = vscode.workspace.textDocuments.find((doc) => doc.uri.toString() === file.uri.toString());
  const diff = wholeFileUnifiedDiff(file.path, file.content, params.content);
  return {
    success: true,
    path: file.path,
    changed: true,
    diff: diff.diff,
    ...(diff.diffTruncated ? { diffTruncated: true } : {}),
    fileVersion: afterDocument ? currentFileVersion(afterDocument) : version,
  };
}
