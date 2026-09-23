import { normalizePreviewPath } from './pathUtils.ts';
import type { PreviewFiles } from './types.ts';

export function readFile(files: PreviewFiles, path: string): string | undefined {
  return files[normalizePreviewPath(path)];
}

export function writeFile(files: PreviewFiles, path: string, content: string): PreviewFiles {
  const normalizedPath = normalizePreviewPath(path);
  return { ...files, [normalizedPath]: content };
}

export function deleteFile(files: PreviewFiles, path: string): PreviewFiles {
  const normalizedPath = normalizePreviewPath(path);
  if (!(normalizedPath in files)) return { ...files };
  const nextFiles = { ...files };
  delete nextFiles[normalizedPath];
  return nextFiles;
}

export function fileExists(files: PreviewFiles, path: string): boolean {
  return Object.prototype.hasOwnProperty.call(files, normalizePreviewPath(path));
}

export function listFiles(files: PreviewFiles): string[] {
  return Object.keys(files).sort((left, right) => left.localeCompare(right));
}
