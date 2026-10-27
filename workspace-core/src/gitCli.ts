import { execFile, execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { HostUri } from './host';

/**
 * 用本机 git 命令实现 git.ts 用到的那部分 VS Code Git 扩展 API（vscode.git，API 版本 1），
 * 供没有 VS Code 的宿主（桌面端书斋）复用同一套 Git 流程、风险研判与确认逻辑。
 * 状态码与 vscode.git 的 Status 枚举一致；命令不经 shell，提交说明经标准输入传入；
 * 设 GIT_TERMINAL_PROMPT=0，凭据沿用本机 Git 已有的凭据管理器，不在终端里等待输入。
 */

type Uri = HostUri;
type GitChange = { uri: Uri; originalUri?: Uri; renameUri?: Uri; status: number };
type GitBranch = { name?: string; commit?: string; upstream?: { remote: string; name: string }; ahead?: number; behind?: number };
type GitRemote = { name: string; fetchUrl?: string; pushUrl?: string };

export type CliGitRepository = {
  rootUri: Uri;
  state: {
    HEAD?: GitBranch;
    remotes: GitRemote[];
    indexChanges: GitChange[];
    workingTreeChanges: GitChange[];
    untrackedChanges: GitChange[];
    mergeChanges: GitChange[];
  };
  status(): Promise<void>;
  add(paths: string[]): Promise<void>;
  commit(message: string): Promise<void>;
  push(remoteName?: string, branchName?: string, setUpstream?: boolean): Promise<void>;
  log(options?: { maxEntries?: number }): Promise<Array<{ hash: string; message: string }>>;
  diffWithHEAD(file: string): Promise<string>;
  diffIndexWithHEAD(file: string): Promise<string>;
  pull(): Promise<void>;
  fetch(): Promise<void>;
  createBranch(name: string, checkout: boolean): Promise<void>;
  deleteBranch(name: string, force?: boolean): Promise<void>;
  checkout(treeish: string): Promise<void>;
  clean(paths: string[]): Promise<void>;
};

const LOCAL_TIMEOUT_MS = 60_000;
const NETWORK_TIMEOUT_MS = 5 * 60_000;
const MAX_OUTPUT = 32 * 1024 * 1024;

// porcelain v2 的 X（暂存区）/ Y（工作区）字母 → vscode.git Status
const INDEX_STATUS: Record<string, number> = { M: 0, A: 1, D: 2, R: 3, C: 4, T: 11 };
const WORKTREE_STATUS: Record<string, number> = { M: 5, D: 6, A: 9, T: 11, R: 10 };
const CONFLICT_STATUS: Record<string, number> = { AU: 12, UA: 13, DU: 14, UD: 15, AA: 16, DD: 17, UU: 18 };

function gitEnv(): NodeJS.ProcessEnv {
  return { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' };
}

function run(cwd: string, args: string[], options: { input?: string; timeoutMs?: number } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile('git', args, {
      cwd, env: gitEnv(), windowsHide: true, maxBuffer: MAX_OUTPUT, timeout: options.timeoutMs ?? LOCAL_TIMEOUT_MS, encoding: 'utf8',
    }, (error, stdout, stderr) => {
      if (error) {
        reject(Object.assign(new Error(String(stderr || error.message).trim() || `git ${args[0]} 失败`), { stderr: String(stderr ?? '') }));
        return;
      }
      resolve(String(stdout));
    });
    if (options.input !== undefined) {
      child.stdin?.end(options.input, 'utf8');
    }
  });
}

export function parsePorcelainV2(output: string, toUri: (relative: string) => Uri) {
  const head: GitBranch = {};
  const indexChanges: GitChange[] = [];
  const workingTreeChanges: GitChange[] = [];
  const untrackedChanges: GitChange[] = [];
  const mergeChanges: GitChange[] = [];
  const records = output.split('\0');
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record) continue;
    if (record.startsWith('# ')) {
      const [, key, ...rest] = record.split(' ');
      const value = rest.join(' ');
      if (key === 'branch.oid' && value !== '(initial)') head.commit = value;
      else if (key === 'branch.head' && value !== '(detached)') head.name = value;
      else if (key === 'branch.upstream') {
        const slash = value.indexOf('/');
        if (slash > 0) head.upstream = { remote: value.slice(0, slash), name: value.slice(slash + 1) };
      } else if (key === 'branch.ab') {
        const match = value.match(/^\+(\d+) -(\d+)$/);
        if (match) { head.ahead = Number(match[1]); head.behind = Number(match[2]); }
      }
      continue;
    }
    const kind = record[0];
    if (kind === '?') {
      untrackedChanges.push({ uri: toUri(record.slice(2)), status: 7 });
      continue;
    }
    if (kind === '1' || kind === '2') {
      const fields = record.split(' ');
      const xy = fields[1];
      const file = fields.slice(kind === '1' ? 8 : 9).join(' ');
      const uri = toUri(file);
      let originalUri: Uri | undefined;
      if (kind === '2') {
        index += 1;
        originalUri = toUri(records[index] ?? file);
      }
      const x = xy[0];
      const y = xy[1];
      if (x !== '.' && INDEX_STATUS[x] !== undefined) {
        indexChanges.push({ uri: originalUri ?? uri, ...(originalUri ? { originalUri, renameUri: uri } : {}), status: INDEX_STATUS[x] });
      }
      if (y !== '.' && WORKTREE_STATUS[y] !== undefined) workingTreeChanges.push({ uri, status: WORKTREE_STATUS[y] });
      continue;
    }
    if (kind === 'u') {
      const fields = record.split(' ');
      mergeChanges.push({ uri: toUri(fields.slice(10).join(' ')), status: CONFLICT_STATUS[fields[1]] ?? 18 });
    }
  }
  return { HEAD: head, indexChanges, workingTreeChanges, untrackedChanges, mergeChanges };
}

function parseRemotes(output: string): GitRemote[] {
  const remotes = new Map<string, GitRemote>();
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^(\S+)\s+(\S+)\s+\((fetch|push)\)$/);
    if (!match) continue;
    const remote = remotes.get(match[1]) ?? { name: match[1] };
    if (match[3] === 'fetch') remote.fetchUrl = match[2];
    else remote.pushUrl = match[2];
    remotes.set(match[1], remote);
  }
  return [...remotes.values()];
}

export function createCliRepository(topLevel: string, makeUri: (fsPath: string) => Uri): CliGitRepository {
  const toUri = (relative: string) => makeUri(path.join(topLevel, ...relative.split('/')));
  const git = (args: string[], options?: { input?: string; timeoutMs?: number }) => run(topLevel, args, options);
  const relativeArgs = (files: string[]) => files.map((file) => path.relative(topLevel, file).split(path.sep).join('/') || '.');
  const repo: CliGitRepository = {
    rootUri: makeUri(topLevel),
    state: { remotes: [], indexChanges: [], workingTreeChanges: [], untrackedChanges: [], mergeChanges: [] },
    async status() {
      const [status, remotes] = await Promise.all([
        git(['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all']),
        git(['remote', '-v']),
      ]);
      const parsed = parsePorcelainV2(status, toUri);
      const remoteList = parseRemotes(remotes);
      // 远端名可能含 /：按已知远端名重新拆分上游
      const upstreamText = parsed.HEAD.upstream ? `${parsed.HEAD.upstream.remote}/${parsed.HEAD.upstream.name}` : '';
      const remote = remoteList.map((item) => item.name).filter((name) => upstreamText.startsWith(`${name}/`))
        .sort((left, right) => right.length - left.length)[0];
      if (remote) parsed.HEAD.upstream = { remote, name: upstreamText.slice(remote.length + 1) };
      repo.state = { ...parsed, remotes: remoteList };
    },
    async add(files) { if (files.length) await git(['add', '--', ...relativeArgs(files)]); },
    async commit(message) { await git(['commit', '-F', '-'], { input: message }); },
    async push(remoteName, branchName, setUpstream) {
      await git(['push', ...(setUpstream ? ['--set-upstream'] : []), ...(remoteName ? [remoteName] : []), ...(branchName ? [branchName] : [])],
        { timeoutMs: NETWORK_TIMEOUT_MS });
    },
    async log(options) {
      const count = Math.max(1, Math.min(options?.maxEntries ?? 32, 200));
      const output = await git(['log', `-n${count}`, '--format=%H%x1f%B%x1e']).catch(() => '');
      return output.split('\x1e').map((item) => item.replace(/^\s+/, '')).filter(Boolean).map((item) => {
        const [hash, ...message] = item.split('\x1f');
        return { hash, message: message.join('\x1f').trim() };
      });
    },
    diffWithHEAD: (file) => git(['diff', 'HEAD', '--', ...relativeArgs([file])]),
    diffIndexWithHEAD: (file) => git(['diff', '--cached', '--', ...relativeArgs([file])]),
    async pull() { await git(['pull', '--no-edit'], { timeoutMs: NETWORK_TIMEOUT_MS }); },
    async fetch() { await git(['fetch'], { timeoutMs: NETWORK_TIMEOUT_MS }); },
    async createBranch(name, checkout) { await git(checkout ? ['checkout', '-b', name] : ['branch', name]); },
    async deleteBranch(name, force) { await git(['branch', force ? '-D' : '-d', name]); },
    async checkout(treeish) { await git(['checkout', treeish]); },
    async clean(files) {
      // 与 VS Code「放弃更改」一致：已跟踪的文件恢复到暂存区版本，未跟踪的文件删除。
      const tracked: string[] = [];
      for (const file of files) {
        const relative = relativeArgs([file])[0];
        const known = await git(['ls-files', '--error-unmatch', '--', relative]).then(() => true, () => false);
        if (known) tracked.push(relative);
        else await fs.rm(file, { force: true });
      }
      if (tracked.length) await git(['checkout', '--', ...tracked]);
    },
  };
  return repo;
}

/** vscode.git 扩展的替身：getAPI(1).getRepository(uri) 找到 uri 所在仓库；本机没有 git 或不在仓库里时返回 null。 */
export function createCliGitExtension(makeUri: (fsPath: string) => Uri) {
  const repositories = new Map<string, CliGitRepository>();
  const api = {
    getRepository(uri: Uri): CliGitRepository | null {
      let topLevel: string;
      try {
        topLevel = execFileSync('git', ['rev-parse', '--show-toplevel'], {
          cwd: uri.fsPath, env: gitEnv(), windowsHide: true, encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
      } catch {
        return null;
      }
      if (!topLevel) return null;
      const key = path.resolve(topLevel).toLowerCase();
      let repo = repositories.get(key);
      if (!repo) {
        repo = createCliRepository(path.resolve(topLevel), makeUri);
        repositories.set(key, repo);
      }
      return repo;
    },
  };
  return { getAPI: (_version: 1) => api };
}

/** 本机是否装有 git（用于宿主决定是否提供 Git 扩展替身）。 */
export function hasGitCli(): boolean {
  try {
    execFileSync('git', ['--version'], { env: gitEnv(), windowsHide: true, stdio: 'ignore', timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}
