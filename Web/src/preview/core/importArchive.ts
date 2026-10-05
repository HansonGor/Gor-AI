import { Unzip, UnzipInflate, UnzipPassThrough, zipSync } from 'fflate';
import type { PreviewFiles, PreviewTemplate } from './types.ts';
import { isEditablePreviewTextPath, normalizePreviewPath } from './pathUtils.ts';

const MAX_ARCHIVE_BYTES = 20 * 1024 * 1024;
const MAX_EXTRACTED_BYTES = 40 * 1024 * 1024;
const MAX_ARCHIVE_FILES = 200;

export interface ImportedDistArchive {
  kind: 'dist';
  name: string;
  entryPath: string;
  files: Record<string, Uint8Array>;
  archiveBytes: Uint8Array;
}

export interface ImportedSourceArchive {
  kind: 'source';
  name: string;
  template: PreviewTemplate;
  files: PreviewFiles;
  archiveBytes: Uint8Array;
}

export type ImportedPreviewArchive = ImportedDistArchive | ImportedSourceArchive;

interface ExtractedFile {
  name: string;
  bytes: Uint8Array;
}

function safeArchivePath(rawPath: string): string | null {
  const slashPath = rawPath.replace(/\\/g, '/');
  if (!slashPath || slashPath.startsWith('/') || /^[a-z]:/i.test(slashPath)) return null;
  const segments = slashPath.split('/').filter(Boolean);
  if (segments.some((segment) => segment === '..' || segment === '.' || segment.includes('\0'))) return null;
  if (segments.some((segment) => segment === 'node_modules' || segment === '.git' || segment === '__MACOSX')) return null;
  return segments.join('/');
}

function extractZip(data: Uint8Array, signal?: AbortSignal): Promise<ExtractedFile[]> {
  if (data.byteLength > MAX_ARCHIVE_BYTES) return Promise.reject(new Error('ZIP 文件超过 20 MB，暂不支持导入。'));
  if (signal?.aborted) return Promise.reject(new DOMException('Import cancelled.', 'AbortError'));

  return new Promise((resolve, reject) => {
    const extracted: ExtractedFile[] = [];
    let pending = 0;
    let totalBytes = 0;
    let declaredBytes = 0;
    let fileCount = 0;
    let inputFinished = false;
    let settled = false;
    const activeFiles = new Set<import('fflate').UnzipFile>();
    const finish = () => {
      if (!settled && inputFinished && pending === 0) {
        settled = true;
        signal?.removeEventListener('abort', abort);
        resolve(extracted);
      }
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abort);
      activeFiles.forEach((file) => void file.terminate());
      activeFiles.clear();
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    const abort = () => fail(new DOMException('Import cancelled.', 'AbortError'));
    signal?.addEventListener('abort', abort, { once: true });

    const unzip = new Unzip((file) => {
      if (settled) return;
      if (file.name.endsWith('/')) return;
      fileCount += 1;
      if (fileCount > MAX_ARCHIVE_FILES) {
        fail(new Error(`ZIP 文件过多，最多支持 ${MAX_ARCHIVE_FILES} 个文件。`));
        return;
      }
      const safeName = safeArchivePath(file.name);
      if (!safeName) return;
      declaredBytes += file.originalSize ?? 0;
      if ((file.originalSize ?? 0) > MAX_EXTRACTED_BYTES || declaredBytes > MAX_EXTRACTED_BYTES) {
        fail(new Error('ZIP 解压后超过 40 MB，已停止导入。'));
        return;
      }
      pending += 1;
      activeFiles.add(file);
      const chunks: Uint8Array[] = [];
      let fileBytes = 0;
      file.ondata = (error, chunk, final) => {
        if (error) {
          fail(error);
          return;
        }
        if (chunk) {
          fileBytes += chunk.byteLength;
          totalBytes += chunk.byteLength;
          if (totalBytes > MAX_EXTRACTED_BYTES) {
            fail(new Error('ZIP 解压后超过 40 MB，已停止导入。'));
            return;
          }
          chunks.push(chunk);
        }
        if (final) {
          const bytes = new Uint8Array(fileBytes);
          let offset = 0;
          chunks.forEach((part) => {
            bytes.set(part, offset);
            offset += part.byteLength;
          });
          extracted.push({ name: safeName, bytes });
          activeFiles.delete(file);
          pending -= 1;
          finish();
        }
      };
      try {
        file.start();
      } catch (error) {
        fail(error);
      }
    });

    unzip.register(UnzipInflate);
    unzip.register(UnzipPassThrough);
    try {
      unzip.push(data, true);
      inputFinished = true;
      finish();
    } catch (error) {
      fail(error);
    }
  });
}

function chooseIndexFile(paths: string[]): string | undefined {
  const htmlFiles = paths.filter((path) => /\.html?$/i.test(path));
  return htmlFiles.find((path) => /^index\.html?$/i.test(path))
    ?? htmlFiles.find((path) => /^(?:dist|build)\/index\.html?$/i.test(path))
    ?? htmlFiles.sort((left, right) => left.split('/').length - right.split('/').length)[0];
}

function stripProjectRoot(path: string, indexPath: string): string {
  const root = indexPath.slice(0, indexPath.lastIndexOf('/') + 1);
  return path.startsWith(root) ? path.slice(root.length) : path;
}

export async function importPreviewArchive(
  data: Uint8Array,
  fileName: string,
  signal?: AbortSignal,
): Promise<ImportedPreviewArchive> {
  const extracted = await extractZip(data, signal);
  return classifyPreviewFiles(extracted, fileName, data, signal);
}

/** Read a user-selected directory while preserving its relative paths. */
export async function importPreviewDirectory(
  selectedFiles: FileList | File[],
  signal?: AbortSignal,
): Promise<ImportedPreviewArchive> {
  const inputFiles = Array.from(selectedFiles);
  if (signal?.aborted) throw new DOMException('Import cancelled.', 'AbortError');
  if (inputFiles.length === 0) throw new Error('所选文件夹为空。');

  const extracted: ExtractedFile[] = [];
  let totalBytes = 0;
  const rootName = inputFiles[0]?.webkitRelativePath.split('/')[0] || 'Imported Project';
  for (const file of inputFiles) {
    if (signal?.aborted) throw new DOMException('Import cancelled.', 'AbortError');
    const relativePath = file.webkitRelativePath || file.name;
    const safeName = safeArchivePath(relativePath);
    if (!safeName) continue;
    const pathParts = safeName.split('/');
    if (pathParts.some((part) => ['node_modules', '.git', '__MACOSX'].includes(part))) continue;
    totalBytes += file.size;
    if (totalBytes > MAX_EXTRACTED_BYTES) throw new Error('文件夹内容超过 40 MB，已停止导入。');
    extracted.push({ name: safeName, bytes: new Uint8Array(await file.arrayBuffer()) });
    if (extracted.length > MAX_ARCHIVE_FILES) throw new Error(`文件夹文件过多，最多支持 ${MAX_ARCHIVE_FILES} 个文件。`);
  }
  if (extracted.length === 0) throw new Error('文件夹中没有可导入的文件。');

  // Directory pickers include the selected folder name in webkitRelativePath.
  // Strip it here so projects with a single top-level wrapper are handled like ZIP uploads.
  const rootPrefix = `${rootName}/`;
  const rootStripped = extracted.map(({ name, bytes }) => ({
    name: name.startsWith(rootPrefix) ? name.slice(rootPrefix.length) : name,
    bytes,
  }));
  const archiveBytes = zipSync(Object.fromEntries(rootStripped.map(({ name, bytes }) => [name, bytes])));
  return classifyPreviewFiles(rootStripped, rootName, archiveBytes, signal);
}

function classifyPreviewFiles(
  extracted: ExtractedFile[],
  fileName: string,
  originalArchive?: Uint8Array,
  signal?: AbortSignal,
): ImportedPreviewArchive {
  if (signal?.aborted) throw new DOMException('Import cancelled.', 'AbortError');
  if (extracted.length === 0) throw new Error('所选内容中没有可导入的文件。');

  const rawFiles = new Map<string, Uint8Array>();
  extracted.forEach(({ name, bytes }) => rawFiles.set(name, bytes));
  const rawIndex = chooseIndexFile([...rawFiles.keys()]);
  if (!rawIndex) throw new Error('没有找到 HTML 入口文件，无法识别为源码包或 dist 包。');

  const files: Record<string, Uint8Array> = Object.create(null);
  for (const [path, bytes] of rawFiles) {
    const relative = stripProjectRoot(path, rawIndex);
    try {
      const normalized = normalizePreviewPath(relative);
      files[normalized] = bytes;
    } catch {
      // Unsafe paths are ignored and never written into the virtual project.
    }
  }
  const entryPath = `/${stripProjectRoot(rawIndex, rawIndex)}`;
  const sourceFiles: PreviewFiles = Object.create(null);
  for (const [path, bytes] of Object.entries(files)) {
    if (!isEditablePreviewTextPath(path)) continue;
    try {
      const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      if (content.includes('\0')) continue;
      sourceFiles[path] = content;
    } catch {
      // Unknown/binary file types remain in the archive, but never enter the text VFS.
    }
  }

  const hasReactEntry = ['/src/main.tsx', '/src/main.ts', '/src/main.jsx', '/src/main.js']
    .some((path) => Object.prototype.hasOwnProperty.call(sourceFiles, path));
  const hasHtmlEntry = Object.prototype.hasOwnProperty.call(sourceFiles, '/main.js');
  if (hasReactEntry || hasHtmlEntry) {
    const template: PreviewTemplate = hasReactEntry ? 'react' : 'html';
    if (!sourceFiles['/index.html']) throw new Error('源码项目的 HTML 入口必须位于项目根目录。');
    if (Object.keys(sourceFiles).length > 100) throw new Error('源码文件过多，最多支持 100 个文本文件。');
    return {
      kind: 'source',
      name: fileName.replace(/\.zip$/i, ''),
      template,
      files: sourceFiles,
      archiveBytes: originalArchive ?? zipSync(Object.fromEntries(
        Object.entries(files).map(([path, bytes]) => [path.slice(1), bytes]),
      )),
    };
  }

  const indexHtml = sourceFiles['/index.html'];
  if (!indexHtml) throw new Error('dist 项目的 index.html 不是 UTF-8 文本文件。');
  return {
    kind: 'dist',
    name: fileName.replace(/\.zip$/i, ''),
    entryPath,
    files,
    archiveBytes: originalArchive ?? zipSync(Object.fromEntries(
      Object.entries(files).map(([path, bytes]) => [path.slice(1), bytes]),
    )),
  };
}
