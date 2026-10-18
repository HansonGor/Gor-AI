import * as path from 'node:path';
import * as vscode from 'vscode';
import { isUriWithinWorkspaceRoot, normalizeWorkspaceRelativePath, selectWorkspaceRoot, toWorkspaceUri, WorkspaceRequestError } from './paths';

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
  pull(): Promise<void>;
  fetch(): Promise<void>;
  createBranch(name: string, checkout: boolean): Promise<void>;
  deleteBranch(name: string, force?: boolean): Promise<void>;
  checkout(treeish: string): Promise<void>;
  clean(paths: string[]): Promise<void>;
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

/** 一次准备好的 Git 写操作：先展示、再由工具链框架决定是否确认，最后复检并执行。 */
export type PreparedGitOperation = {
  command: string;
  details: string[];
  /** 会在本操作中自动执行的 Git 钩子文件（用于风险研判）。 */
  hookFiles: string[];
  fingerprint: () => Promise<string>;
  execute: (input?: { message?: string }) => Promise<Record<string, unknown>>;
  /** 这次操作的影响说明；不提供时用动作的默认说明。 */
  effects?: string[];
  /** 可在确认时改写的字段（提交说明）。 */
  editable?: { field: 'message'; label: string; value: string };
};

function hookFiles(repo: GitRepository, names: string[]): string[] {
  const base = repo.rootUri.fsPath;
  return names.flatMap((name) => [path.join(base, '.git', 'hooks', name), path.join(base, '.husky', name)]);
}

async function readCommitPaths(params: Params): Promise<string[] | null> {
  if (params.paths === undefined || params.paths === null) return null;
  if (!Array.isArray(params.paths) || !params.paths.length || params.paths.length > 500) {
    throw new WorkspaceRequestError('INVALID_PATH', 'paths 必须是 1–500 个工作区相对路径。');
  }
  return [...new Set(params.paths.map((p) => normalizeWorkspaceRelativePath(p, false, false)))];
}

export async function prepareCommit(params: Params): Promise<PreparedGitOperation> {
  const message = typeof params.message === 'string' ? params.message.trim() : '';
  if (!message) throw new WorkspaceRequestError('GIT_MESSAGE_REQUIRED', '提交说明不能为空。');
  if (message.length > MAX_MESSAGE_CHARS) throw new WorkspaceRequestError('GIT_MESSAGE_TOO_LONG', '提交说明过长。');
  const requested = await readCommitPaths(params);
  const { root, repo } = await openRepository(params);
  if (!repo.state.HEAD?.name) throw new WorkspaceRequestError('GIT_DETACHED_HEAD', '当前处于游离 HEAD 状态，请先切换到分支。');
  requireNoBlockers(repo, root);
  const plan = commitPlan(repo, root, requested);
  const branch = repo.state.HEAD.name;
  const push: CommitPush = params.push === false ? { planned: false, note: '只提交到本地，不推送。' } : planCommitPush(repo);
  const fingerprint = async () => {
    await repo.status();
    requireNoBlockers(repo, root);
    return `${repo.state.HEAD?.name}\n${signature(commitPlan(repo, root, requested).files)}`;
  };
  return {
    command: `git commit${push.planned ? ' + push' : ''}（${plan.files.length} 个文件 → ${branch}）`,
    details: [`分支：${branch}`, `提交说明：${message}`, push.planned ? `提交后推送到 ${push.remote}/${branch}${push.setUpstream ? '（该分支尚无上游，将设置上游）' : ''}` : push.note,
      '文件：', ...fileLines(plan.files).split('\n')],
    hookFiles: hookFiles(repo, ['pre-commit', 'prepare-commit-msg', 'commit-msg', 'post-commit', ...(push.planned ? ['pre-push'] : [])]),
    fingerprint,
    effects: push.planned ? ['会新建一个提交', '提交后推送到远端，推送后其他人可见'] : ['会在本地仓库新建一个提交'],
    editable: { field: 'message', label: '提交说明', value: message },
    async execute(input) {
      const finalMessage = input?.message?.trim() || message;
      if (finalMessage.length > MAX_MESSAGE_CHARS) throw new WorkspaceRequestError('GIT_MESSAGE_TOO_LONG', '提交说明过长。');
      // 确认期间仓库可能被修改：框架已比对指纹，这里再按最新状态取文件。
      const fresh = commitPlan(repo, root, requested);
      if (fresh.toStage.length) await repo.add(fresh.toStage.map((e) => e.uri.fsPath));
      try {
        await repo.commit(finalMessage);
      } catch (error) {
        throw new WorkspaceRequestError('GIT_COMMIT_FAILED', `git commit 失败：${redactCredentials(errorText(error))}`);
      }
      await repo.status();
      const committed = {
        committed: true, branch, commit: repo.state.HEAD?.commit ?? null, message: finalMessage,
        files: fresh.files.map(({ path: file, status }) => ({ path: file, status })),
      };
      if (!push.planned) {
        return { ...committed, pushed: false, pushSkipped: push.note, ahead: repo.state.HEAD?.ahead ?? null, upstream: branchInfo(repo).upstream };
      }
      // 提交已经完成；推送失败不回滚提交，只如实报告。永不强制推送。
      try {
        await repo.push(push.remote, branch, push.setUpstream);
      } catch (error) {
        await repo.status();
        return { ...committed, pushed: false, pushError: `git push 失败：${redactCredentials(errorText(error))}`,
          ahead: repo.state.HEAD?.ahead ?? null, upstream: branchInfo(repo).upstream };
      }
      await repo.status();
      return { ...committed, pushed: true, remote: push.remote, setUpstream: push.setUpstream,
        ahead: repo.state.HEAD?.ahead ?? null, upstream: branchInfo(repo).upstream };
    },
  };
}

/** 提交后要推送到哪里：沿用上游，否则 origin（或唯一远端）并设置上游；没有远端或落后远端时只提交本地。 */
type CommitPush = { planned: true; remote: string; setUpstream: boolean } | { planned: false; note: string };

function planCommitPush(repo: GitRepository): CommitPush {
  const head = repo.state.HEAD;
  const remotes = repo.state.remotes;
  if (!remotes.length) return { planned: false, note: '仓库没有配置远端，只提交到本地。' };
  if (head?.upstream) {
    if ((head.behind ?? 0) > 0) {
      return { planned: false, note: `本地分支落后远端 ${head.behind} 个提交，推送会被拒绝；只提交到本地，请先拉取再推送。` };
    }
    return { planned: true, remote: head.upstream.remote, setUpstream: false };
  }
  const remote = remotes.some((item) => item.name === 'origin') ? 'origin' : remotes.length === 1 ? remotes[0].name : null;
  if (!remote) return { planned: false, note: `有多个远端（${remotes.map((item) => item.name).join('、')}），未指定推送目标，只提交到本地。` };
  return { planned: true, remote, setUpstream: true };
}

/** 没有需要推送的提交时返回结果对象，不需要确认。 */
export async function preparePush(params: Params): Promise<PreparedGitOperation | Record<string, unknown>> {
  if (params.force === true) {
    throw new WorkspaceRequestError('GIT_FORCE_PUSH_REJECTED', 'Gor 不会强制推送（可能覆盖他人的提交）。如确有需要，请在终端手动执行。');
  }
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
      `本地分支落后远端 ${head.behind} 个提交，推送会被拒绝。请先拉取并处理后再推送（Gor 不会强制推送）。`);
  }

  const count = head.upstream ? head.ahead ?? 0 : null;
  const commits = (await repo.log({ maxEntries: Math.min(count ?? 10, 10) }).catch(() => []))
    .map((c) => `  ${c.hash.slice(0, 8)} ${c.message.split('\n')[0].slice(0, 120)}`);
  const remote = remotes.find((r) => r.name === remoteName);
  const url = redactCredentials(remote?.pushUrl ?? remote?.fetchUrl ?? '');
  return {
    command: `git push ${remoteName} ${branch}`,
    details: [
      count === null ? `该分支尚无上游，将推送并设置上游 ${remoteName}/${branch}。` : `将推送 ${count} 个提交：`,
      ...commits,
      ...(url ? [`远端地址：${url}`] : []),
      '推送后其他人可见。不会强制推送。',
    ],
    hookFiles: hookFiles(repo, ['pre-push']),
    fingerprint: async () => {
      await repo.status();
      return `${repo.state.HEAD?.name}\n${repo.state.HEAD?.commit}`;
    },
    async execute() {
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
    },
  };
}

export async function gitLog(params: Params): Promise<Record<string, unknown>> {
  const { repo } = await openRepository(params);
  const count = typeof params.count === 'number' && params.count > 0 ? Math.min(Math.floor(params.count), 50) : 10;
  const commits = await repo.log({ maxEntries: count }).catch(() => []);
  return {
    ...branchInfo(repo),
    commits: commits.map((c) => ({ hash: c.hash.slice(0, 12), subject: c.message.split('\n')[0].slice(0, 200) })),
  };
}

const BRANCH_NAME = /^(?!\/|.*(?:\/\.|\/\/|\.\.|@\{|\\))[^\s~^:?*[\x00-\x1f\x7f]{1,200}(?<![./]|\.lock)$/;

function branchName(value: unknown): string {
  if (typeof value !== 'string' || !BRANCH_NAME.test(value.trim()) || value.trim().startsWith('-')) {
    throw new WorkspaceRequestError('INVALID_PARAMS', '分支名无效。');
  }
  return value.trim();
}

/** 新建 / 切换 / 删除分支、拉取、获取、放弃改动：都返回准备好的操作，由框架决定是否确认。 */
export async function prepareBranchOperation(action: string, params: Params): Promise<PreparedGitOperation> {
  const { root, repo } = await openRepository(params);
  const head = repo.state.HEAD?.name ?? '（游离 HEAD）';
  const headFingerprint = async () => {
    await repo.status();
    return `${repo.state.HEAD?.name}\n${repo.state.HEAD?.commit}`;
  };
  const wrap = async (label: string, run: () => Promise<unknown>) => {
    try {
      await run();
    } catch (error) {
      throw new WorkspaceRequestError('GIT_OPERATION_FAILED', `${label}失败：${redactCredentials(errorText(error))}`);
    }
    await repo.status();
  };
  switch (action) {
    case 'pull':
      return {
        command: `git pull（${head}）`, details: [`当前分支：${head}`, branchInfo(repo).upstream ? `上游：${branchInfo(repo).upstream}` : '该分支没有上游'],
        hookFiles: hookFiles(repo, ['post-merge', 'post-checkout']), fingerprint: headFingerprint,
        async execute() { await wrap('git pull ', () => repo.pull()); return { pulled: true, ...branchInfo(repo) }; },
      };
    case 'fetch':
      return {
        command: 'git fetch', details: [`远端：${repo.state.remotes.map((r) => r.name).join('、') || '无'}`],
        hookFiles: [], fingerprint: headFingerprint,
        async execute() { await wrap('git fetch ', () => repo.fetch()); return { fetched: true, ...branchInfo(repo) }; },
      };
    case 'create_branch': {
      const name = branchName(params.name);
      const checkout = params.checkout !== false;
      return {
        command: `git branch ${name}${checkout ? '（并切换过去）' : ''}`, details: [`从 ${head} 新建分支 ${name}`],
        hookFiles: checkout ? hookFiles(repo, ['post-checkout']) : [], fingerprint: headFingerprint,
        async execute() { await wrap('新建分支', () => repo.createBranch(name, checkout)); return { created: name, checkedOut: checkout, ...branchInfo(repo) }; },
      };
    }
    case 'switch_branch': {
      const name = branchName(params.name);
      requireNoBlockers(repo, root);
      return {
        command: `git checkout ${name}`, details: [`从 ${head} 切换到 ${name}`, '未提交的改动会随之带到新分支；有冲突时 Git 会拒绝切换。'],
        hookFiles: hookFiles(repo, ['post-checkout']), fingerprint: headFingerprint,
        async execute() { await wrap('切换分支', () => repo.checkout(name)); return { switched: name, ...branchInfo(repo) }; },
      };
    }
    case 'delete_branch': {
      const name = branchName(params.name);
      if (name === repo.state.HEAD?.name) {
        throw new WorkspaceRequestError('GIT_DELETE_CURRENT_BRANCH', '不能删除当前所在的分支，请先切换到其他分支。');
      }
      const force = params.force === true;
      return {
        command: `git branch ${force ? '-D' : '-d'} ${name}`,
        details: [`删除本地分支 ${name}`, force ? '强制删除：分支上未合并的提交会丢失。' : '只删除已合并的分支；未合并时 Git 会拒绝。', '不会删除远端分支。'],
        hookFiles: [], fingerprint: headFingerprint,
        async execute() { await wrap('删除分支', () => repo.deleteBranch(name, force)); return { deleted: name, ...branchInfo(repo) }; },
      };
    }
    case 'discard': {
      const paths = await readCommitPaths(params);
      if (!paths) throw new WorkspaceRequestError('INVALID_PATH', '请用 paths 指定要放弃改动的文件。');
      const uris = paths.map((file) => toWorkspaceUri(file, root));
      return {
        command: `放弃 ${paths.length} 个文件的未提交改动`,
        details: ['以下文件将恢复到最近一次提交的内容（未跟踪的文件会被删除）：', ...paths.slice(0, 30).map((file) => `  ${file}`)],
        hookFiles: [], fingerprint: async () => { await repo.status(); return signature(changeSets(repo, root).unstaged); },
        async execute() { await wrap('放弃改动', () => repo.clean(uris.map((uri) => uri.fsPath))); return { discarded: paths }; },
      };
    }
    default:
      throw new WorkspaceRequestError('TOOLCHAIN_ACTION_NOT_SUPPORTED', `git 没有动作 ${action}。`);
  }
}

function errorText(error: unknown): string {
  if (error && typeof error === 'object') {
    const value = error as { stderr?: unknown; message?: unknown; gitErrorCode?: unknown };
    const text = [value.stderr, value.message, value.gitErrorCode].find((v) => typeof v === 'string' && v.trim());
    if (typeof text === 'string') return text.trim().slice(0, 600);
  }
  return '未知错误';
}
