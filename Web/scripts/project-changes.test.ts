import assert from 'node:assert/strict';
import test from 'node:test';
import { createProjectChangeClient } from '../src/api/projectChanges.ts';
import { createWebProjectChangeClient } from '../src/api/webProjectChanges.ts';
import { usePreviewProjectStore } from '../src/stores/previewProjectStore.ts';
import { bindLiveChangeSet, restoreChangeSetReference } from '../src/utils/changeSetReference.ts';

test('history restores explicit ChangeSet bindings for both hosts, never guesses legacy or ambiguous IDs', () => {
  for (const provider of ['preview', 'vscode']) {
    const ref = { id: 'cs', sessionId: 's', provider };
    assert.deepEqual(restoreChangeSetReference([ref], 's'), ref);
    assert.equal(restoreChangeSetReference([ref], 'other-session'), undefined);
    assert.equal(restoreChangeSetReference([ref, ref], 's'), undefined);
  }
  assert.equal(restoreChangeSetReference(undefined, 's'), undefined);
  assert.equal(restoreChangeSetReference([{ id: 'x', sessionId: 's', provider: 'disk' }], 's'), undefined);
  const first = { id: 'a', sessionId: 's', provider: 'vscode' as const };
  const second = { ...first, id: 'b' };
  const bound = bindLiveChangeSet({}, first);
  assert.deepEqual(bindLiveChangeSet(bound, first).projectChangeSet, first);
  const ambiguous = bindLiveChangeSet(bound, second);
  assert.equal(ambiguous.projectChangeSet, undefined);
  assert.equal(bindLiveChangeSet(ambiguous, first).projectChangeSet, undefined);
});

test('Web undo restores current Virtual FS including deletion and requests a build, without altering historical source', async () => {
  const oldFetch = globalThis.fetch;
  const history = { '/src/main.jsx': 'new', '/new.ts': 'created' };
  const state = usePreviewProjectStore.getState();
  state.importProject('react', history, 'demo', 'p', 2, 7);
  const build = usePreviewProjectStore.getState().buildRunRevision;
  globalThis.fetch = async (_url, options) => new Response(JSON.stringify(options?.method === 'POST'
    ? { success: true, changeSetId: 'c', results: [], previewProject: {
      id: 'p', template: 'react', name: 'demo', files: { '/src/main.jsx': 'old' }, revision: 3 }, serverRevision: 8 }
    : { id: 'c', sessionId: 's', roundId: 'r', projectRef: { project_id: 'p', provider: 'preview', root: null } }));
  try {
    const result = await createWebProjectChangeClient('s').undoChangeSet('c');
    assert.equal(result.previewSynced, true);
    assert.deepEqual({ ...usePreviewProjectStore.getState().project.files }, { '/src/main.jsx': 'old' });
    assert.equal(usePreviewProjectStore.getState().buildRunRevision, build + 1);
    assert.equal(history['/new.ts'], 'created');
  } finally { globalThis.fetch = oldFetch; }
});

test('undo sync preserves empty files and does not resurrect a deleted HTML entry', () => {
  const store = usePreviewProjectStore.getState();
  assert.equal(store.applyUndoProject({ ...store.project, files: {}, revision: 4 }, 9), true);
  assert.deepEqual(Object.keys(usePreviewProjectStore.getState().project.files), []);
  assert.equal(usePreviewProjectStore.getState().selectedFilePath, null);
  assert.equal(usePreviewProjectStore.getState().applyUndoProject({ ...store.project, revision: 3 }, 8), false);
});

test('Web blocks local dirty source before POST and does not overwrite edits made during undo', async () => {
  const oldFetch = globalThis.fetch;
  let project = { id: 'p', name: 'demo', template: 'react' as const, files: { '/a.ts': 'new' }, revision: 3, persistedRevision: 2 };
  let posts = 0;
  let restores = 0;
  globalThis.fetch = async (_url, options) => {
    if (options?.method === 'POST') {
      posts++;
      project = { ...project, files: { '/a.ts': 'user edit' }, revision: 4 };
      return new Response(JSON.stringify({ success: true, results: [], previewProject: {
        ...project, files: { '/a.ts': 'old' } }, serverRevision: 8 }));
    }
    return new Response(JSON.stringify({ sessionId: 's', projectRef: { project_id: 'p', provider: 'preview' } }));
  };
  const api = createProjectChangeClient('s', { mode: 'web', preview: { current: () => project, restore: () => restores++ } });
  try {
    await assert.rejects(api.undoChangeSet('c'), /未保存/);
    assert.equal(posts, 0);
    project.persistedRevision = project.revision;
    const result = await api.undoChangeSet('c');
    assert.equal(result.previewSynced, false);
    assert.equal(restores, 0);
    assert.equal(project.files['/a.ts'], 'user edit');
  } finally { globalThis.fetch = oldFetch; }
});

test('VS Code change client cannot invoke Preview undo or access its adapter', async () => {
  const oldFetch = globalThis.fetch;
  let posts = 0;
  globalThis.fetch = async (_url, options) => {
    if (options?.method === 'POST') posts++;
    return new Response(JSON.stringify({ sessionId: 's', projectRef: { provider: 'preview' } }));
  };
  try {
    await assert.rejects(createProjectChangeClient('s', { mode: 'vscode' }).undoChangeSet('c'), /宿主/);
    assert.equal(posts, 0);
  } finally { globalThis.fetch = oldFetch; }
});

test('confirmation uses apply endpoints on both hosts; a private new-project draft never switches Preview', async () => {
  const original = globalThis.fetch;
  const urls: string[] = [];
  let publish = false, restored = 0;
  const current = { id: 'old', template: 'react' as const, name: 'old', files: { '/old.ts': 'old' }, revision: 1, persistedRevision: 1 };
  let provider = 'preview';
  globalThis.fetch = async (url, options) => {
    urls.push(String(url));
    return new Response(JSON.stringify(options?.method === 'POST' ? {
      success: true, results: [], ...(publish ? { previewProject: { ...current, id: 'new' }, serverRevision: 8 } : {}),
    } : { sessionId: 's', projectRef: { project_id: 'new', provider }, previewNewProject: true, previewParentProjectId: 'old' }));
  };
  try {
    const web = createProjectChangeClient('s', { mode: 'web', preview: { current: () => current, restore: () => { restored++; } } });
    await web.applyFile('c', 'f');
    assert.match(urls.at(-1)!, /files\/f\/apply$/);
    assert.equal(restored, 0);
    publish = true;
    assert.equal((await web.applyChangeSet('c')).previewSynced, true);
    assert.equal(restored, 1);
    provider = 'vscode'; publish = false;
    await createProjectChangeClient('s', { mode: 'vscode' }).applyChangeSet('c');
    assert.match(urls.at(-1)!, /c\/apply$/);
  } finally { globalThis.fetch = original; }
});
