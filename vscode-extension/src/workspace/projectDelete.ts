import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { normalizeWorkspaceRelativePath, selectWorkspaceRoot, toWorkspaceUri, WorkspaceRequestError } from './paths';

/**
 * 删除整个项目目录（递归）：只允许删除含 package.json 或 .git 的项目目录，工作区根目录永远不能删。
 * 删除进系统回收站；是否放行由工具链框架按 R2 处理（两种模式都要确认）。
 */

const MAX_COUNTED_FILES = 50_000;

export type PreparedProjectDelete = {
  path: string;
  fileCount: number;
  countTruncated: boolean;
  markers: string[];
  execute: () => Promise<Record<string, unknown>>;
};

async function countFiles(dir: string): Promise<{ count: number; truncated: boolean }> {
  let count = 0;
  const walk = async (current: string): Promise<boolean> => {
    let entries: Array<import('node:fs').Dirent>;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return true;
    }
    for (const entry of entries) {
      if (count >= MAX_COUNTED_FILES) return false;
      if (entry.isDirectory()) {
        if (!await walk(path.join(current, entry.name))) return false;
      } else {
        count += 1;
      }
    }
    return true;
  };
  const complete = await walk(dir);
  return { count, truncated: !complete };
}

export async function prepareProjectDelete(params: Record<string, unknown>): Promise<PreparedProjectDelete> {
  const relative = normalizeWorkspaceRelativePath(params.path, true, false);
  if (!relative || relative === '/') {
    throw new WorkspaceRequestError('WORKSPACE_ROOT_PROTECTED', '不允许删除当前工作区根目录。');
  }
  const root = selectWorkspaceRoot(params.root);
  const uri = toWorkspaceUri(relative, root);
  if (uri.scheme !== 'file') throw new WorkspaceRequestError('UNSUPPORTED_OPERATION', '只支持删除本地文件工作区中的项目。');
  const absolute = uri.fsPath;
  let stat: import('node:fs').Stats;
  try {
    stat = await fs.lstat(absolute);
  } catch {
    throw new WorkspaceRequestError('DIRECTORY_NOT_FOUND', `目录不存在：${relative}`);
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new WorkspaceRequestError('DIRECTORY_NOT_FOUND', '目标不是普通目录（不跟随符号链接）。');
  }
  const markers: string[] = [];
  for (const marker of ['package.json', '.git']) {
    try { await fs.lstat(path.join(absolute, marker)); markers.push(marker); } catch { /* not a marker */ }
  }
  if (!markers.length) {
    throw new WorkspaceRequestError('NOT_A_PROJECT', '该目录不含 package.json 或 .git，不按项目删除；删除普通目录请逐个删除文件。');
  }
  const dirty = vscode.workspace.textDocuments.filter((document) =>
    document.isDirty && document.uri.scheme === 'file' && document.uri.fsPath.startsWith(absolute + path.sep));
  if (dirty.length) {
    throw new WorkspaceRequestError('DIRECTORY_HAS_UNSAVED_CHANGES', '项目中有未保存的文件，已取消删除。');
  }
  const { count, truncated } = await countFiles(absolute);
  return {
    path: relative, fileCount: count, countTruncated: truncated, markers,
    async execute() {
      try {
        await vscode.workspace.fs.delete(uri, { recursive: true, useTrash: true });
      } catch (error) {
        throw new WorkspaceRequestError('DELETE_FAILED', `删除失败：${error instanceof Error ? error.message : String(error)}`);
      }
      return { success: true, path: relative, deleted: true, recursive: true, fileCount: count, movedToTrash: true };
    },
  };
}
