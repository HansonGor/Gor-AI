import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { HostFolder } from '../../host';
import { normalizeWorkspaceRelativePath, toWorkspaceUri, WorkspaceRequestError } from '../../paths';
import { currentPath } from '../runner';
import type { ActionContext } from '../types';

/**
 * 命令型工具链（Node、Python）共用的纯函数：路径、PATH 查找、子项目扫描、参数校验。
 * 只放与语言无关的部分；各语言的定位、定级与命令计划仍留在各自的 profile 里。
 */

/** 子项目扫描都跳过的目录；各语言再追加自己的构建与缓存目录。 */
export const BASE_EXCLUDED_DIRS = ['node_modules', '.git', 'dist', 'build', 'coverage', 'out', 'vendor'];
export const MAX_ARGS = 20;

export async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export function hash(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export function requireLocalFolder(root: HostFolder): void {
  if (root.uri.scheme !== 'file') {
    throw new WorkspaceRequestError('TOOLCHAIN_UNAVAILABLE', '工具链目前只支持本地文件工作区。');
  }
}

export function rootDirOf(context: ActionContext): string {
  return path.resolve(context.root.uri.fsPath);
}

export function cwdDirOf(context: ActionContext): string {
  return path.resolve(context.cwdUri.fsPath);
}

export function isInside(absolute: string, dir: string): boolean {
  return absolute === dir || absolute.startsWith(dir + path.sep);
}

/**
 * 测试/检查/运行的目标路径，必须位于命令的工作目录之内；返回相对 cwd 的写法（参数里不出现本机绝对路径）。
 * 以 / 开头按工作区根解析；不以 / 开头时，工作区根下不在 cwd 之内的，再按命令目录解析（cwd 为 test-demo 时写 test_math.py）。
 */
export function targetPath(value: unknown, context: ActionContext, require?: { pattern: RegExp; message: string }): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const normalized = normalizeWorkspaceRelativePath(value);
  if (require && !require.pattern.test(normalized)) throw new WorkspaceRequestError('INVALID_PARAMS', require.message);
  const cwd = cwdDirOf(context);
  let absolute = path.resolve(toWorkspaceUri(normalized, context.root).fsPath);
  if (!isInside(absolute, cwd) && typeof value === 'string' && !/^[\\/]/.test(value)) absolute = path.resolve(cwd, normalized.replace(/^\/+/, ''));
  if (!isInside(absolute, cwd)) {
    throw new WorkspaceRequestError('INVALID_PATH', '目标路径必须位于命令的工作目录之内。');
  }
  return path.relative(cwd, absolute) || '.';
}

/** 传给程序的参数数组：最多 max 个字符串，原样传递、不经过 shell。 */
export function readArgs(value: unknown, runtime: string, max = MAX_ARGS): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > max || value.some((item) => typeof item !== 'string' || item.length > 500 || item.includes('\0'))) {
    throw new WorkspaceRequestError('INVALID_PARAMS', `args 必须是最多 ${max} 个字符串（参数直接传给 ${runtime}，不经过 shell）。`);
  }
  return value as string[];
}

/** 按 PATH 顺序查找可执行文件（只检查文件是否存在，不执行 PATH 中的任何程序）；skip 用于排除占位程序。 */
export async function findOnPath(names: string[], skip?: (file: string) => boolean): Promise<string | undefined> {
  for (const dir of currentPath().split(path.delimiter).filter(Boolean)) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (skip?.(candidate)) continue;
      if (await exists(candidate)) return candidate;
    }
  }
  return undefined;
}

/** 自工作区根向下（最多 3 层）查找含任一标记文件的目录，跳过隐藏目录与 excluded。 */
export async function findProjectDirs(rootDir: string, options: { markers: string[]; excluded: ReadonlySet<string>; max: number }): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string, depth: number) => {
    if (found.length >= options.max || depth > 3) return;
    for (const marker of options.markers) {
      if (await exists(path.join(dir, marker))) { found.push(dir); break; }
    }
    let entries: Array<import('node:fs').Dirent>;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || options.excluded.has(entry.name.toLowerCase())) continue;
      await walk(path.join(dir, entry.name), depth + 1);
    }
  };
  await walk(rootDir, 0);
  return found;
}

/** 工作区内目录的显示写法：根为 /，其余为 /a/b。 */
export function workspaceRelativeDir(rootDir: string, dir: string): string {
  const relative = path.relative(rootDir, dir).split(path.sep).join('/');
  return relative ? `/${relative}` : '/';
}
