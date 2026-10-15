import * as vscode from 'vscode';
import { isUriWithinWorkspaceRoot, normalizeWorkspaceRelativePath, selectWorkspaceRoot, WorkspaceRequestError } from './paths';

// 只声明本模块用到的 VS Code 内置 Git 扩展 API（vscode.git，API 版本 1）。
type GitChange = { uri: vscode.Uri; originalUri?: vscode.Uri; renameUri?: vscode.Uri; status: number };
type GitBranch = { name?: string; commit?: string; upstream?: { remote: string; name: string }; ahead?: number; behind?: number };
type GitRemote = { name: string; fetchUrl?: string; pushUrl?: string };
type GitCommit = { hash: string; message: string };
type GitRepository = {
  rootUri: vscode.Uri;
  state: {
    HEAD?: GitBranch;
    remotes: GitRemote[];
    indexChanges: GitChange[];
    workingTreeChanges: GitChange[];
    untrackedChanges?: GitChange[];
    mergeChanges: GitChange[];
  };
  status(): Promise<void>;
  add(paths: string[]): Promise<void>;
  commit(message: string, opts?: Record<string, unknown>): Promise<void>;
  push(remoteName?: string, branchName?: string, setUpstream?: boolean): Promise<void>;
  log(options?: { maxEntries?: number }): Promise<GitCommit[]>;
  diffWithHEAD(path: string): Promise<string>;
  diffIndexWithHEAD(path: string): Promise<string>;
};
type GitAPI = { getRepository(uri: vscode.Uri): GitRepository | null };

type Params = Record<string, unknown>;
type Entry = { path: string; status: string; uri: vscode.Uri; outside: boolean; sensitive: boolean };

const MAX_LISTED = 200;
const MAX_DIFF_CHARS = 16_000;
const MAX_MESSAGE_CHARS = 5_000;
const SENSITIVE_NAME = /^(?:\.env(?:\..*)?|.*(?:secret|credential|private.?key|id_rsa|id_ed25519).*|.*\.(?:pem|key|p12|pfx))$/i;

const STATUS_LABELS: Record<number, string> = {
  0: 'modified', 1: 'added', 2: 'deleted', 3: 'renamed', 4: 'copied', 5: 'modified', 6: 'deleted',
  7: 'untracked', 8: 'ignored', 9: 'added', 10: 'renamed', 11: 'type_changed',
  12: 'conflict', 13: 'conflict', 14: 'conflict', 15: 'conflict', 16: 'conflict', 17: 'conflict', 18: 'conflict',
};

export type Confirm = (message: string, detail: string, ...actions: string[]) => Promise<string | undefined>;
export type AskMessage = (value: string) => Promise<string | undefined>;

// 确认交互集中在这里，测试可替换；纯模型请求不能绕过它直接提交或推送。
export const gitUi: { confirm: Confirm; askMessage: AskMessage } = {
  confirm: (message, detail, ...actions) =>
    Promise.resolve(vscode.window.showWarningMessage(message, { modal: true, detail }, ...actions)),
  askMessage: (value) => Promise.resolve(vscode.window.showInputBox({
    title: 'Gor 提交说明', prompt: '修改后按回车返回确认；按 Esc 取消提交。', value, ignoreFocusOut: true,
    validateInput: (text) => (text.trim() ? undefined : '提交说明不能为空'),
  })),
};

async function gitApi(): Promise<GitAPI> {
  const extension = vscode.extensions.getExtension<{ getAPI(version: 1): GitAPI }>('vscode.git');
  if (!extension) throw new WorkspaceRequestError('GIT_UNAVAILABLE', 'VS Code 内置 Git 扩展未启用。');
  const exports = extension.isActive ? extension.exports : await extension.activate();
  try {
    return exports.getAPI(1);
  } catch {
    throw new WorkspaceRequestError('GIT_UNAVAILABLE', 'VS Code Git 功能已被禁用（git.enabled=false）。');
  }
}

async function openRepository(params: Params): Promise<{ root: vscode.WorkspaceFolder; repo: GitRepository }> {
  const root = selectWorkspaceRoot(params.root);
  const repo = (await gitApi()).getRepository(root.uri);
  if (!repo) throw new WorkspaceRequestError('GIT_REPOSITORY_NOT_FOUND', '当前工作区不在 Git 仓库中。');
  await repo.status();
  return { root, repo };
}

/** 去掉远端地址中的用户名/令牌，避免出现在回执、日志或弹窗中。 */
export function redactCredentials(text: string): string {
  return text.replace(/([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/gi, '$1');
}

function describe(change: GitChange, root: vscode.WorkspaceFolder): Entry {
  const uri = change.renameUri ?? change.uri;
  const outside = !isUriWithinWorkspaceRoot(uri, root);
  const rootPath = root.uri.path.replace(/\/$/, '');
  const path = outside ? '' : `/${uri.path.slice(rootPath.length).replace(/^\//, '')}`;
  const name = uri.path.split('/').pop() ?? '';
  return { path, status: STATUS_LABELS[change.status] ?? 'changed', uri, outside, sensitive: SENSITIVE_NAME.test(name) };
}

function untracked(repo: GitRepository): GitChange[] {
  return repo.state.untrackedChanges ?? [];
}

function changeSets(repo: GitRepository, root: vscode.WorkspaceFolder) {
  const staged = repo.state.indexChanges.map((c) => describe(c, root));
  const unstaged = repo.state.workingTreeChanges.map((c) => describe(c, root));
  const untrackedEntries = untracked(repo).map((c) => describe(c, root));
  const conflicts = repo.state.mergeChanges.map((c) => describe(c, root));
  return { staged, unstaged, untracked: untrackedEntries, conflicts };
}

function listForResult(entries: Entry[]) {
  const visible = entries.filter((e) => !e.outside);
  return {
    files: visible.slice(0, MAX_LISTED).map(({ path, status }) => ({ path, status })),
    total: visible.length,
    truncated: visible.length > MAX_LISTED,
    outsideWorkspace: entries.length - visible.length,
  };
}

function branchInfo(repo: GitRepository) {
  const head = repo.state.HEAD;
  return {
    branch: head?.name ?? null,
    detached: !head?.name,
    commit: head?.commit ?? null,
    upstream: head?.upstream ? `${head.upstream.remote}/${head.upstream.name}` : null,
    ahead: head?.ahead ?? null,
    behind: head?.behind ?? null,
    remotes: repo.state.remotes.map((remote) => remote.name),
  };
}

function dirtyDocumentsIn(root: vscode.WorkspaceFolder): string[] {
  return vscode.workspace.textDocuments
    .filter((document) => document.isDirty && isUriWithinWorkspaceRoot(document.uri, root))
    .map((document) => describe({ uri: document.uri, status: 5 }, root).path);
}

export async function gitStatus(params: Params): Promise<Record<string, unknown>> {
  const { root, repo } = await openRepository(params);
  const sets = changeSets(repo, root);
  const result: Record<string, unknown> = {
    ...branchInfo(repo),
    staged: listForResult(sets.staged),
    unstaged: listForResult(sets.unstaged),
    untracked: listForResult(sets.untracked),
    conflicts: listForResult(sets.conflicts),
    dirtyDocuments: dirtyDocumentsIn(root),
    recentCommits: (await repo.log({ maxEntries: 5 }).catch(() => [])).map((c) => ({
      hash: c.hash.slice(0, 12), subject: c.message.split('\n')[0].slice(0, 200),
    })),
  };
  if (params.includeDiff === true) {
    // 只拼接工作区内、非敏感文件的差异，总量受限；未跟踪文件没有基准版本，不在此列出差异。
    let budget = MAX_DIFF_CHARS;
    const parts: string[] = [];
    let truncated = false;
    for (const [entries, cached] of [[sets.staged, true], [sets.unstaged, false]] as const) {
      for (const entry of entries) {
        if (entry.outside || entry.sensitive || entry.status === 'untracked') continue;
        if (budget <= 0) { truncated = true; break; }
        const text = cached ? await repo.diffIndexWithHEAD(entry.uri.fsPath) : await repo.diffWithHEAD(entry.uri.fsPath);
        parts.push(`${cached ? '[已暂存]' : '[未暂存]'} ${entry.path}\n${text.slice(0, budget)}`);
        if (text.length > budget) truncated = true;
        budget -= text.length;
      }
    }
    result.diff = parts.join('\n');
    result.diffTruncated = truncated;
  }
  return result;
}

function requireNoBlockers(repo: GitRepository, root: vscode.WorkspaceFolder) {
  if (repo.state.mergeChanges.length) {
    throw new WorkspaceRequestError('GIT_CONFLICTS', '仓库存在未解决的合并冲突，请先在 VS Code 中解决后再提交。');
  }
  const dirty = dirtyDocumentsIn(root);
  if (dirty.length) {
    throw new WorkspaceRequestError('DIRTY_DOCUMENTS', `有未保存的文件，提交不会包含这些修改。请先保存：${dirty.slice(0, 10).join('、')}`,
      { dirtyDocuments: dirty });
  }
}

/** 计算本次提交将包含的文件（已暂存 ∪ 请求的文件）。 */
function commitPlan(repo: GitRepository, root: vscode.WorkspaceFolder, requested: string[] | null) {
  const sets = changeSets(repo, root);
  const pending = [...sets.unstaged, ...sets.untracked];
  let toStage: Entry[];
  if (requested) {
    const byPath = new Map(pending.filter((e) => !e.outside).map((e) => [e.path, e]));
    const stagedPaths = new Set(sets.staged.map((e) => e.path));
    toStage = [];
    for (const path of requested) {
      const entry = byPath.get(path);
      if (entry) toStage.push(entry);
      else if (!stagedPaths.has(path)) {
        throw new WorkspaceRequestError('GIT_PATH_NOT_CHANGED', `文件没有可提交的改动：${path}`);
      }
    }
    const extraStaged = sets.staged.filter((e) => !requested.includes(e.path));
    if (extraStaged.length) {
      throw new WorkspaceRequestError('GIT_STAGED_OUTSIDE_REQUEST',
        `暂存区里还有未指定的文件，会被一起提交：${extraStaged.slice(0, 10).map((e) => e.path || '(工作区外)').join('、')}。请指定完整文件列表，或先在 VS Code 中取消暂存。`);
    }
  } else {
    toStage = pending;
  }
  const files = [...sets.staged, ...toStage.filter((e) => !sets.staged.some((s) => s.path === e.path && !s.outside))];
  if (!files.length) throw new WorkspaceRequestError('GIT_NOTHING_TO_COMMIT', '没有可提交的改动。');
  const outside = files.filter((e) => e.outside);
  if (outside.length) {
    throw new WorkspaceRequestError('GIT_OUTSIDE_WORKSPACE',
      `有 ${outside.length} 个改动位于当前工作区文件夹之外，Gor 不能代为提交，请在 VS Code 中手动处理。`);
  }
  const sensitive = files.filter((e) => e.sensitive);
  if (sensitive.length) {
    throw new WorkspaceRequestError('GIT_SENSITIVE_FILE',
      `提交内容包含疑似密钥/敏感文件，Gor 不会代为提交：${sensitive.map((e) => e.path).join('、')}。如确需提交请手动操作，或加入 .gitignore。`);
  }
  return { files, toStage };
}

function fileLines(entries: Entry[]): string {
  const lines = entries.slice(0, 30).map((e) => `  ${e.status.padEnd(9)} ${e.path}`);
  if (entries.length > 30) lines.push(`  ……另有 ${entries.length - 30} 个文件`);
  return lines.join('\n');
}

function signature(entries: Entry[]): string {
  return entries.map((e) => `${e.status}:${e.path}`).sort().join('\n');
}

export async function gitCommit(params: Params): Promise<Record<string, unknown>> {
  let message = typeof params.message === 'string' ? params.message.trim() : '';
  if (!message) throw new WorkspaceRequestError('GIT_MESSAGE_REQUIRED', '提交说明不能为空。');
  if (message.length > MAX_MESSAGE_CHARS) throw new WorkspaceRequestError('GIT_MESSAGE_TOO_LONG', '提交说明过长。');
  let requested: string[] | null = null;
  if (params.paths !== undefined && params.paths !== null) {
    if (!Array.isArray(params.paths) || !params.paths.length || params.paths.length > 500) {
      throw new WorkspaceRequestError('INVALID_PATH', 'paths 必须是 1–500 个工作区相对路径。');
    }
    requested = [...new Set(params.paths.map((p) => normalizeWorkspaceRelativePath(p, false, false)))];
  }

  const { root, repo } = await openRepository(params);
  if (!repo.state.HEAD?.name) throw new WorkspaceRequestError('GIT_DETACHED_HEAD', '当前处于游离 HEAD 状态，请先切换到分支。');
  requireNoBlockers(repo, root);
  const plan = commitPlan(repo, root, requested);
  const branch = repo.state.HEAD.name;

  for (;;) {
    const choice = await gitUi.confirm(
      `Gor 请求提交 ${plan.files.length} 个文件到分支 ${branch}`,
      `提交说明：\n${message}\n\n文件：\n${fileLines(plan.files)}\n\n确认后将暂存以上文件并执行 git commit。`,
      '提交', '修改提交说明',
    );
    if (choice === '修改提交说明') {
      const edited = await gitUi.askMessage(message);
      if (edited === undefined) break;
      message = edited.trim() || message;
      continue;
    }
    if (choice !== '提交') break;

    // 确认期间仓库可能被修改：重新核对，变化则不执行
    await repo.status();
    requireNoBlockers(repo, root);
    const fresh = commitPlan(repo, root, requested);
    if (signature(fresh.files) !== signature(plan.files) || repo.state.HEAD?.name !== branch) {
      throw new WorkspaceRequestError('GIT_STATE_CHANGED', '确认期间仓库状态发生变化，未提交。请重新查看改动后再试。');
    }
    if (fresh.toStage.length) await repo.add(fresh.toStage.map((e) => e.uri.fsPath));
    try {
      await repo.commit(message);
    } catch (error) {
      throw new WorkspaceRequestError('GIT_COMMIT_FAILED', `git commit 失败：${redactCredentials(errorText(error))}`);
    }
    await repo.status();
    return {
      committed: true, branch, commit: repo.state.HEAD?.commit ?? null, message,
      files: fresh.files.map(({ path, status }) => ({ path, status })),
      ahead: repo.state.HEAD?.ahead ?? null, upstream: branchInfo(repo).upstream,
    };
  }
  throw new WorkspaceRequestError('USER_CANCELLED', '用户取消了提交，未做任何改动。');
}

export async function gitPush(params: Params): Promise<Record<string, unknown>> {
  const { repo } = await openRepository(params);
  const head = repo.state.HEAD;
  if (!head?.name) throw new WorkspaceRequestError('GIT_DETACHED_HEAD', '当前处于游离 HEAD 状态，无法推送。');
  const branch = head.name;
  const remotes = repo.state.remotes;
  if (!remotes.length) throw new WorkspaceRequestError('GIT_NO_REMOTE', '仓库没有配置远端（remote）。');

  const requestedRemote = typeof params.remote === 'string' && params.remote.trim() ? params.remote.trim() : null;
  let remoteName: string;
  let setUpstream = false;
  if (head.upstream && (!requestedRemote || requestedRemote === head.upstream.remote)) {
    remoteName = head.upstream.remote;
  } else {
    const chosen = requestedRemote ?? (remotes.some((r) => r.name === 'origin') ? 'origin' : remotes.length === 1 ? remotes[0].name : null);
    if (!chosen) {
      throw new WorkspaceRequestError('GIT_REMOTE_REQUIRED', `有多个远端，请指定 remote：${remotes.map((r) => r.name).join('、')}`);
    }
    if (!remotes.some((r) => r.name === chosen)) {
      throw new WorkspaceRequestError('GIT_REMOTE_NOT_FOUND', `找不到远端 ${chosen}，可选：${remotes.map((r) => r.name).join('、')}`);
    }
    remoteName = chosen;
    setUpstream = !head.upstream;
  }
  if (head.upstream && remoteName === head.upstream.remote && (head.ahead ?? 0) === 0) {
    return { pushed: false, reason: 'NOTHING_TO_PUSH', branch, remote: remoteName, message: '没有需要推送的提交。' };
  }
  if (head.upstream && (head.behind ?? 0) > 0) {
    throw new WorkspaceRequestError('GIT_BEHIND_REMOTE',
      `本地分支落后远端 ${head.behind} 个提交，推送会被拒绝。请先在 VS Code 中拉取并处理后再推送（Gor 不会强制推送）。`);
  }

  const count = head.upstream ? head.ahead ?? 0 : null;
  const commits = (await repo.log({ maxEntries: Math.min(count ?? 10, 10) }).catch(() => []))
    .map((c) => `  ${c.hash.slice(0, 8)} ${c.message.split('\n')[0].slice(0, 120)}`);
  const remote = remotes.find((r) => r.name === remoteName);
  const url = redactCredentials(remote?.pushUrl ?? remote?.fetchUrl ?? '');
  const choice = await gitUi.confirm(
    `Gor 请求推送分支 ${branch} 到 ${remoteName}`,
    [
      count === null ? `该分支尚无上游，将推送并设置上游 ${remoteName}/${branch}。` : `将推送 ${count} 个提交：`,
      ...commits,
      url ? `\n远端地址：${url}` : '',
      '推送后其他人可见。不会强制推送。',
    ].filter(Boolean).join('\n'),
    '推送',
  );
  if (choice !== '推送') throw new WorkspaceRequestError('USER_CANCELLED', '用户取消了推送，未做任何改动。');

  await repo.status();
  if (repo.state.HEAD?.name !== branch || repo.state.HEAD?.commit !== head.commit) {
    throw new WorkspaceRequestError('GIT_STATE_CHANGED', '确认期间分支或提交发生变化，未推送。请重新确认。');
  }
  try {
    await repo.push(remoteName, branch, setUpstream);
  } catch (error) {
    throw new WorkspaceRequestError('GIT_PUSH_FAILED', `git push 失败：${redactCredentials(errorText(error))}`);
  }
  await repo.status();
  return {
    pushed: true, branch, remote: remoteName, setUpstream, commit: repo.state.HEAD?.commit ?? head.commit ?? null,
    pushedCommits: count, upstream: branchInfo(repo).upstream,
  };
}

function errorText(error: unknown): string {
  if (error && typeof error === 'object') {
    const value = error as { stderr?: unknown; message?: unknown; gitErrorCode?: unknown };
    const text = [value.stderr, value.message, value.gitErrorCode].find((v) => typeof v === 'string' && v.trim());
    if (typeof text === 'string') return text.trim().slice(0, 600);
  }
  return '未知错误';
}
