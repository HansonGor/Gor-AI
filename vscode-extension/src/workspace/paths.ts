import * as vscode from 'vscode';

export class WorkspaceRequestError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'WorkspaceRequestError';
  }
}

const EXCLUDED_SEGMENTS = new Set([
  'node_modules', '.git', 'dist', 'build', 'coverage', 'out', 'vendor',
  '.next', '.nuxt', '.turbo', '.cache', '.venv', 'venv', '__pycache__',
]);
const SECRET_NAME = /^(?:\.env(?:\..*)?|.*(?:secret|credential|private.?key|id_rsa|id_ed25519).*$|.*\.(?:pem|key))$/i;

export function normalizeWorkspaceRelativePath(value: unknown, allowEmpty = false, allowGitMetadata = false): string {
  if (typeof value !== 'string' || value.length > 2048 || value.includes('\\') || value.includes('\0')) {
    throw new WorkspaceRequestError('INVALID_PATH', '路径必须是工作区内的相对路径。');
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(value) || /^[a-z]:/i.test(value) || value.startsWith('//')) {
    throw new WorkspaceRequestError('INVALID_PATH', '不允许绝对路径或 URI。');
  }

  let normalized = value.startsWith('/') ? value.slice(1) : value;
  if (normalized.endsWith('/')) normalized = normalized.slice(0, -1);
  if (!normalized && allowEmpty) return '';
  const segments = normalized.split('/');
  if (!normalized || segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new WorkspaceRequestError('INVALID_PATH', '路径包含空段或路径穿越。');
  }
  if (segments.some((segment) => /[\u0000-\u001f:]/.test(segment)
    || (EXCLUDED_SEGMENTS.has(segment.toLowerCase()) && !(allowGitMetadata && segment.toLowerCase() === '.git'))
    || SECRET_NAME.test(segment))) {
    throw new WorkspaceRequestError('INVALID_PATH', '该路径属于排除目录或敏感文件。');
  }
  return `/${segments.join('/')}`;
}

export function isUriWithinWorkspaceRoot(uri: vscode.Uri, root: vscode.WorkspaceFolder): boolean {
  if (uri.scheme !== root.uri.scheme || uri.authority !== root.uri.authority) return false;
  const rootPath = root.uri.path.replace(/\/$/, '');
  const candidate = uri.path;
  return candidate === rootPath || candidate.startsWith(`${rootPath}/`);
}

export function describeWorkspaceRoots(): Array<{ id: string; name: string }> {
  return (vscode.workspace.workspaceFolders ?? []).map((folder, index) => ({
    id: `root-${index + 1}`,
    name: folder.name,
  }));
}

export function selectWorkspaceRoot(requestedRoot?: unknown): vscode.WorkspaceFolder {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) {
    throw new WorkspaceRequestError('WORKSPACE_NOT_FOUND', 'VS Code 当前没有打开的工作区文件夹。');
  }
  if (requestedRoot === undefined || requestedRoot === null || requestedRoot === '') {
    if (folders.length === 1) return folders[0];
    const options = describeWorkspaceRoots().map((root) => `${root.id}=${root.name}`).join(', ');
    throw new WorkspaceRequestError('WORKSPACE_ROOT_REQUIRED', `当前是多根工作区，请指定 root。可选：${options}`);
  }
  if (typeof requestedRoot !== 'string') {
    throw new WorkspaceRequestError('WORKSPACE_ROOT_REQUIRED', 'root 必须是工作区根目录名称或 root id。');
  }

  const matches = folders.filter((folder, index) =>
    requestedRoot === `root-${index + 1}` || requestedRoot === folder.name,
  );
  if (matches.length === 1) return matches[0];
  const options = describeWorkspaceRoots().map((root) => `${root.id}=${root.name}`).join(', ');
  if (matches.length > 1) {
    throw new WorkspaceRequestError('WORKSPACE_ROOT_REQUIRED', `root 名称不唯一，请使用 root id。可选：${options}`);
  }
  throw new WorkspaceRequestError('WORKSPACE_ROOT_REQUIRED', `找不到指定 root。可选：${options}`);
}

export function workspaceRelativePath(uri: vscode.Uri, root: vscode.WorkspaceFolder): string {
  if (!isUriWithinWorkspaceRoot(uri, root)) {
    throw new WorkspaceRequestError('INVALID_PATH', '请求路径不在指定工作区根目录内。');
  }
  const rootPath = root.uri.path.replace(/\/$/, '');
  const relative = uri.path.slice(rootPath.length).replace(/^\//, '');
  return normalizeWorkspaceRelativePath(relative);
}

export function toWorkspaceUri(relativePath: string, root: vscode.WorkspaceFolder, allowGitMetadata = false): vscode.Uri {
  const normalized = normalizeWorkspaceRelativePath(relativePath, false, allowGitMetadata);
  const uri = vscode.Uri.joinPath(root.uri, ...normalized.slice(1).split('/'));
  if (!isUriWithinWorkspaceRoot(uri, root)) {
    throw new WorkspaceRequestError('INVALID_PATH', '请求路径解析后超出工作区范围。');
  }
  return uri;
}
