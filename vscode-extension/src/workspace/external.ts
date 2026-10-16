import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { WorkspaceRequestError } from './paths';

/**
 * 项目外的本地文件：只读（读取文件、列出目录），不提供新建、修改、删除。
 * 系统目录、密钥、凭据与浏览器资料路径一律拒绝；每次读取都由工具链框架按 R3 确认。
 */

const MAX_FILE_BYTES = 2_000_000;
const MAX_CONTENT_CHARS = 200_000;
const MAX_ENTRIES = 500;

const SYSTEM_PATHS = [
  /^[a-z]:\/(?:windows|program files(?: \(x86\))?|programdata|\$recycle\.bin|system volume information|recovery|boot)(?:\/|$)/i,
  /^[a-z]:\/users\/[^/]+\/ntuser\.dat/i,
  /^\/(?:etc|usr|bin|sbin|lib|lib32|lib64|boot|dev|proc|sys|root|run|snap|System|Library|private|var\/(?:lib|log|db|root))(?:\/|$)/i,
];

const SECRET_SEGMENTS = [
  /\/\.(?:ssh|gnupg|aws|azure|kube|docker|password-store|mozilla|vault-token)(?:\/|$)/i,
  /\/\.config\/(?:gcloud|gh|google-chrome|chromium|BraveSoftware|op)(?:\/|$)/i,
  /\/appdata\/roaming\/microsoft\/(?:credentials|vault|protect|crypto|systemcertificates)(?:\/|$)/i,
  /\/appdata\/(?:local|roaming)\/(?:google\/chrome|microsoft\/edge|bravesoftware|mozilla\/firefox|opera software)(?:\/|$)/i,
  /\/library\/(?:keychains|application support\/(?:google\/chrome|firefox|com\.apple\.TCC))(?:\/|$)/i,
];

const SECRET_NAMES = /^(?:\.env(?:\..*)?|\.npmrc|\.pypirc|\.netrc|_netrc|\.git-credentials|\.bash_history|\.zsh_history|credentials(?:\..*)?|wallet\.dat|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|.*\.(?:pem|key|p12|pfx|kdbx|keystore|jks|ppk|asc|gpg)|.*(?:secret|credential|token|password).*)$/i;

function slashed(value: string): string {
  return value.split(path.sep).join('/').replace(/\\/g, '/');
}

/** 被拒绝时返回原因；放行返回 undefined。 */
export function externalDenyReason(absolute: string): string | undefined {
  const normalized = slashed(path.resolve(absolute));
  if (SYSTEM_PATHS.some((pattern) => pattern.test(normalized))) return '系统目录不允许读取。';
  if (SECRET_SEGMENTS.some((pattern) => pattern.test(normalized))) return '密钥、凭据或浏览器资料目录不允许读取。';
  if (SECRET_NAMES.test(path.basename(normalized))) return '疑似密钥或凭据文件不允许读取。';
  return undefined;
}

function isInsideWorkspace(absolute: string): boolean {
  const target = path.resolve(absolute).toLowerCase();
  return (vscode.workspace.workspaceFolders ?? []).some((folder) => {
    if (folder.uri.scheme !== 'file') return false;
    const root = path.resolve(folder.uri.fsPath).toLowerCase();
    return target === root || target.startsWith(root + path.sep);
  });
}

/** 校验并解析项目外路径：必须是本机绝对路径、不在工作区内、解析符号链接后仍不在拒绝清单里。 */
export async function resolveExternalPath(value: unknown): Promise<string> {
  if (typeof value !== 'string' || !value.trim() || value.length > 1024 || value.includes('\0')) {
    throw new WorkspaceRequestError('INVALID_PATH', '请提供项目外文件的完整绝对路径。');
  }
  const raw = value.trim();
  const isWindowsAbsolute = /^[a-zA-Z]:[\\/]/.test(raw);
  if (raw.startsWith('\\\\') || raw.startsWith('//')) throw new WorkspaceRequestError('INVALID_PATH', '不支持网络共享路径。');
  if (!(isWindowsAbsolute || (process.platform !== 'win32' && raw.startsWith('/')))) {
    throw new WorkspaceRequestError('INVALID_PATH', '项目外路径必须是本机绝对路径（例如 D:\\notes\\a.md）。');
  }
  const absolute = path.resolve(raw);
  if (isInsideWorkspace(absolute)) {
    throw new WorkspaceRequestError('EXTERNAL_PATH_IN_WORKSPACE', '这个路径在当前工作区内，请用项目文件工具读取。');
  }
  const denied = externalDenyReason(absolute);
  if (denied) throw new WorkspaceRequestError('EXTERNAL_PATH_DENIED', denied);
  let real: string;
  try {
    real = await fs.realpath(absolute);
  } catch {
    throw new WorkspaceRequestError('FILE_NOT_FOUND', `路径不存在：${absolute}`);
  }
  const deniedReal = externalDenyReason(real);
  if (deniedReal) throw new WorkspaceRequestError('EXTERNAL_PATH_DENIED', `${deniedReal}（符号链接指向受保护位置）`);
  if (isInsideWorkspace(real)) throw new WorkspaceRequestError('EXTERNAL_PATH_IN_WORKSPACE', '这个路径指向当前工作区，请用项目文件工具读取。');
  return real;
}

export async function describeExternalTarget(absolute: string): Promise<{ type: 'file' | 'directory'; size: number }> {
  const stat = await fs.stat(absolute);
  if (stat.isDirectory()) return { type: 'directory', size: 0 };
  if (stat.isFile()) return { type: 'file', size: stat.size };
  throw new WorkspaceRequestError('FILE_NOT_FOUND', '目标不是普通文件或目录。');
}

export async function readExternalFile(absolute: string, startLine?: unknown, endLine?: unknown): Promise<Record<string, unknown>> {
  const stat = await fs.stat(absolute);
  if (!stat.isFile()) throw new WorkspaceRequestError('FILE_NOT_FOUND', '目标不是普通文件。');
  if (stat.size > MAX_FILE_BYTES) throw new WorkspaceRequestError('FILE_TOO_LARGE', '文件超过 2 MB，不读取。');
  const buffer = await fs.readFile(absolute);
  if (buffer.subarray(0, 8192).includes(0)) throw new WorkspaceRequestError('BINARY_FILE', '这是二进制文件，不读取。');
  const lines = buffer.toString('utf8').split(/\r?\n/);
  const start = typeof startLine === 'number' && startLine >= 1 ? Math.floor(startLine) : 1;
  const end = typeof endLine === 'number' && endLine >= start ? Math.min(Math.floor(endLine), lines.length) : lines.length;
  let content = lines.slice(start - 1, end).join('\n');
  const truncated = content.length > MAX_CONTENT_CHARS;
  if (truncated) content = content.slice(0, MAX_CONTENT_CHARS);
  return { success: true, path: absolute, external: true, content, startLine: start, endLine: end, totalLines: lines.length, truncated };
}

export async function listExternalDirectory(absolute: string): Promise<Record<string, unknown>> {
  const entries = await fs.readdir(absolute, { withFileTypes: true });
  const visible = [];
  let hidden = 0;
  for (const entry of entries) {
    if (externalDenyReason(path.join(absolute, entry.name))) {
      hidden += 1;
      continue;
    }
    visible.push({ name: entry.name, type: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other' });
  }
  return {
    success: true, path: absolute, external: true,
    entries: visible.slice(0, MAX_ENTRIES), total: visible.length, truncated: visible.length > MAX_ENTRIES,
    hiddenProtected: hidden,
  };
}
