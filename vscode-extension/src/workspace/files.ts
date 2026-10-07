import * as vscode from 'vscode';
import {
  describeWorkspaceRoots,
  isUriWithinWorkspaceRoot,
  normalizeWorkspaceRelativePath,
  selectWorkspaceRoot,
  toWorkspaceUri,
  workspaceRelativePath,
  WorkspaceRequestError,
} from './paths';

const EXCLUDE_GLOB = '**/{node_modules,.git,dist,build,coverage,out,vendor,.next,.nuxt,.turbo,.cache,.venv,venv,__pycache__}/**';
const MAX_LIST_FILES = 5000;
const MAX_READ_FILE_BYTES = 1_000_000;
const MAX_RANGE_FILE_BYTES = 10_000_000;
const MAX_READ_CHARS = 80_000;
const MAX_READ_RANGE_LINES = 1000;
const MAX_CREATE_FILE_BYTES = 1_000_000;
const DEFAULT_SEARCH_FILES = 200;
const MAX_SEARCH_FILES = 500;
const DEFAULT_SEARCH_RESULTS = 20;
const MAX_SEARCH_RESULTS = 20;
const DEFAULT_SEARCH_TOTAL_CHARS = 1_000_000;
const MAX_SEARCH_TOTAL_CHARS = 1_000_000;
const MAX_SEARCH_FILE_BYTES = 512_000;
const MAX_SNIPPET_CHARS = 1200;
const MAX_TOTAL_SNIPPET_CHARS = 24_000;
const MAX_SEARCH_HIT_LINES_PER_FILE = 100;
const MAX_MATCHES_PER_LINE = 1000;
const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.pdf',
  '.zip', '.7z', '.rar', '.gz', '.exe', '.dll', '.so', '.dylib', '.wasm',
  '.woff', '.woff2', '.ttf', '.otf', '.mp3', '.wav', '.ogg', '.mp4', '.mov',
  '.avi', '.mkv', '.glb', '.bin', '.class', '.jar', '.sqlite', '.db',
]);

type WorkspaceParams = Record<string, unknown>;

function rootLabel(root: vscode.WorkspaceFolder): { id: string; name: string; isMultiRoot: boolean } {
  const folders = vscode.workspace.workspaceFolders ?? [];
  const index = folders.indexOf(root);
  return { id: `root-${index + 1}`, name: root.name, isMultiRoot: folders.length > 1 };
}

function isExcludedOrSensitive(relativePath: string): boolean {
  const segments = relativePath.split('/');
  return segments.some((segment) =>
    /^(?:\.env(?:\..*)?|.*(?:secret|credential|private.?key|id_rsa|id_ed25519).*$|.*\.(?:pem|key))$/i.test(segment)
    || /^(?:node_modules|\.git|dist|build|coverage|out|vendor|\.next|\.nuxt|\.turbo|\.cache|\.venv|venv|__pycache__)$/i.test(segment),
  );
}

function isBinaryPath(relativePath: string): boolean {
  const basename = relativePath.split('/').pop() ?? '';
  const dot = basename.lastIndexOf('.');
  return dot >= 0 && BINARY_EXTENSIONS.has(basename.slice(dot).toLowerCase());
}

export function looksLikeBinaryContent(content: string): boolean {
  if (content.includes('\0')) return true;
  const sample = content.slice(0, 8192);
  if (!sample) return false;
  let suspicious = 0;
  for (const character of sample) {
    const code = character.charCodeAt(0);
    if (code === 0xfffd || (code < 32 && code !== 9 && code !== 10 && code !== 13 && code !== 12)) suspicious += 1;
  }
  return suspicious / sample.length > 0.01;
}

function isFileNotFound(error: unknown): boolean {
  const value = error as { code?: string; name?: string } | undefined;
  return value?.code === 'FileNotFound' || value?.code === 'ENOENT' || value?.name === 'FileNotFound';
}

function mapFsError(error: unknown): WorkspaceRequestError {
  if (error instanceof WorkspaceRequestError) return error;
  if (isFileNotFound(error)) return new WorkspaceRequestError('FILE_NOT_FOUND', '工作区文件不存在。');
  return new WorkspaceRequestError('WORKSPACE_REQUEST_FAILED', 'VS Code 无法读取该工作区文件。');
}

async function statPathWithoutSymlinks(root: vscode.WorkspaceFolder, relativePath: string): Promise<vscode.FileStat>;
async function statPathWithoutSymlinks(root: vscode.WorkspaceFolder, relativePath: string, allowMissing: true): Promise<vscode.FileStat | undefined>;
async function statPathWithoutSymlinks(
  root: vscode.WorkspaceFolder,
  relativePath: string,
  allowMissing = false,
): Promise<vscode.FileStat | undefined> {
  let current = root.uri;
  const segments = relativePath.slice(1).split('/');
  try {
    for (let index = 0; index < segments.length; index += 1) {
      current = vscode.Uri.joinPath(current, segments[index]);
      const stat = await vscode.workspace.fs.stat(current);
      if ((stat.type & vscode.FileType.SymbolicLink) !== 0) {
        throw new WorkspaceRequestError('INVALID_PATH', '不允许通过符号链接访问工作区文件。');
      }
      if (index < segments.length - 1 && (stat.type & vscode.FileType.Directory) === 0) {
        throw new WorkspaceRequestError('FILE_NOT_FOUND', '工作区路径中的目录不存在。');
      }
      if (index === segments.length - 1) return stat;
    }
  } catch (error) {
    if (allowMissing && isFileNotFound(error)) return undefined;
    throw mapFsError(error);
  }
  throw new WorkspaceRequestError('FILE_NOT_FOUND', '工作区文件不存在。');
}

function isRegularFile(stat: vscode.FileStat): boolean {
  return (stat.type & vscode.FileType.File) !== 0;
}

function mutationPath(value: unknown, allowWorkspaceRoot = false): string {
  const path = normalizeWorkspaceRelativePath(value, allowWorkspaceRoot, true);
  if (path.split('/').some((segment) => segment.toLowerCase() === '.git')) {
    throw new WorkspaceRequestError('PROTECTED_PATH', '不允许对 Git 元数据执行此操作。');
  }
  return path;
}

function isProtectedDeletePath(path: string): boolean {
  return path.split('/').some((segment) => ['.git', '.vscode'].includes(segment.toLowerCase()));
}

function operationError(error: unknown, missingCode: string, existsCode?: string): WorkspaceRequestError {
  if (error instanceof WorkspaceRequestError) {
    if (error.code === 'FILE_NOT_FOUND' && missingCode !== 'FILE_NOT_FOUND') {
      return new WorkspaceRequestError(missingCode, '工作区目标不存在或其父目录不可用。');
    }
    return error;
  }
  const value = error as { code?: string; message?: string; name?: string } | undefined;
  if (isFileNotFound(error)) return new WorkspaceRequestError(missingCode, '工作区目标不存在或其父目录不可用。');
  if ((value?.code === 'FileExists' || value?.name === 'FileExists') && existsCode) {
    return new WorkspaceRequestError(existsCode, '工作区中已存在同名目标。');
  }
  if (/directory\s+not\s+empty|not\s+empty|目录非空/i.test(value?.message ?? '')) {
    return new WorkspaceRequestError('DIRECTORY_NOT_EMPTY', '目录不为空；为避免误删，未执行删除。');
  }
  return new WorkspaceRequestError('WORKSPACE_OPERATION_FAILED', 'VS Code 无法完成该工作区操作。');
}

function expectedDeleteVersion(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new WorkspaceRequestError('WORKSPACE_REQUEST_FAILED', 'expectedFileVersion 必须是非负整数。');
  }
  return value as number;
}

function documentIsWithinDirectory(document: vscode.TextDocument, directory: vscode.Uri, root: vscode.WorkspaceFolder): boolean {
  if (!isUriWithinWorkspaceRoot(document.uri, root)
    || document.uri.scheme !== directory.scheme
    || document.uri.authority !== directory.authority) return false;
  const directoryPath = directory.path.replace(/\/$/, '');
  return document.uri.path.startsWith(`${directoryPath}/`);
}

export async function createProjectFile(params: WorkspaceParams): Promise<Record<string, unknown>> {
  if (typeof params.content !== 'string') {
    throw new WorkspaceRequestError('WORKSPACE_REQUEST_FAILED', 'content 必须是字符串。');
  }
  const encoded = new TextEncoder().encode(params.content);
  if (encoded.byteLength > MAX_CREATE_FILE_BYTES) {
    throw new WorkspaceRequestError('FILE_TOO_LARGE', '新文件超过安全创建限制。');
  }
  if (looksLikeBinaryContent(params.content)) {
    throw new WorkspaceRequestError('UNSUPPORTED_FILE_TYPE', '新文件内容必须是文本。');
  }

  const path = mutationPath(params.path);
  if (isBinaryPath(path)) {
    throw new WorkspaceRequestError('UNSUPPORTED_FILE_TYPE', '不支持创建二进制文件。');
  }
  if (isExcludedOrSensitive(path)) {
    throw new WorkspaceRequestError('INVALID_PATH', '该文件属于排除目录或敏感文件。');
  }
  const root = selectWorkspaceRoot(params.root);
  const parentPath = path.slice(0, path.lastIndexOf('/')) || '/';
  let parent: vscode.FileStat;
  try {
    parent = parentPath === '/' ? await vscode.workspace.fs.stat(root.uri) : await statPathWithoutSymlinks(root, parentPath);
  } catch (error) {
    throw operationError(error, 'DIRECTORY_NOT_FOUND');
  }
  if ((parent.type & vscode.FileType.Directory) === 0) {
    throw new WorkspaceRequestError('DIRECTORY_NOT_FOUND', '新文件的父路径不是目录。');
  }

  const existing = await statPathWithoutSymlinks(root, path, true);
  const uri = toWorkspaceUri(path, root, true);
  if (existing || findOpenDocument(uri)) {
    throw new WorkspaceRequestError('FILE_ALREADY_EXISTS', '文件已存在，不会覆盖已有内容。');
  }
  const edit = new vscode.WorkspaceEdit();
  // createFile with overwrite=false is atomic with respect to the file's initial
  // content; workspace.fs.writeFile has no create-only option and could clobber
  // a file created between a stat and write.
  edit.createFile(uri, { overwrite: false, contents: encoded });
  let applied: boolean;
  try {
    applied = await vscode.workspace.applyEdit(edit);
  } catch (error) {
    throw operationError(error, 'DIRECTORY_NOT_FOUND', 'FILE_ALREADY_EXISTS');
  }
  if (!applied) {
    if (await statPathWithoutSymlinks(root, path, true)) {
      throw new WorkspaceRequestError('FILE_ALREADY_EXISTS', '文件已存在，不会覆盖已有内容。');
    }
    throw new WorkspaceRequestError('WORKSPACE_OPERATION_FAILED', 'VS Code 拒绝创建该文件。');
  }
  return { success: true, path, created: true };
}

export async function createProjectDirectory(params: WorkspaceParams): Promise<Record<string, unknown>> {
  const path = mutationPath(params.path);
  if (isExcludedOrSensitive(path)) {
    throw new WorkspaceRequestError('INVALID_PATH', '该目录属于排除目录或敏感路径。');
  }
  const root = selectWorkspaceRoot(params.root);
  let existing: vscode.FileStat | undefined;
  try {
    existing = await statPathWithoutSymlinks(root, path, true);
  } catch (error) {
    throw operationError(error, 'DIRECTORY_NOT_FOUND');
  }
  if (existing) {
    throw new WorkspaceRequestError('DIRECTORY_ALREADY_EXISTS', '目标路径已存在。');
  }
  const uri = toWorkspaceUri(path, root, true);
  try {
    // VS Code's workspace.fs.createDirectory has mkdirp semantics. Existing
    // ancestors are checked by statPathWithoutSymlinks before this call.
    await vscode.workspace.fs.createDirectory(uri);
  } catch (error) {
    throw operationError(error, 'DIRECTORY_NOT_FOUND', 'DIRECTORY_ALREADY_EXISTS');
  }
  return { success: true, path, created: true };
}

export async function deleteProjectFile(params: WorkspaceParams): Promise<Record<string, unknown>> {
  const path = mutationPath(params.path);
  if (isProtectedDeletePath(path)) {
    throw new WorkspaceRequestError('PROTECTED_PATH', '不允许删除 Git 或 VS Code 元数据路径。');
  }
  const root = selectWorkspaceRoot(params.root);
  const uri = toWorkspaceUri(path, root, true);
  let stat: vscode.FileStat;
  try {
    stat = await statPathWithoutSymlinks(root, path);
  } catch (error) {
    throw operationError(error, 'FILE_NOT_FOUND');
  }
  if (!isRegularFile(stat)) {
    throw new WorkspaceRequestError('FILE_NOT_FOUND', '目标路径不是普通文件。');
  }

  const open = findOpenDocument(uri);
  const expected = expectedDeleteVersion(params.expectedFileVersion ?? params.expectedVersion);
  if (open && expected !== undefined && open.version !== expected) {
    throw new WorkspaceRequestError('VERSION_CONFLICT', `文件版本已变化，请重新读取后再删除：${path}`);
  }
  if (open?.isDirty) {
    throw new WorkspaceRequestError('FILE_HAS_UNSAVED_CHANGES', '文件有未保存的编辑，已取消删除。');
  }

  try {
    await vscode.workspace.fs.delete(uri, { recursive: false, useTrash: true });
  } catch (error) {
    throw operationError(error, 'FILE_NOT_FOUND');
  }
  return { success: true, path, deleted: true };
}

export async function deleteProjectDirectory(params: WorkspaceParams): Promise<Record<string, unknown>> {
  if (params.recursive === true) {
    throw new WorkspaceRequestError('UNSUPPORTED_OPERATION', '第一版不允许递归删除目录。');
  }
  const path = mutationPath(params.path, true);
  if (!path) {
    throw new WorkspaceRequestError('WORKSPACE_ROOT_PROTECTED', '不允许删除当前工作区根目录。');
  }
  if (isProtectedDeletePath(path)) {
    throw new WorkspaceRequestError('PROTECTED_PATH', '不允许删除 Git 或 VS Code 元数据目录。');
  }
  const root = selectWorkspaceRoot(params.root);
  const uri = toWorkspaceUri(path, root, true);
  let stat: vscode.FileStat;
  try {
    stat = await statPathWithoutSymlinks(root, path);
  } catch (error) {
    throw operationError(error, 'DIRECTORY_NOT_FOUND');
  }
  if ((stat.type & vscode.FileType.Directory) === 0) {
    throw new WorkspaceRequestError('DIRECTORY_NOT_FOUND', '目标路径不是目录。');
  }

  if (vscode.workspace.textDocuments.some((document) => document.isDirty && documentIsWithinDirectory(document, uri, root))) {
    throw new WorkspaceRequestError('DIRECTORY_HAS_UNSAVED_CHANGES', '目录中包含未保存的文件，已取消删除。');
  }
  let entries: [string, vscode.FileType][];
  try {
    entries = await vscode.workspace.fs.readDirectory(uri);
  } catch (error) {
    throw operationError(error, 'DIRECTORY_NOT_FOUND');
  }
  if (entries.length > 0) {
    throw new WorkspaceRequestError('DIRECTORY_NOT_EMPTY', '目录不为空；为避免误删，未执行删除。');
  }

  try {
    await vscode.workspace.fs.delete(uri, { recursive: false, useTrash: true });
  } catch (error) {
    throw operationError(error, 'DIRECTORY_NOT_FOUND');
  }
  return { success: true, path, deleted: true };
}

async function openDocument(uri: vscode.Uri): Promise<vscode.TextDocument> {
  const open = findOpenDocument(uri);
  try {
    return open ?? await vscode.workspace.openTextDocument(uri);
  } catch (error) {
    throw mapFsError(error);
  }
}

export type EditableWorkspaceDocument = {
  path: string;
  uri: vscode.Uri;
  root: vscode.WorkspaceFolder;
  document: vscode.TextDocument;
  fileVersion: number;
  content: string;
};

/** Resolve an existing text file using the same containment/symlink rules as reads. */
export async function openEditableWorkspaceDocument(
  pathValue: unknown,
  requestedRoot?: unknown,
): Promise<EditableWorkspaceDocument> {
  const path = normalizeWorkspaceRelativePath(pathValue);
  if (isBinaryPath(path)) {
    throw new WorkspaceRequestError('UNSUPPORTED_FILE_TYPE', '不支持修改二进制文件。');
  }
  if (isExcludedOrSensitive(path)) {
    throw new WorkspaceRequestError('INVALID_PATH', '该文件属于排除目录或敏感文件。');
  }
  const root = selectWorkspaceRoot(requestedRoot);
  const uri = toWorkspaceUri(path, root);
  const stat = await statPathWithoutSymlinks(root, path);
  if (!isRegularFile(stat)) {
    throw new WorkspaceRequestError('FILE_NOT_FOUND', '目标路径不是普通文件。');
  }
  const alreadyOpen = findOpenDocument(uri);
  if (stat.size > MAX_RANGE_FILE_BYTES && !alreadyOpen) {
    throw new WorkspaceRequestError('FILE_TOO_LARGE', '文件超过安全修改限制。');
  }
  const document = await openDocument(uri);
  const fileVersion = document.version;
  const content = document.getText();
  if (looksLikeBinaryContent(content)) {
    throw new WorkspaceRequestError('UNSUPPORTED_FILE_TYPE', '文件内容不是可修改的文本。');
  }
  if (content.length > MAX_RANGE_FILE_BYTES) {
    throw new WorkspaceRequestError('FILE_TOO_LARGE', '文件内容超过安全修改限制。');
  }
  return { path, uri, root, document, fileVersion, content };
}

function findOpenDocument(uri: vscode.Uri): vscode.TextDocument | undefined {
  const key = uri.toString();
  return vscode.workspace.textDocuments.find((document) => document.uri.toString() === key);
}

function getWorkspaceVersion(params: WorkspaceParams): number | undefined {
  const version = params.workspaceVersion;
  return Number.isSafeInteger(version) && (version as number) >= 0 ? version as number : undefined;
}

function getRootInfo(root: vscode.WorkspaceFolder, params: WorkspaceParams): Record<string, unknown> {
  const label = rootLabel(root);
  return label.isMultiRoot
    ? { root: label.id, rootName: label.name }
    : { rootName: label.name };
}

export async function listProjectFiles(params: WorkspaceParams): Promise<Record<string, unknown>> {
  const root = selectWorkspaceRoot(params.root);
  const label = rootLabel(root);
  const files: string[] = [];
  const directories: string[] = [];
  const pending: Array<{ uri: vscode.Uri; path: string }> = [{ uri: root.uri, path: '' }];
  let visited = 0;
  let truncated = false;
  try {
    while (pending.length > 0 && visited <= MAX_LIST_FILES) {
      const current = pending.pop()!;
      const entries = await vscode.workspace.fs.readDirectory(current.uri);
      for (const [name, type] of entries) {
        if (!name || name === '.' || name === '..' || (type & vscode.FileType.SymbolicLink) !== 0) continue;
        const relativePath = current.path ? `${current.path}/${name}` : name;
        if (isExcludedOrSensitive(relativePath)) continue;
        visited += 1;
        if (visited > MAX_LIST_FILES) {
          truncated = true;
          break;
        }
        const workspacePath = `/${relativePath}`;
        if ((type & vscode.FileType.Directory) !== 0) {
          directories.push(workspacePath);
          pending.push({ uri: vscode.Uri.joinPath(current.uri, name), path: relativePath });
        } else if ((type & vscode.FileType.File) !== 0) {
          files.push(workspacePath);
        }
      }
    }
    if (pending.length > 0) truncated = true;
  } catch {
    throw new WorkspaceRequestError('WORKSPACE_REQUEST_FAILED', '无法读取当前工作区目录树。');
  }

  files.sort((a, b) => a.localeCompare(b));
  directories.sort((a, b) => a.localeCompare(b));
  const result: Record<string, unknown> = {
    success: true,
    files,
    directories,
    version: getWorkspaceVersion(params),
    truncated,
  };
  Object.assign(result, getRootInfo(root, params));
  if (label.isMultiRoot) result.availableRoots = describeWorkspaceRoots();
  return result;
}

function clippedLine(line: string, matchColumn: number): string {
  if (line.length <= 300) return line;
  const start = Math.max(0, Math.min(matchColumn - 120, line.length - 300));
  const end = start + 300;
  return `${start ? '…' : ''}${line.slice(start, end)}${end < line.length ? '…' : ''}`;
}

type SearchHit = { line: number; count: number; column: number };

function createSearchResults(relativePath: string, text: string, query: string): {
  results: Array<Record<string, unknown>>;
  truncated: boolean;
} {
  const lines = text.split(/\r\n|\n|\r/);
  const foldedQuery = query.toLocaleLowerCase();
  const hits: SearchHit[] = [];
  let truncated = false;
  for (let index = 0; index < lines.length; index += 1) {
    const foldedLine = lines[index].toLocaleLowerCase();
    const first = foldedLine.indexOf(foldedQuery);
    if (first < 0) continue;
    let count = 0;
    let cursor = first;
    while (cursor >= 0 && count < MAX_MATCHES_PER_LINE) {
      count += 1;
      cursor = foldedLine.indexOf(foldedQuery, cursor + Math.max(1, foldedQuery.length));
    }
    if (cursor >= 0) truncated = true;
    hits.push({ line: index + 1, count, column: first });
    if (hits.length >= MAX_SEARCH_HIT_LINES_PER_FILE) {
      if (index < lines.length - 1) truncated = true;
      break;
    }
  }

  const results: Array<Record<string, unknown>> = [];
  for (const hit of hits) {
    const startLine = Math.max(1, hit.line - 3);
    const endLine = Math.min(lines.length, hit.line + 3);
    const previous = results[results.length - 1];
    if (previous && startLine <= Number(previous.endLine) + 1) {
      const nextEnd = Math.max(Number(previous.endLine), endLine);
      const snippet = lines.slice(Number(previous.startLine) - 1, nextEnd).map((line, index) => {
        const lineNumber = Number(previous.startLine) + index;
        const matching = hits.find((item) => item.line === lineNumber);
        return clippedLine(line, matching?.column ?? 0);
      }).join('\n');
      if (snippet.length <= MAX_SNIPPET_CHARS) {
        previous.endLine = nextEnd;
        previous.matchCount = Number(previous.matchCount) + hit.count;
        (previous.matchLines as number[]).push(hit.line);
        previous.snippet = snippet;
        continue;
      }
    }
    const snippet = lines.slice(startLine - 1, endLine).map((line, index) =>
      clippedLine(line, startLine + index === hit.line ? hit.column : 0),
    ).join('\n').slice(0, MAX_SNIPPET_CHARS);
    results.push({
      path: relativePath,
      line: hit.line,
      startLine,
      endLine,
      matchCount: hit.count,
      matchLines: [hit.line],
      snippet,
    });
  }
  return { results, truncated };
}

function boundedInteger(value: unknown, fallback: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) return fallback;
  return Math.min(value as number, maximum);
}

export async function searchProjectCode(params: WorkspaceParams): Promise<Record<string, unknown>> {
  const query = typeof params.query === 'string' ? params.query.trim() : '';
  if (!query || query.length > 200) {
    throw new WorkspaceRequestError('WORKSPACE_REQUEST_FAILED', 'query 必须是 1–200 个字符。');
  }
  const root = selectWorkspaceRoot(params.root);
  const label = rootLabel(root);
  const maxFiles = boundedInteger(params.maxFiles, DEFAULT_SEARCH_FILES, MAX_SEARCH_FILES);
  const maxResults = boundedInteger(params.maxResults, DEFAULT_SEARCH_RESULTS, MAX_SEARCH_RESULTS);
  const maxTotalChars = boundedInteger(params.maxTotalChars, DEFAULT_SEARCH_TOTAL_CHARS, MAX_SEARCH_TOTAL_CHARS);
  let pathPrefix = '';
  if (params.path !== undefined && params.path !== null && params.path !== '') {
    pathPrefix = normalizeWorkspaceRelativePath(params.path, true);
  }

  const candidates = new Map<string, vscode.Uri>();
  let candidateOverflow = false;
  const addCandidate = (uri: vscode.Uri) => {
    if (!isUriWithinWorkspaceRoot(uri, root)) return;
    let relative: string;
    try {
      relative = workspaceRelativePath(uri, root);
    } catch {
      return;
    }
    if (isExcludedOrSensitive(relative) || isBinaryPath(relative)) return;
    if (pathPrefix && relative !== pathPrefix && !relative.startsWith(`${pathPrefix}/`)) return;
    const key = uri.toString();
    if (candidates.has(key)) return;
    if (candidates.size >= maxFiles) {
      candidateOverflow = true;
      return;
    }
    candidates.set(key, uri);
  };

  // Open and active editors are considered first so unsaved text is searched first.
  const active = vscode.window.activeTextEditor?.document;
  if (active) addCandidate(active.uri);
  for (const document of vscode.workspace.textDocuments) addCandidate(document.uri);

  let workspaceUris: vscode.Uri[] = [];
  try {
    workspaceUris = await vscode.workspace.findFiles(
      new vscode.RelativePattern(root, '**/*'),
      EXCLUDE_GLOB,
      maxFiles + 1,
    );
  } catch {
    throw new WorkspaceRequestError('WORKSPACE_REQUEST_FAILED', '无法搜索当前工作区文件。');
  }
  workspaceUris.forEach(addCandidate);

  const results: Array<Record<string, unknown>> = [];
  let filesScanned = 0;
  let charsScanned = 0;
  let snippetChars = 0;
  let truncated = workspaceUris.length > maxFiles || candidateOverflow;
  for (const uri of candidates.values()) {
    if (filesScanned >= maxFiles || results.length >= maxResults || charsScanned >= maxTotalChars) {
      truncated = true;
      break;
    }
    const relativePath = workspaceRelativePath(uri, root);
    let stat: vscode.FileStat;
    try {
      stat = await statPathWithoutSymlinks(root, relativePath);
    } catch {
      continue;
    }
    const alreadyOpen = findOpenDocument(uri);
    if (!isRegularFile(stat) || (stat.size > MAX_SEARCH_FILE_BYTES && !alreadyOpen)) {
      truncated = true;
      continue;
    }

    let document: vscode.TextDocument;
    try {
      document = await openDocument(uri);
    } catch {
      continue;
    }
    const content = document.getText();
    if (looksLikeBinaryContent(content)) continue;
    if (content.length > MAX_SEARCH_FILE_BYTES) {
      truncated = true;
      continue;
    }
    if (charsScanned + content.length > maxTotalChars) {
      truncated = true;
      break;
    }
    charsScanned += content.length;
    filesScanned += 1;
    const matches = createSearchResults(relativePath, content, query);
    truncated ||= matches.truncated;
    for (const match of matches.results) {
      if (results.length >= maxResults || snippetChars >= MAX_TOTAL_SNIPPET_CHARS) {
        truncated = true;
        break;
      }
      if (label.isMultiRoot) match.root = label.id;
      const nextSnippetChars = String(match.snippet ?? '').length;
      if (snippetChars + nextSnippetChars > MAX_TOTAL_SNIPPET_CHARS) {
        truncated = true;
        break;
      }
      snippetChars += nextSnippetChars;
      results.push(match);
    }
    if (results.length >= maxResults) {
      truncated = true;
      break;
    }
  }

  const response: Record<string, unknown> = {
    success: true,
    query,
    filesScanned,
    charsScanned,
    maxFiles,
    maxResults,
    truncated,
    results,
    ...(truncated ? {
      limitWarning: {
        code: 'SEARCH_LIMIT_REACHED',
        message: '搜索达到文件数、结果数或文本预算上限；可缩小 path 或 query 后继续搜索。',
      },
    } : {}),
  };
  const workspaceVersion = getWorkspaceVersion(params);
  if (workspaceVersion !== undefined) response.workspaceVersion = workspaceVersion;
  Object.assign(response, getRootInfo(root, params));
  return response;
}

export async function readProjectFile(params: WorkspaceParams): Promise<Record<string, unknown>> {
  const path = normalizeWorkspaceRelativePath(params.path);
  if (isBinaryPath(path)) {
    throw new WorkspaceRequestError('UNSUPPORTED_FILE_TYPE', '不支持读取二进制文件。');
  }
  if (isExcludedOrSensitive(path)) {
    throw new WorkspaceRequestError('INVALID_PATH', '该文件属于排除目录或敏感文件。');
  }
  const root = selectWorkspaceRoot(params.root);
  const rootInfo = rootLabel(root);
  const uri = toWorkspaceUri(path, root);
  const stat = await statPathWithoutSymlinks(root, path);
  if (!isRegularFile(stat)) {
    throw new WorkspaceRequestError('FILE_NOT_FOUND', '目标路径不是普通文件。');
  }
  const hasRange = params.startLine !== undefined && params.startLine !== null
    || params.endLine !== undefined && params.endLine !== null;
  const byteLimit = hasRange ? MAX_RANGE_FILE_BYTES : MAX_READ_FILE_BYTES;
  const alreadyOpen = findOpenDocument(uri);
  if (stat.size > byteLimit && !alreadyOpen) {
    throw new WorkspaceRequestError('FILE_TOO_LARGE', `文件超过 ${Math.floor(byteLimit / 1_000_000)} MB 读取限制；请指定较小的行范围。`);
  }

  const document = await openDocument(uri);
  const entireText = document.getText();
  if (looksLikeBinaryContent(entireText)) {
    throw new WorkspaceRequestError('UNSUPPORTED_FILE_TYPE', '文件内容不是可读取的文本。');
  }
  if (entireText.length > MAX_RANGE_FILE_BYTES) {
    throw new WorkspaceRequestError('FILE_TOO_LARGE', '文件内容超过安全读取限制。');
  }

  const startValue = params.startLine;
  const endValue = params.endLine;
  if (startValue !== undefined && startValue !== null && (!Number.isSafeInteger(startValue) || (startValue as number) < 1)) {
    throw new WorkspaceRequestError('WORKSPACE_REQUEST_FAILED', 'startLine 必须是大于等于 1 的行号。');
  }
  if (endValue !== undefined && endValue !== null && (!Number.isSafeInteger(endValue) || (endValue as number) < 1)) {
    throw new WorkspaceRequestError('WORKSPACE_REQUEST_FAILED', 'endLine 必须是大于等于 1 的行号。');
  }
  const startLine = startValue === undefined || startValue === null ? 1 : startValue as number;
  const endLine = endValue === undefined || endValue === null ? document.lineCount : endValue as number;
  if (endLine < startLine) {
    throw new WorkspaceRequestError('WORKSPACE_REQUEST_FAILED', 'endLine 不能小于 startLine。');
  }
  if (startLine > document.lineCount) {
    const response: Record<string, unknown> = {
      success: true,
      path,
      startLine,
      endLine: startLine - 1,
      totalLines: document.lineCount,
      content: '',
      version: document.version,
      fileVersion: document.version,
      workspaceVersion: getWorkspaceVersion(params),
    };
    if (rootInfo.isMultiRoot) response.root = rootInfo.id;
    else response.rootName = root.name;
    return response;
  }
  const actualEnd = Math.min(endLine, document.lineCount);
  if (actualEnd - startLine + 1 > MAX_READ_RANGE_LINES) {
    throw new WorkspaceRequestError('FILE_TOO_LARGE', `单次读取最多 ${MAX_READ_RANGE_LINES} 行，请缩小范围。`);
  }

  const firstLineIndex = startLine - 1;
  const lastLineIndex = Math.max(firstLineIndex, actualEnd - 1);
  const rangeEnd = actualEnd < document.lineCount
    ? new vscode.Position(actualEnd, 0)
    : document.lineAt(lastLineIndex).range.end;
  const content = document.getText(new vscode.Range(
    new vscode.Position(firstLineIndex, 0),
    rangeEnd,
  ));
  if (content.length > MAX_READ_CHARS) {
    throw new WorkspaceRequestError('FILE_TOO_LARGE', '所选内容超过单次返回字符数限制，请缩小行范围。');
  }

  const response: Record<string, unknown> = {
    success: true,
    path,
    startLine,
    endLine: actualEnd,
    totalLines: document.lineCount,
    content,
    version: document.version,
    fileVersion: document.version,
    workspaceVersion: getWorkspaceVersion(params),
  };
  if (rootInfo.isMultiRoot) response.root = rootInfo.id;
  else response.rootName = root.name;
  return response;
}
