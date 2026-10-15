const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');

class Uri {
  constructor(scheme, authority, value) { this.scheme = scheme; this.authority = authority; this.path = value; }
  get fsPath() { return this.path; }
  toString() { return `${this.scheme}://${this.authority}${this.path}`; }
  static joinPath(base, ...segments) { return new Uri(base.scheme, base.authority, path.posix.join(base.path, ...segments)); }
}

const rootUri = new Uri('file', '', '/repo/app');
const folder = { name: 'app', uri: rootUri };
const fileUri = (rel) => Uri.joinPath(rootUri, rel);
const S = { INDEX_MODIFIED: 0, INDEX_ADDED: 1, MODIFIED: 5, DELETED: 6, UNTRACKED: 7, BOTH_MODIFIED: 18 };

let repo;
let gitExtension;
let textDocuments = [];
const calls = { confirm: [], ask: [] };

function makeRepo(overrides = {}) {
  const state = {
    HEAD: { name: 'main', commit: 'aaaaaaaaaaaa1111', upstream: { remote: 'origin', name: 'main' }, ahead: 2, behind: 0 },
    remotes: [{ name: 'origin', fetchUrl: 'https://user:ghp_SECRET@github.com/acme/app.git', pushUrl: 'https://user:ghp_SECRET@github.com/acme/app.git' }],
    indexChanges: [],
    workingTreeChanges: [
      { uri: fileUri('src/App.tsx'), status: S.MODIFIED },
      { uri: fileUri('notes.md'), status: S.UNTRACKED },
    ],
    mergeChanges: [],
    ...overrides,
  };
  return {
    rootUri: new Uri('file', '', '/repo'),
    state,
    added: [], commits: [], pushes: [],
    onStatus: undefined,
    async status() { this.onStatus?.(this); },
    async add(paths) { this.added.push(...paths); },
    async commit(message) {
      this.commits.push(message);
      this.state.HEAD = { ...this.state.HEAD, commit: 'bbbbbbbbbbbb2222', ahead: (this.state.HEAD.ahead ?? 0) + 1 };
    },
    async push(...args) { this.pushes.push(args); this.state.HEAD = { ...this.state.HEAD, ahead: 0 }; },
    async log({ maxEntries }) {
      return [{ hash: 'c1c1c1c1c1c1', message: 'feat: second\n\nbody' }, { hash: 'c0c0c0c0c0c0', message: 'feat: first' }]
        .slice(0, maxEntries);
    },
    async diffWithHEAD(p) { return `diff --git a${p}\n-old\n+new\n`; },
    async diffIndexWithHEAD(p) { return `diff --cached a${p}\n`; },
  };
}

const vscodeMock = {
  Uri,
  workspace: {
    get workspaceFolders() { return [folder]; },
    get textDocuments() { return textDocuments; },
  },
  extensions: { getExtension: (id) => (id === 'vscode.git' ? gitExtension : undefined) },
  window: {
    showWarningMessage: async () => undefined,
    showInputBox: async () => undefined,
  },
};

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') return vscodeMock;
  return originalLoad.call(this, request, parent, isMain);
};
const git = require('../out/workspace/git.js');
const { WorkspaceRequestHandler } = require('../out/workspace/requestHandler.js');
Module._load = originalLoad;

function setup(overrides, answers = ['提交']) {
  repo = makeRepo(overrides);
  gitExtension = { isActive: true, exports: { getAPI: () => ({ getRepository: () => repo }) } };
  textDocuments = [];
  calls.confirm = [];
  calls.ask = [];
  const queue = [...answers];
  git.gitUi.confirm = async (message, detail, ...actions) => {
    calls.confirm.push({ message, detail, actions });
    return queue.shift();
  };
  git.gitUi.askMessage = async (value) => { calls.ask.push(value); return queue.shift(); };
}

async function rejects(promise, code) {
  await assert.rejects(promise, (error) => { assert.equal(error.code, code, error.message); return true; });
}

test('status reports workspace-relative changes, branch and bounded diff without sensitive files', async () => {
  setup({
    indexChanges: [{ uri: fileUri('src/index.ts'), status: S.INDEX_MODIFIED }],
    workingTreeChanges: [
      { uri: fileUri('src/App.tsx'), status: S.MODIFIED },
      { uri: fileUri('.env'), status: S.MODIFIED },
      { uri: new Uri('file', '', '/repo/other/x.ts'), status: S.MODIFIED },
      { uri: fileUri('notes.md'), status: S.UNTRACKED },
    ],
  });
  const result = await git.gitStatus({ includeDiff: true });
  assert.equal(result.branch, 'main');
  assert.equal(result.upstream, 'origin/main');
  assert.equal(result.ahead, 2);
  assert.deepEqual(result.staged.files, [{ path: '/src/index.ts', status: 'modified' }]);
  assert.deepEqual(result.unstaged.files.map((f) => f.path), ['/src/App.tsx', '/.env', '/notes.md']);
  assert.equal(result.unstaged.outsideWorkspace, 1);
  assert.deepEqual(result.recentCommits[0], { hash: 'c1c1c1c1c1c1', subject: 'feat: second' });
  assert.match(result.diff, /\[已暂存\] \/src\/index\.ts/);
  assert.match(result.diff, /\[未暂存\] \/src\/App\.tsx/);
  assert.doesNotMatch(result.diff, /\.env|notes\.md|other/);
  assert.deepEqual(result.remotes, ['origin']);
});

test('commit asks for confirmation, stages listed files and commits the message', async () => {
  setup();
  const result = await git.gitCommit({ message: 'feat: 更新标题' });
  assert.equal(calls.confirm.length, 1);
  assert.match(calls.confirm[0].message, /提交 2 个文件到分支 main/);
  assert.match(calls.confirm[0].detail, /feat: 更新标题/);
  assert.match(calls.confirm[0].detail, /\/src\/App\.tsx/);
  assert.deepEqual(repo.added, ['/repo/app/src/App.tsx', '/repo/app/notes.md']);
  assert.deepEqual(repo.commits, ['feat: 更新标题']);
  assert.equal(result.committed, true);
  assert.equal(result.commit, 'bbbbbbbbbbbb2222');
  assert.deepEqual(result.files.map((f) => f.path), ['/src/App.tsx', '/notes.md']);
});

test('cancelled commit changes nothing', async () => {
  setup(undefined, [undefined]);
  await rejects(git.gitCommit({ message: 'm' }), 'USER_CANCELLED');
  assert.deepEqual(repo.added, []);
  assert.deepEqual(repo.commits, []);
});

test('user can edit the commit message before committing', async () => {
  setup(undefined, ['修改提交说明', 'fix: 用户改写的说明', '提交']);
  const result = await git.gitCommit({ message: 'draft' });
  assert.deepEqual(calls.ask, ['draft']);
  assert.equal(calls.confirm.length, 2);
  assert.match(calls.confirm[1].detail, /用户改写的说明/);
  assert.deepEqual(repo.commits, ['fix: 用户改写的说明']);
  assert.equal(result.message, 'fix: 用户改写的说明');
});

test('escape in message editor cancels the commit', async () => {
  setup(undefined, ['修改提交说明', undefined]);
  await rejects(git.gitCommit({ message: 'draft' }), 'USER_CANCELLED');
  assert.deepEqual(repo.commits, []);
});

test('commit limited to paths stages only those files', async () => {
  setup();
  await git.gitCommit({ message: 'm', paths: ['/src/App.tsx'] });
  assert.deepEqual(repo.added, ['/repo/app/src/App.tsx']);
});

test('commit refuses blockers before showing any dialog', async () => {
  setup();
  textDocuments = [{ uri: fileUri('src/App.tsx'), isDirty: true }];
  await rejects(git.gitCommit({ message: 'm' }), 'DIRTY_DOCUMENTS');

  setup({ mergeChanges: [{ uri: fileUri('src/App.tsx'), status: S.BOTH_MODIFIED }] });
  await rejects(git.gitCommit({ message: 'm' }), 'GIT_CONFLICTS');

  setup({ workingTreeChanges: [{ uri: fileUri('.env'), status: S.UNTRACKED }, { uri: fileUri('certs/server.pem'), status: S.UNTRACKED }] });
  await rejects(git.gitCommit({ message: 'm' }), 'GIT_SENSITIVE_FILE');

  setup({ workingTreeChanges: [{ uri: new Uri('file', '', '/repo/other/x.ts'), status: S.MODIFIED }] });
  await rejects(git.gitCommit({ message: 'm' }), 'GIT_OUTSIDE_WORKSPACE');

  setup({ indexChanges: [{ uri: fileUri('src/index.ts'), status: S.INDEX_MODIFIED }] });
  await rejects(git.gitCommit({ message: 'm', paths: ['/src/App.tsx'] }), 'GIT_STAGED_OUTSIDE_REQUEST');

  setup();
  await rejects(git.gitCommit({ message: 'm', paths: ['/src/unchanged.ts'] }), 'GIT_PATH_NOT_CHANGED');

  setup({ workingTreeChanges: [] });
  await rejects(git.gitCommit({ message: 'm' }), 'GIT_NOTHING_TO_COMMIT');

  setup();
  await rejects(git.gitCommit({ message: '   ' }), 'GIT_MESSAGE_REQUIRED');

  setup({ HEAD: { name: undefined, commit: 'x' } });
  await rejects(git.gitCommit({ message: 'm' }), 'GIT_DETACHED_HEAD');

  assert.equal(calls.confirm.length, 0);
  assert.deepEqual(repo.commits, []);
});

test('commit aborts when the repository changes while the dialog is open', async () => {
  setup();
  let refreshes = 0;
  repo.onStatus = (r) => {
    refreshes += 1;
    if (refreshes === 2) r.state.workingTreeChanges.push({ uri: fileUri('src/late.ts'), status: S.MODIFIED });
  };
  await rejects(git.gitCommit({ message: 'm' }), 'GIT_STATE_CHANGED');
  assert.deepEqual(repo.added, []);
  assert.deepEqual(repo.commits, []);
});

test('push confirms with redacted remote and never forces', async () => {
  setup(undefined, ['推送']);
  const result = await git.gitPush({});
  assert.equal(calls.confirm.length, 1);
  assert.match(calls.confirm[0].message, /推送分支 main 到 origin/);
  assert.match(calls.confirm[0].detail, /将推送 2 个提交/);
  assert.match(calls.confirm[0].detail, /c1c1c1c1 feat: second/);
  assert.match(calls.confirm[0].detail, /https:\/\/github\.com\/acme\/app\.git/);
  assert.doesNotMatch(calls.confirm[0].detail, /SECRET|user:/);
  assert.deepEqual(repo.pushes, [['origin', 'main', false]]);
  assert.equal(result.pushed, true);
  assert.equal(result.pushedCommits, 2);
});

test('push without upstream sets upstream on origin', async () => {
  setup({ HEAD: { name: 'feature/x', commit: 'f1' } }, ['推送']);
  const result = await git.gitPush({});
  assert.match(calls.confirm[0].detail, /设置上游 origin\/feature\/x/);
  assert.deepEqual(repo.pushes, [['origin', 'feature/x', true]]);
  assert.equal(result.setUpstream, true);
});

test('push cancel, nothing-to-push, behind remote and missing remote are not executed', async () => {
  setup(undefined, [undefined]);
  await rejects(git.gitPush({}), 'USER_CANCELLED');
  assert.deepEqual(repo.pushes, []);

  setup({ HEAD: { name: 'main', commit: 'a', upstream: { remote: 'origin', name: 'main' }, ahead: 0, behind: 0 } });
  const nothing = await git.gitPush({});
  assert.equal(nothing.pushed, false);
  assert.equal(nothing.reason, 'NOTHING_TO_PUSH');

  setup({ HEAD: { name: 'main', commit: 'a', upstream: { remote: 'origin', name: 'main' }, ahead: 1, behind: 3 } });
  await rejects(git.gitPush({}), 'GIT_BEHIND_REMOTE');

  setup({ remotes: [] });
  await rejects(git.gitPush({}), 'GIT_NO_REMOTE');

  setup({ HEAD: { name: 'dev', commit: 'a' }, remotes: [{ name: 'a' }, { name: 'b' }] });
  await rejects(git.gitPush({}), 'GIT_REMOTE_REQUIRED');

  assert.equal(calls.confirm.length, 0);
  assert.deepEqual(repo.pushes, []);
});

test('push aborts if HEAD moves while confirming', async () => {
  setup(undefined, ['推送']);
  let refreshes = 0;
  repo.onStatus = (r) => {
    refreshes += 1;
    if (refreshes === 2) r.state.HEAD = { ...r.state.HEAD, commit: 'moved' };
  };
  await rejects(git.gitPush({}), 'GIT_STATE_CHANGED');
  assert.deepEqual(repo.pushes, []);
});

test('push failure message never leaks credentials', async () => {
  setup(undefined, ['推送']);
  repo.push = async () => { throw Object.assign(new Error('failed'), { stderr: 'fatal: unable to access https://user:ghp_SECRET@github.com/acme/app.git' }); };
  await assert.rejects(git.gitPush({}), (error) => {
    assert.equal(error.code, 'GIT_PUSH_FAILED');
    assert.doesNotMatch(error.message, /SECRET/);
    assert.match(error.message, /https:\/\/github\.com\/acme/);
    return true;
  });
});

test('missing git extension is reported instead of throwing', async () => {
  setup();
  gitExtension = undefined;
  await rejects(git.gitStatus({}), 'GIT_UNAVAILABLE');
});

test('request handler routes git methods and returns structured errors', async () => {
  setup(undefined, [undefined]);
  const lines = [];
  const handler = new WorkspaceRequestHandler({ appendLine: (line) => lines.push(line) });
  const responses = [];
  await handler.handle({ type: 'workspace_request', requestId: 'r1', workspaceId: 'w', method: 'git.commit',
    params: { message: 'm' } }, 'w', (response) => { responses.push(response); return true; });
  await handler.handle({ type: 'workspace_request', requestId: 'r2', workspaceId: 'w', method: 'git.status',
    params: {} }, 'w', (response) => { responses.push(response); return true; });
  assert.equal(responses[0].success, false);
  assert.equal(responses[0].error.code, 'USER_CANCELLED');
  assert.equal(responses[1].success, true);
  assert.equal(responses[1].result.branch, 'main');
  assert.ok(lines.every((line) => !line.includes('SECRET')));
});
