import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { unzipSync, strFromU8, strToU8, zipSync } from 'fflate';
import { createPreviewArchive, createPreviewDistArchive, previewArchiveName, previewDistArchiveName } from '../src/preview/core/exportProject.ts';
import { importPreviewArchive, importPreviewDirectory } from '../src/preview/core/importArchive.ts';
import { createReactTemplate } from '../src/preview/templates/reactTemplate.ts';
import { createMessagePreviewSnapshot } from '../src/preview/core/projectSnapshot.ts';
import { fileExtension, generatedFileExtension, haveSamePreviewArtifactFiles, isSamePreviewArtifact, previewArtifactName, previewArtifactTooltip, previewSnapshotExtension } from '../src/preview/core/artifactFormat.ts';
import { hasCurrentProjectSource, hasPreviewFiles, isPreviewableGeneratedFile, isPreviewableUploadedAttachment } from '../src/preview/core/previewFilePresence.ts';
import { getSnapshotBackedHtmlArtifactUrls } from '../src/preview/core/snapshotArtifactDedup.ts';
import { canonicalizePresentationFiles, createPresentationSnapshot, isPresentationSnapshotFile, restorePresentationSnapshot } from '../src/preview/core/presentationSnapshot.ts';
import { createUploadSummaryRequest } from '../src/utils/uploadSummary.ts';
import { createSceneProjectFiles, exportSceneGlb, isSceneRendererProject, validateSceneSpec } from '../src/modeling/sceneSpec.ts';
import { saveSceneArtifact } from '../src/modeling/sceneArtifact.ts';
import { saveGeneratedGlb } from '../src/api/webProjectArtifacts.ts';
import { isNewPreviewProjectRequest } from '../src/preview/core/creationIntent.ts';
import { glbFileName, hasGeneratedSceneArtifact, linkGeneratedFileToProject } from '../src/preview/core/artifactFormat.ts';
import { canBuildPreviewSource } from '../src/preview/core/buildReadiness.ts';
import { projectClientContext } from '../src/utils/clientMode.ts';
import { motionFrames, transitionFrames, segmentCues, playMotion } from '../src/preview/core/presentationMotion.ts';
import { createBlankProjectState, usePreviewProjectStore } from '../src/stores/previewProjectStore.ts';
import { canPublishStagedProject, stageProjectSources } from '../src/preview/core/stagedProject.ts';
import { previewArtifactCreationOrder, sortPreviewArtifactEntries, sourceSnapshotForTarget } from '../src/preview/core/artifactSelection.ts';
import type { ChatMessage } from '../src/types.ts';
import type { PresentationMotionCue, PresentationSchema } from '../src/types.ts';

test('Web preview canvas does not mask project backgrounds, collapse app margins or clip scrolling', () => {
  const html = readFileSync(new URL('../preview-runtime.html', import.meta.url), 'utf8');
  const css = html.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? '';
  assert.match(css, /html\s*\{\s*background:\s*#171923;/, 'theme fallback belongs to html only');
  assert.match(css, /body,\s*#root\s*\{\s*display:\s*flow-root;\s*background:\s*transparent;/);
  assert.match(css, /body\s*\{\s*overflow:\s*auto;/);
  assert.doesNotMatch(css, /overflow:\s*hidden/);
  assert.match(css, /html,\s*body,\s*#root\s*\{\s*width:\s*100%;\s*height:\s*100%;\s*margin:\s*0;/,
    'retain the viewport height chain required by full-height scenes');
});

test('Web GLB export sends virtual bytes and plugin cannot invoke the Web artifact adapter', async () => {
  const originalFetch = globalThis.fetch;
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const dataset = { gorClientMode: 'web' };
  const calls: Array<{ url: string; init: RequestInit }> = [];
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { documentElement: { dataset } } });
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init: init! });
    return Response.json({ success: true, file: { fileType: '3d', displayName: 'robot.glb', downloadUrl: '/virtual/1' } });
  };
  try {
    const blob = new Blob(['virtual GLB bytes']);
    const result = await saveGeneratedGlb('session/id', blob, 'robot.glb.glb', 'reply/id');
    assert.equal(result.downloadUrl, '/virtual/1');
    const { url, init } = calls[0];
    assert.equal(init.method, 'PUT');
    assert.equal(init.body, blob);
    assert.equal(init.cache, 'no-store');
    assert.equal((init.headers as Record<string, string>)['Content-Type'], 'model/gltf-binary');
    assert.ok(url.startsWith('/api/chat/session/session%2Fid/generated-artifacts?'));
    const query = new URL(url, 'http://localhost').searchParams;
    assert.equal(query.get('name'), 'robot.glb');
    assert.equal(query.get('message_id'), 'reply/id');
    dataset.gorClientMode = 'vscode';
    await assert.rejects(saveGeneratedGlb('s', blob, 'robot.glb'), /VS Code/);
    assert.equal(calls.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
    else Reflect.deleteProperty(globalThis, 'document');
  }
});

test('GLB scene names, historical artifacts and tooltips retain exactly one suffix', () => {
  for (const name of ['机器人', '机器人.glb', '机器人.GLB', '机器人.glb.glb', ' 机器人.glb .GLB  ']) {
    assert.equal(glbFileName(name), '机器人.glb');
    assert.equal(glbFileName(glbFileName(name)), '机器人.glb');
    assert.equal(previewArtifactName({ name, files: { '/src/scene.json': JSON.stringify({ name }) } }, '.glb'), '机器人.glb');
  }
  assert.equal(glbFileName('robot.v2.glb'), 'robot.v2.glb');
  assert.equal(glbFileName('.glb.glb'), '3D Model.glb');
  assert.equal(previewArtifactTooltip('机器人.glb.glb', '.glb'), '机器人.glb');
  const original = { fileType: '3d', displayName: 'robot.glb.glb', downloadUrl: '/artifacts/opaque-id', projectId: 'scene-a' };
  const normalized = linkGeneratedFileToProject(original, ['scene-b']);
  assert.equal(normalized.displayName, 'robot.glb');
  assert.equal(normalized.downloadUrl, original.downloadUrl);
  assert.equal(normalized.projectId, 'scene-a');
  assert.equal(original.displayName, 'robot.glb.glb');
});

test('new projects stay off-screen through partial and complete source sync until explicitly published', () => {
  const store = usePreviewProjectStore.getState();
  store.createProject('react');
  const old = usePreviewProjectStore.getState().project;
  let staged = createBlankProjectState('react');
  assert.notEqual(staged.id, old.id);
  assert.equal(usePreviewProjectStore.getState().project, old);
  staged = stageProjectSources(staged, [{ path: '/index.html', content: '<script type="module" src="/src/main.jsx"></script>' }], 1);
  assert.equal(usePreviewProjectStore.getState().project, old);
  staged = stageProjectSources(staged, [
    { path: '/src/main.jsx', content: 'import App from "./App.jsx";' },
    { path: '/src/App.jsx', content: 'export default function App() { return <h1>New Counter</h1>; }' },
  ], 2, 3);
  assert.equal(staged.name, 'New Counter');
  assert.equal(staged.serverRevision, 3);
  assert.equal(staged.persistedRevision, 2);
  assert.equal(usePreviewProjectStore.getState().project, old);
  assert.throws(() => stageProjectSources(staged, [], 1), /版本已过期/);
  store.importProject(staged.template, staged.files, staged.name, staged.id, staged.revision, staged.serverRevision);
  assert.equal(usePreviewProjectStore.getState().project.id, staged.id);
  assert.notEqual(usePreviewProjectStore.getState().project.files, old.files);
  store.clearProject();
});

test('new 3D scene stages its full renderer without opening an empty preview', () => {
  const store = usePreviewProjectStore.getState();
  store.clearProject();
  const old = usePreviewProjectStore.getState().project;
  const scene = validateSceneSpec({ version: 1, name: 'Robot', objects: [{ id: 'body', name: 'Body', geometry: 'box', size: [1, 1, 1], position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], color: '#8b5cf6', metalness: 0, roughness: 1, copy_offsets: [] }] });
  const staged = stageProjectSources(createBlankProjectState('html'), [{ path: '/src/scene.json', content: JSON.stringify(scene) }], 1, 1);
  assert.equal(staged.name, 'Robot');
  assert.equal(isSceneRendererProject(staged.files), true);
  assert.equal(usePreviewProjectStore.getState().project, old);
  assert.equal(Object.keys(old.files).length, 0);
});

test('new project publication waits for completion, source/artifacts and rejects cancellation/failure/session changes', () => {
  const ready = { completed: true, ready: true, changed: true, aborted: false, failed: false, activeProjectId: 'old', previousProjectId: 'old' };
  assert.equal(canPublishStagedProject(ready), true);
  for (const override of [{ completed: false }, { ready: false }, { changed: false }, { aborted: true }, { failed: true }, { activeProjectId: 'another-session' }]) {
    assert.equal(canPublishStagedProject({ ...ready, ...override }), false);
  }
});

test('Worker orders current React, archived React and GLB by creation, not artifact kind or last edit', () => {
  const first = createMessagePreviewSnapshot({ id: 'first-react', name: 'Demo', template: 'react', files: createReactTemplate() }, 'm1', []);
  const messages = [
    { id: 'm1', role: 'assistant', content: '', created_at: '2026-10-07T10:00:00Z', previewSnapshot: first },
    { id: 'm2', role: 'assistant', content: '', created_at: '2026-10-07T10:01:00Z', previewChanges: [{ projectId: 'scene', path: '/src/scene.json', diff: '' }], file: { fileType: '3d', displayName: 'Scene.glb', downloadUrl: '/scene.glb', projectId: 'scene' } },
    { id: 'm3', role: 'assistant', content: '', created_at: '2026-10-07T10:02:00Z', previewChanges: [{ projectId: 'shopping', path: '/src/App.jsx', diff: '' }] },
    { id: 'm4', role: 'assistant', content: '', created_at: '2026-10-07T10:03:00Z', previewSnapshot: { ...first, messageId: 'm4', revision: 2 } },
  ] as ChatMessage[];
  const order = previewArtifactCreationOrder(messages);
  const entries = [{ key: 'project:shopping' }, { key: 'project-snapshot:m4' }, { key: 'generated:/scene.glb' }];
  assert.deepEqual(sortPreviewArtifactEntries(entries, order).map((entry) => entry.key), ['project-snapshot:m4', 'generated:/scene.glb', 'project:shopping']);
  assert.equal(order['project:first-react'], order['project-snapshot:m4']);
  assert.equal(entries[0].key, 'project:shopping'); // Caller order is not mutated.
});

test('Code uses only the selected target source; stale GLB must not replace current React source', () => {
  const glb = createMessagePreviewSnapshot({ id: 'scene', name: 'Scene', template: 'html', files: { '/index.html': '<h1>old scene</h1>' } }, 'm2', []);
  const react = createMessagePreviewSnapshot({ id: 'react', name: 'Shopping', template: 'react', files: createReactTemplate() }, 'm3', []);
  assert.equal(sourceSnapshotForTarget('project', react, glb), undefined);
  assert.equal(sourceSnapshotForTarget('project-snapshot', react, glb), react);
  assert.equal(sourceSnapshotForTarget('generated', react, glb), glb);
  assert.equal(sourceSnapshotForTarget('uploaded-dist', react, glb), undefined);
  assert.equal(sourceSnapshotForTarget('project-snapshot', null, glb), undefined);
});

test('Web and plugin declare distinct project providers; optional feature negation still generates projects', () => {
  assert.deepEqual(projectClientContext('web', 'stale-vscode-workspace'), { clientMode: 'web' });
  assert.deepEqual(projectClientContext('vscode', 'workspace-1'), { clientMode: 'vscode', workspaceId: 'workspace-1' });
  assert.equal(isNewPreviewProjectRequest('生成一个最简单的react-demo，只展示一个标题，不需要其他功能'), true);
  assert.equal(isNewPreviewProjectRequest('新建一个3D模型，不用复杂材质'), true);
  assert.equal(isNewPreviewProjectRequest('不要创建react项目'), false);
  assert.equal(isNewPreviewProjectRequest('不需要生成3D模型'), false);
});

test('new React/3D projects wait for source commits, while completed invalid projects still report build errors', () => {
  const store = usePreviewProjectStore.getState();
  for (const template of ['react', 'html', 'react', 'html'] as const) {
    store.createBlankProject(template);
    const blank = usePreviewProjectStore.getState().project;
    assert.equal(canBuildPreviewSource(blank.files), false);
    const partial = { '/index.html': '<script type="module" src="/missing.js"></script>' };
    assert.equal(canBuildPreviewSource(partial, true), false);
    // Once generation is over, real missing-entry diagnostics must not be masked.
    assert.equal(canBuildPreviewSource(partial, false), true);
    assert.equal(canBuildPreviewSource(createReactTemplate(), true), false);
    assert.equal(canBuildPreviewSource(createReactTemplate(), false), true);
  }
  store.clearProject();
});

test('exported GLB replaces only its linked scene entry, not same-name independent projects', () => {
  const file = { fileType: '3d', displayName: 'robot.glb', downloadUrl: '/artifacts/robot' };
  const linked = linkGeneratedFileToProject(file, ['scene-a', 'scene-a']);
  assert.equal(linked.projectId, 'scene-a');
  assert.equal(hasGeneratedSceneArtifact('scene-a', [linked]), true);
  assert.equal(hasGeneratedSceneArtifact('scene-b', [linked]), false);
  assert.equal(hasGeneratedSceneArtifact('scene-a', []), false);
  assert.equal(linkGeneratedFileToProject(file, ['scene-a', 'scene-b']).projectId, undefined);
  assert.equal(linkGeneratedFileToProject({ ...file, projectId: 'scene-b' }, ['scene-a']).projectId, 'scene-b');
  assert.equal(hasGeneratedSceneArtifact('scene-a', [{ ...linked, displayName: 'robot.html', fileType: 'html' }]), false);
});

test('motion player consumes snapshot clocks and cancels all animations without touching layout scale', () => {
  const cue: PresentationMotionCue = { target: 'headline', effect: 'rise', trigger: 'withPrevious', start: .08, delay: .08, duration: .42, order: 1, clickIndex: 0, direction: 'up', distance: 'short' };
  const clicks = { ...cue, target: 'card-0', trigger: 'onClick' as const, start: 0, delay: 0, order: 2, clickIndex: 1 };
  assert.deepEqual(segmentCues([cue, clicks], 0), [cue]);
  assert.deepEqual(segmentCues([cue, clicks], 1), [clicks]);
  assert.equal(motionFrames(cue, '#aabbcc')[0].transform, 'translateY(18px)');
  assert.equal(motionFrames({ ...cue, direction: 'left' }, '#aabbcc', { width: 960, height: 720 })[0].transform, 'translateX(24px)');
  for (const effect of ['appear', 'fade', 'rise', 'wipe', 'fly', 'zoom', 'grow', 'pulse', 'colorEmphasis', 'fadeOut'] as const) assert.ok(motionFrames({ ...cue, effect }, '#aabbcc').length);
  assert.equal(transitionFrames({ effect: 'none', duration: .4, direction: 'left' }).length, 0);
  const calls: Array<{ target: string; options: KeyframeAnimationOptions }> = [];
  let canceled = 0;
  const node = (target: string) => ({ dataset: { motionTarget: target }, animate: (_frames: Keyframe[], options: KeyframeAnimationOptions) => { calls.push({ target, options }); return { cancel: () => canceled++ }; } });
  const root = { ...node('frame'), querySelectorAll: () => [node('headline'), node('card-0')] } as unknown as HTMLElement;
  const cancel = playMotion(root, [cue, clicks], 0, '#aabbcc', { effect: 'fade', duration: .4, direction: 'left' });
  assert.equal(calls.find(call => call.target === 'headline')?.options.delay, 80);
  assert.equal(calls.find(call => call.target === 'headline')?.options.duration, 420);
  const next = playMotion(root, [cue, clicks], 1, '#aabbcc');
  next(); cancel();
  assert.equal(canceled, calls.length);
  const previous = calls.length;
  playMotion(root, [cue, clicks], 0, '#aabbcc', undefined, true)();
  assert.equal(calls.length, previous);
});

test('PPT A/B motion snapshots remain isolated through refresh, clear/restore and same-name IDs', () => {
  const make = (id: string, effect: 'fade' | 'wipe') => {
    const schema: PresentationSchema = { version: '1.0', title: '同名演示', theme: 'technology', aspectRatio: '16:9', motionLanguage: { style: 'professional', energy: 'medium', playback: 'automatic', maxAnimatedGroupsPerSlide: 5 }, slides: [{ id: 's', type: 'cover', title: id, animationTimeline: [{ target: 'headline', effect, trigger: 'withPrevious', start: .08, duration: .42, delay: .08, order: 1, clickIndex: 0, direction: 'up', distance: 'short' }] }] };
    return { fileType: 'ppt', displayName: '同名演示.pptx', downloadUrl: `/api/download/${id}.pptx`, artifactId: id, projectId: `p-${id}`, snapshotId: `s-${id}`, previewRenderer: 'presentation', presentationSchema: schema, sourceFiles: { '/presentation.json': JSON.stringify(schema) } };
  };
  const a = make('a', 'fade'), b = make('b', 'wipe');
  const snapA = createPresentationSnapshot(a, 'message-a')!, snapB = createPresentationSnapshot(b, 'message-b')!;
  const restoredA = restorePresentationSnapshot(JSON.parse(JSON.stringify(snapA)), 'message-a')!;
  assert.deepEqual(restoredA.presentationSchema, a.presentationSchema);
  assert.notEqual(snapA.id, snapB.id);
  assert.notEqual(restoredA.files['/presentation.json'], snapB.files['/presentation.json']);
  assert.equal(restoredA.finalArtifact?.downloadUrl, a.downloadUrl);
  const remaining = [snapA, snapB].filter(snapshot => snapshot.id !== snapA.id);
  assert.equal(remaining[0].artifactId, b.artifactId);
  remaining.push(restoredA);
  assert.equal(remaining.length, 2);
  assert.equal(canonicalizePresentationFiles([a, b], snapB).length, 1);
  assert.deepEqual(JSON.parse(restoredA.files['/presentation.json']).slides[0].animationTimeline, a.presentationSchema.slides[0].animationTimeline);
});

function directoryFile(path: string, content: string | Uint8Array): File {
  const bytes = typeof content === 'string' ? strToU8(content) : content;
  const name = path.split('/').at(-1) ?? 'file';
  return {
    name,
    size: bytes.byteLength,
    webkitRelativePath: path,
    arrayBuffer: async () => bytes.slice().buffer,
  } as File;
}

test('preview download ZIP preserves virtual paths and Unicode source content', () => {
  const files = { '/index.html': '<title>待办清单</title>', '/src/App.tsx': 'export default "你好";', '/src/style.css': 'body {}' };
  const extracted = unzipSync(createPreviewArchive(files));
  assert.deepEqual(Object.keys(extracted).sort(), ['index.html', 'src/App.tsx', 'src/style.css']);
  for (const [path, content] of Object.entries(files)) assert.equal(strFromU8(extracted[path.slice(1)]), content);
  assert.equal(previewArchiveName('待办清单.html'), '待办清单-source.zip');
  assert.throws(() => createPreviewArchive({ '../../escape.txt': 'unsafe' }));
});

test('presentation artifacts restore per-message schema snapshots and deduplicate the file-tree entry', () => {
  const file = {
    fileType: 'ppt', displayName: '季度复盘.pptx', downloadUrl: '/api/download/artifact.pptx',
      artifactId: 'artifact-1', projectId: 'project-1', snapshotId: 'snapshot-1', previewRenderer: 'presentation',
      renderedSlides: [{ slideId: 'cover', index: 0, url: '/api/download/render-1.png?inline=true', thumbnailUrl: '/api/download/render-1.png?inline=true' }],
      antiAIPatternReport: { scores: { repeatedLayoutScore: 0 } },
    presentationSchema: { version: '1.0', title: '季度复盘', theme: 'modern-dark', aspectRatio: '16:9', slides: [{ id: 'cover', type: 'cover', title: '季度复盘' }] },
    sourceFiles: { '/presentation.json': '{"title":"季度复盘"}' },
  } as const;
  const snapshot = createPresentationSnapshot(file, 'message-1', 'session-1');
  assert.equal(snapshot?.messageId, 'message-1');
  assert.equal(snapshot?.finalArtifact?.downloadUrl, file.downloadUrl);
  assert.equal(isPresentationSnapshotFile(file, snapshot ? [snapshot] : []), true);
  const restored = restorePresentationSnapshot(JSON.parse(JSON.stringify(snapshot)), 'message-fallback');
  assert.equal(restored?.messageId, 'message-1');
    assert.equal(restored?.artifactId, 'artifact-1');
    assert.equal(restored?.files['/presentation.json'], file.sourceFiles['/presentation.json']);
    assert.deepEqual(restored?.renderedSlides, file.renderedSlides);
    assert.deepEqual(restored?.antiAIPatternReport, file.antiAIPatternReport);
  assert.equal(isPresentationSnapshotFile({ ...file, artifactId: 'other' }, snapshot ? [snapshot] : []), false);
  assert.deepEqual(canonicalizePresentationFiles([
    file,
    { ...file, artifactId: 'artifact-2', downloadUrl: '/api/download/artifact-2.pptx' },
    { ...file, artifactId: 'artifact-3', downloadUrl: '/api/download/artifact-3.pptx' },
  ], restored), [file]);
});

test('upload summaries analyze bounded readable content without exposing source in the chat bubble', () => {
  const largeSource = 'export function App() { return "weather dashboard"; }\n'.repeat(100);
  const result = createUploadSummaryRequest({
    kind: 'source',
    name: 'weather-project',
    template: 'react',
    files: {
      '/package.json': '{"name":"weather-project","dependencies":{"react":"*"}}',
      '/src/App.tsx': largeSource,
      '/node_modules/example/index.js': 'must not be included',
      '/package-lock.json': 'lock data must not be included',
      '/dist/assets/bundle.js': 'generated output must not be included',
    },
  });

  assert.equal(result.displayText, '已上传「weather-project」，请简要概述它的主要内容。');
  assert.deepEqual(result.attachments, [{ name: 'weather-project', kind: 'folder' }]);
  assert.doesNotMatch(result.displayText, /src\/App|export function|weather dashboard/);
  assert.match(result.analysisContext, /weather dashboard/);
  assert.doesNotMatch(result.analysisContext, /must not be included|lock data|generated output/);
  assert.ok(result.analysisContext.length < 11_000);
  assert.match(result.prompt, /不要输出代码、文件名、路径或清单/);
});

test('upload summaries decode readable text from dist archives while keeping the visible message concise', () => {
  const encoder = new TextEncoder();
  const result = createUploadSummaryRequest({
    kind: 'dist',
    name: 'task-board-dist',
    entryPath: '/index.html',
    files: {
      '/index.html': encoder.encode('<title>团队任务看板</title>'),
      '/assets/app.js': encoder.encode('const title = "团队任务看板"; const action = "创建任务";'),
      '/assets/app.js.map': encoder.encode('source map should be skipped'),
    },
    archiveBytes: new Uint8Array(),
  });

  assert.match(result.analysisContext, /团队任务看板/);
  assert.doesNotMatch(result.analysisContext, /source map should be skipped/);
  assert.equal(result.displayText, '已上传「task-board-dist」，请简要概述它的主要内容。');
  assert.deepEqual(result.attachments, [{ name: 'task-board-dist', kind: 'archive' }]);
});

test('SceneSpec validation bounds geometry and the fixed renderer scaffold uses only virtual project files', () => {
  const scene = validateSceneSpec({
    version: 1,
    name: '低多边形汽车',
    objects: [{
      id: 'wheel', name: '车轮', geometry: 'cylinder', size: [0.35, 0.2, 0.35],
      position: [0.9, 0.35, 0.7], rotation: [Math.PI / 2, 0, 0], scale: [1, 1, 1],
      color: '#222222', metalness: 0.05, roughness: 0.8,
      copy_offsets: [[-1.8, 0, 0], [0, 0, -1.4], [-1.8, 0, -1.4]],
    }],
  });
  assert.equal(scene.objects[0].copy_offsets.length, 3);
  const files = createSceneProjectFiles(scene);
  assert.match(files['/index.html'], /\/src\/main\.ts/);
  assert.match(files['/index.html'], /<div id="root"><\/div>/);
  assert.match(files['/src/main.ts'], /requestAnimationFrame|setAnimationLoop/);
  assert.match(files['/src/main.ts'], /import spec from '\.\/scene\.json'/);
  assert.match(files['/src/scene.json'], /低多边形汽车/);
  assert.equal(files['/src/style.css'], undefined);
  assert.match(files['/src/main.ts'], /new THREE\.WebGLRenderer/);
  assert.match(files['/src/main.ts'], /window\.__GOR_PREVIEW_DISPOSE__/);
  assert.equal(isSceneRendererProject(files), true);
  assert.equal(isSceneRendererProject({
    ...files,
    '/src/main.ts': 'const spec = { objects: [] }; const makeGeometry = () => {}; new THREE.WebGLRenderer(); window.__GOR_PREVIEW_DISPOSE__ = () => {};',
  }), true);
  assert.equal(isSceneRendererProject({
    ...files,
    '/index.html': '<div id="root"></div><script type="module" src="/src/main.tsx"></script>',
  }), false);
  assert.throws(() => validateSceneSpec({ ...scene, objects: [{ ...scene.objects[0], geometry: 'script' }] }));
  assert.throws(() => validateSceneSpec({ ...scene, objects: [{ ...scene.objects[0], position: [NaN, 0, 0] }] }));
});

test('fixed exporter creates a GLB v2 binary from a validated low-poly SceneSpec', async () => {
  const scene = validateSceneSpec({
    version: 1,
    name: 'Test Model',
    objects: [{
      id: 'body', name: 'Body', geometry: 'box', size: [2, 1, 1],
      position: [0, 0.5, 0], rotation: [0, 0, 0], scale: [1, 1, 1],
      color: '#d42b32', metalness: 0.1, roughness: 0.6, copy_offsets: [],
    }],
  });
  const readerDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'FileReader');
  Object.defineProperty(globalThis, 'FileReader', {
    configurable: true,
    value: class {
      result: ArrayBuffer | null = null;
      onloadend: (() => void) | null = null;
      async readAsArrayBuffer(blob: Blob) {
        this.result = await blob.arrayBuffer();
        this.onloadend?.();
      }
    },
  });
  let blob: Blob;
  try {
    blob = await exportSceneGlb(scene);
    const file = await saveSceneArtifact({ ...scene, name: 'Test Model.glb.glb' }, async (artifact, name) => {
      assert.equal(name, 'Test Model.glb');
      assert.equal(artifact.type, 'model/gltf-binary');
      const header = new DataView(await artifact.arrayBuffer());
      assert.equal(header.getUint32(0, true), 0x46546c67);
      assert.equal(header.getUint32(4, true), 2);
      return { fileType: '3d', displayName: name, downloadUrl: '/generated/model.glb' };
    });
    assert.equal(file.fileType, '3d');
  } finally {
    if (readerDescriptor) Object.defineProperty(globalThis, 'FileReader', readerDescriptor);
    else Reflect.deleteProperty(globalThis, 'FileReader');
  }
  const bytes = new Uint8Array(await blob.arrayBuffer());
  assert.equal(blob.type, 'model/gltf-binary');
  assert.equal(new TextDecoder().decode(bytes.slice(0, 4)), 'glTF');
  assert.equal(new DataView(bytes.buffer).getUint32(4, true), 2);
  assert.equal(new DataView(bytes.buffer).getUint32(8, true), bytes.byteLength);
});

test('preview dist ZIP contains a self-contained HTML with the successful JS/CSS build and runtime', () => {
  const result: PreviewBuildResult = {
    buildId: 'build-1',
    projectId: 'project-1',
    entryPoint: '/src/main.tsx',
    outputFiles: [
      { path: '/out/bundle.js', type: 'js', contents: 'window.__GOR_PREVIEW_RUNTIME__;' },
      { path: '/out/bundle.css', type: 'css', contents: 'body { color: red; }' },
    ],
    warnings: [],
    duration: 1,
  };
  const extracted = unzipSync(createPreviewDistArchive(result, 'local runtime'));
  assert.deepEqual(Object.keys(extracted), ['index.html']);
  const html = strFromU8(extracted['index.html']);
  assert.match(html, /local runtime/);
  assert.match(html, /window\.__GOR_PREVIEW_RUNTIME__/);
  assert.match(html, /window\.__GOR_PREVIEW_RUNTIME__;/);
  assert.match(html, /body \{ color: red; \}/);
  assert.doesNotMatch(html, /<script\s+src=/, 'the standalone document does not need external script files');
  assert.equal(previewDistArchiveName('广州天气.html'), '广州天气-dist.zip');
  assert.throws(() => createPreviewDistArchive({ ...result, outputFiles: [] }, 'runtime'));
});

test('import recognizes source ZIPs and strips a single enclosing project directory', async () => {
  const sourceZip = createPreviewArchive({
    ...createReactTemplate(),
    '/src/theme.less': '.chat { color: violet; }',
    '/src/Panel.vue': '<template><p>Hello</p></template>',
  });
  const imported = await importPreviewArchive(sourceZip, 'weather-source.zip');
  assert.equal(imported.kind, 'source');
  if (imported.kind !== 'source') return;
  assert.equal(imported.template, 'react');
  assert.equal(imported.files['/index.html'] !== undefined, true);
  assert.match(imported.files['/src/main.tsx'] ?? '', /createRoot/);
  assert.equal(imported.files['/src/theme.less'], '.chat { color: violet; }');
  assert.equal(imported.files['/src/Panel.vue'], '<template><p>Hello</p></template>');
});

test('import recognizes static dist ZIPs as preview-only content', async () => {
  const distZip = zipSync({
    'weather-dist/index.html': strToU8('<!doctype html><title>天气</title><main>Ready</main>'),
    'weather-dist/assets/app.js': strToU8('document.body.dataset.ready = "yes";'),
  });
  const imported = await importPreviewArchive(distZip, 'weather-dist.zip');
  assert.equal(imported.kind, 'dist');
  if (imported.kind !== 'dist') return;
  assert.equal(imported.entryPath, '/index.html');
  assert.match(strFromU8(imported.files['/index.html'] ?? new Uint8Array()), /<main>Ready<\/main>/);
  assert.match(strFromU8(imported.files['/assets/app.js'] ?? new Uint8Array()), /dataset.ready/);
  assert.equal(imported.archiveBytes, distZip);
});

test('folder import recognizes source projects and preserves nested virtual paths', async () => {
  const template = createReactTemplate();
  const files = Object.entries(template).map(([path, content]) => directoryFile(`weather-project${path}`, content));
  const imported = await importPreviewDirectory(files);
  assert.equal(imported.kind, 'source');
  if (imported.kind !== 'source') return;
  assert.equal(imported.name, 'weather-project');
  assert.equal(imported.template, 'react');
  assert.match(imported.files['/src/main.tsx'] ?? '', /createRoot/);
});

test('folder import recognizes dist projects, skips dependency folders, and creates a downloadable ZIP', async () => {
  const files = [
    directoryFile('weather-dist/index.html', '<!doctype html><script src="/assets/app.js"></script>'),
    directoryFile('weather-dist/assets/app.js', 'document.body.dataset.ready = "yes";'),
    directoryFile('weather-dist/node_modules/ignored.js', 'ignored'),
  ];
  const imported = await importPreviewDirectory(files);
  assert.equal(imported.kind, 'dist');
  if (imported.kind !== 'dist') return;
  assert.equal(imported.name, 'weather-dist');
  assert.equal(imported.entryPath, '/index.html');
  assert.equal(imported.files['/assets/app.js'] !== undefined, true);
  assert.equal(imported.files['/node_modules/ignored.js'], undefined);
  assert.deepEqual(Object.keys(unzipSync(imported.archiveBytes)).sort(), ['assets/app.js', 'index.html']);
});
import { build } from 'esbuild-wasm';
import { getPreviewEntryPoint } from '../src/preview/core/entryPoint.ts';
import { BABEL_PREVIEW_ENTRY } from '../src/preview/core/htmlScripts.ts';
import { preparePreviewCompilation } from '../src/preview/runtime/compiler/babelHtmlAdapter.ts';
import { PreviewRuntimeController } from '../src/preview/runtime/runtimeController.ts';
import { buildFileTree } from '../src/preview/core/fileTree.ts';
import { isEditablePreviewTextPath, normalizePreviewPath, resolvePreviewPath, validatePreviewPath } from '../src/preview/core/pathUtils.ts';
import { deleteFile, fileExists, listFiles, readFile, writeFile } from '../src/preview/core/virtualFs.ts';
import { createHtmlTemplate } from '../src/preview/templates/htmlTemplate.ts';
import { PreviewRevisionAdvancedError, readSessionPreviewProjectFiles } from '../src/api/previewProject.ts';
import { listAllowedDependencies, resolveAllowedDependency } from '../src/preview/runtime/compiler/dependencyResolver.ts';
import { normalizeDiagnostics } from '../src/preview/runtime/compiler/diagnostics.ts';
import { createVirtualFsPlugin, loaderForPath, resolveVirtualModule } from '../src/preview/runtime/compiler/virtualFsPlugin.ts';
import { isWorkerToMainMessage } from '../src/preview/runtime/workerProtocol.ts';
import type { MainToWorkerMessage, PreviewBuildResult, WorkerToMainMessage } from '../src/preview/runtime/workerProtocol.ts';
import { isParentToRuntimeMessage, isRuntimeToParentMessage } from '../src/preview/runtime/runtimeProtocol.ts';
import { normalizeRuntimeError, serializeConsoleArgs } from '../src/preview/runtime/runtimeSerialization.ts';

test('templates initialize the required files', () => {
  const react = createReactTemplate();
  assert.deepEqual(listFiles(react), ['/index.html', '/src/App.tsx', '/src/main.tsx', '/src/style.css']);
  assert.deepEqual(listFiles(createHtmlTemplate()), ['/index.html', '/main.js', '/style.css']);
});

test('normalizes Unix and Windows paths and rejects traversal', () => {
  for (const path of ['src\\App.tsx', 'src/App.tsx', '/src//App.tsx', '/src/./App.tsx']) {
    assert.equal(normalizePreviewPath(path), '/src/App.tsx');
  }
  for (const path of ['../../secret', '/src/../../../secret']) {
    assert.equal(validatePreviewPath(path), false);
    assert.throws(() => normalizePreviewPath(path));
  }
});

test('reads, creates, overwrites and deletes immutable virtual files', () => {
  const initial = createReactTemplate();
  const created = writeFile(initial, '/src/test.ts', 'hello');
  assert.equal(readFile(created, '/src/test.ts'), 'hello');
  assert.equal(fileExists(initial, '/src/test.ts'), false);

  const overwritten = writeFile(writeFile(created, '/src/test.ts', 'version1'), '/src/test.ts', 'version2');
  assert.equal(readFile(overwritten, '/src/test.ts'), 'version2');
  assert.equal(listFiles(overwritten).filter((path) => path === '/src/test.ts').length, 1);

  const deleted = deleteFile(overwritten, '/src/test.ts');
  assert.equal(fileExists(deleted, '/src/test.ts'), false);
  assert.deepEqual(deleteFile(deleted, '/src/missing.ts'), deleted);
  assert.equal(readFile(deleted, '/src/missing.ts'), undefined);
});

test('builds a sorted multi-level file tree derived from files', () => {
  const files = {
    '/index.html': '',
    '/src/App.tsx': '',
    '/src/components/Button.tsx': '',
    '/src/components/form/Input.tsx': '',
  };
  const tree = buildFileTree(files);
  assert.equal(tree[0]?.path, '/src');
  assert.equal(tree[0]?.children?.find((node) => node.path === '/src/components')?.children?.find((node) => node.path === '/src/components/form')?.children?.[0]?.path, '/src/components/form/Input.tsx');

  const deleted = deleteFile(files, '/src/components/Button.tsx');
  assert.equal(JSON.stringify(buildFileTree(deleted)).includes('Button.tsx'), false);
});

test('files are structured-cloneable and isolated from the real Web source tree', () => {
  const virtualPath = `/src/components/virtual-fs-${Date.now()}.tsx`;
  const diskPath = resolve(process.cwd(), `.${virtualPath}`);
  assert.equal(existsSync(diskPath), false);
  const files = writeFile(createReactTemplate(), virtualPath, 'test');
  const copy = structuredClone(files);
  assert.equal(copy[virtualPath], 'test');
  assert.equal(existsSync(diskPath), false);
});

test('reset restores a fresh default template', () => {
  const initial = createReactTemplate();
  const changed = writeFile(initial, '/src/components/Test.tsx', 'test');
  assert.equal(fileExists(changed, '/src/components/Test.tsx'), true);
  const reset = createReactTemplate();
  assert.equal(fileExists(reset, '/src/components/Test.tsx'), false);
  assert.deepEqual(reset, initial);
});

test('Preview store starts and clears without an implicit starter project', () => {
  const store = usePreviewProjectStore.getState();
  store.clearProject();
  assert.equal(usePreviewProjectStore.getState().project.id, '');
  assert.deepEqual(usePreviewProjectStore.getState().getFilePaths(), []);

  usePreviewProjectStore.getState().createBlankProject('react');
  assert.ok(usePreviewProjectStore.getState().project.id);
  assert.deepEqual(usePreviewProjectStore.getState().getFilePaths(), []);
});

test('store orchestrates Core and exposes cloneable project files', () => {
  const store = usePreviewProjectStore.getState();
  store.createProject('react');
  usePreviewProjectStore.getState().writeFile('/src/test.ts', 'hello');
  assert.equal(usePreviewProjectStore.getState().readFile('/src/test.ts'), 'hello');
  assert.doesNotThrow(() => structuredClone(usePreviewProjectStore.getState().project.files));
  usePreviewProjectStore.getState().resetProject();
  assert.equal(usePreviewProjectStore.getState().readFile('/src/test.ts'), undefined);
  assert.deepEqual(usePreviewProjectStore.getState().getFilePaths(), ['/index.html', '/src/App.tsx', '/src/main.tsx', '/src/style.css']);
});

test('restoring a project preserves its stable identity instead of creating a duplicate ID', () => {
  const store = usePreviewProjectStore.getState();
  const projectId = 'preview-stable-project-id';
  store.importProject('react', createReactTemplate(), 'Weather', projectId);
  assert.equal(usePreviewProjectStore.getState().project.id, projectId);
  store.importProject('react', createReactTemplate(), 'Weather');
  assert.notEqual(usePreviewProjectStore.getState().project.id, projectId);
});

test('a per-message project snapshot stays isolated when the shared project reuses the same path', () => {
  const store = usePreviewProjectStore.getState();
  store.createProject('react');
  const initial = usePreviewProjectStore.getState().project;
  usePreviewProjectStore.getState().applyAiFileChange({
    projectId: initial.id,
    path: '/src/App.tsx',
    content: 'export default function App() { return <h1>First project</h1>; }',
  });
  const firstTurnSnapshot = structuredClone(usePreviewProjectStore.getState().project);
  usePreviewProjectStore.getState().applyAiFileChange({
    projectId: initial.id,
    path: '/src/App.tsx',
    content: 'export default function App() { return <h1>Second project</h1>; }',
  });

  assert.equal(usePreviewProjectStore.getState().project.id, initial.id);
  assert.match(usePreviewProjectStore.getState().readFile('/src/App.tsx') ?? '', /Second project/);
  assert.match(firstTurnSnapshot.files['/src/App.tsx'], /First project/);
});

test('generic text changes keep one project revision and immutable message snapshots', () => {
  const store = usePreviewProjectStore.getState();
  store.createProject('react');
  const initial = usePreviewProjectStore.getState().project;
  assert.equal(initial.revision, 0);
  assert.equal(isEditablePreviewTextPath('/src/styles.less'), true);
  assert.equal(isEditablePreviewTextPath('/src/Panel.vue'), true);
  assert.equal(isEditablePreviewTextPath('/src/Example.astro'), true);
  assert.equal(isEditablePreviewTextPath('/src/logo.png'), false);
  assert.equal(isEditablePreviewTextPath('/src/model.glb'), false);
  assert.equal(usePreviewProjectStore.getState().applyAiFileChange({
    projectId: initial.id, path: '/src/App.tsx', content: 'export default function App() { return <main>First</main>; }', revision: 1,
  }), true);
  const first = createMessagePreviewSnapshot(usePreviewProjectStore.getState().project, 'first-turn', ['/src/App.tsx']);
  assert.equal(usePreviewProjectStore.getState().applyAiFileChange({
    projectId: initial.id, path: '/src/styles.less', content: '.chat { color: violet; }', revision: 2,
  }), true);
  const second = createMessagePreviewSnapshot(usePreviewProjectStore.getState().project, 'second-turn', ['/src/App.tsx', '/src/styles.less']);
  assert.equal(second.id, first.id);
  assert.equal(second.revision, 2);
  assert.equal(first.revision, 1);
  assert.equal(first.files['/src/styles.less'], undefined);
  assert.equal(second.files['/src/styles.less'], '.chat { color: violet; }');
  assert.equal(usePreviewProjectStore.getState().applyAiFileChange({
    projectId: initial.id, path: '/src/App.tsx', content: 'stale overwrite', revision: 1,
  }), false);
  assert.match(usePreviewProjectStore.getState().project.files['/src/App.tsx'], /First/);
});

test('message snapshots separate a React app from stale 3D scene files in the shared Virtual FS', () => {
  const scene = validateSceneSpec({
    version: 1,
    name: 'Car',
    objects: [{ id: 'body', name: 'Body', geometry: 'box', size: [2, 1, 1], position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], color: '#d62828', metalness: 0, roughness: 1, copy_offsets: [] }],
  });
  const sharedFiles = {
    '/index.html': '<title>Guangzhou Weather</title><script type="module" src="/src/main.ts"></script>',
    '/src/main.ts': `import spec from './scene.json';`,
    '/src/scene.json': JSON.stringify(scene),
    '/src/main.tsx': createReactTemplate()['/src/main.tsx'],
    '/src/App.tsx': 'export default function App() { return <h1>Guangzhou Weather</h1>; }',
    '/src/style.css': 'body { color: blue; }',
  };
  const sharedProject = { id: 'shared-id', name: 'Shared', template: 'react' as const, files: sharedFiles };

  const carSnapshot = createMessagePreviewSnapshot(sharedProject, 'car-turn', ['/src/scene.json']);
  const weatherSnapshot = createMessagePreviewSnapshot(sharedProject, 'weather-turn', ['/src/App.tsx', '/index.html']);

  assert.equal(carSnapshot.template, 'html');
  assert.equal(previewSnapshotExtension(carSnapshot), '.glb');
  assert.equal(carSnapshot.files['/src/App.tsx'], undefined);
  assert.equal(carSnapshot.files['/src/scene.json'] !== undefined, true);
  assert.equal(weatherSnapshot.template, 'react');
  assert.equal(previewSnapshotExtension(weatherSnapshot), '.html');
  assert.equal(weatherSnapshot.files['/src/scene.json'], undefined);
  assert.equal(weatherSnapshot.files['/src/main.ts'], undefined);
  assert.equal(weatherSnapshot.name, 'Guangzhou Weather');
  assert.match(weatherSnapshot.files['/index.html'], /src="\/src\/main\.tsx"/);
  assert.match(weatherSnapshot.files['/src/App.tsx'], /Guangzhou Weather/);
});

test('a valid scene renderer stays a GLB artifact when the message change-path list is incomplete', () => {
  const scene = validateSceneSpec({
    version: 1,
    name: '简易机器人',
    objects: [{ id: 'body', name: '主体', geometry: 'box', size: [1, 1, 1], position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], color: '#8b5cf6', metalness: 0, roughness: 1, copy_offsets: [] }],
  });
  const project = {
    id: 'scene-project',
    name: scene.name,
    template: 'react' as const,
    files: createSceneProjectFiles(scene),
  };

  const snapshot = createMessagePreviewSnapshot(project, 'scene-turn', []);

  assert.equal(snapshot.name, scene.name);
  assert.equal(snapshot.template, 'html');
  assert.equal(previewSnapshotExtension(snapshot), '.glb');
  assert.equal(isSceneRendererProject(snapshot.files), true);
});

test('a scene generation build request is marked for automatic GLB export', () => {
  const store = usePreviewProjectStore.getState();
  store.createBlankProject('react');
  store.requestBuildAndRun(true);
  const afterSceneGeneration = usePreviewProjectStore.getState();
  assert.equal(afterSceneGeneration.buildRunGlbRevision, afterSceneGeneration.buildRunRevision);

  afterSceneGeneration.requestBuildAndRun();
  const afterNormalBuild = usePreviewProjectStore.getState();
  assert.notEqual(afterNormalBuild.buildRunGlbRevision, afterNormalBuild.buildRunRevision);
});

test('compact scene commits hydrate the actual batch-sync pipeline and survive refresh', () => {
  const scene = validateSceneSpec({
    version: 1, name: '简易场景',
    objects: [{ id: 'body', name: 'Body', geometry: 'box', size: [1, 1, 1], position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], color: '#8b5cf6', metalness: 0, roughness: 1, copy_offsets: [] }],
  });
  const store = usePreviewProjectStore.getState();
  // Reproduce both an empty project and the previous Todo mixed into the VFS.
  for (const withOldReact of [false, true]) {
    if (withOldReact) store.createProject('react');
    else store.createBlankProject('react');
    const id = usePreviewProjectStore.getState().project.id;
    assert.equal(store.applyAiProjectCommit({ projectId: id, changedFiles: [{ path: '/src/scene.json', content: JSON.stringify(scene) }], contentRevision: 1, serverRevision: 2 }), true);
    const project = usePreviewProjectStore.getState().project;
    assert.equal(project.name, scene.name);
    assert.equal(project.template, 'html');
    assert.equal(isSceneRendererProject(project.files), true);
    assert.match(project.files['/index.html'], /src="\/src\/main\.ts"/);
    const snapshot = createMessagePreviewSnapshot(project, 'scene-turn', ['/src/App.tsx', '/src/main.tsx', '/src/scene.json']);
    assert.equal(snapshot.outputExtension, '.glb');
    assert.equal(snapshot.files['/src/App.tsx'], undefined);
  }
  store.importProject('html', { '/src/scene.json': JSON.stringify(scene) }, 'New React Project', 'restored-scene', 1, 2);
  assert.equal(isSceneRendererProject(usePreviewProjectStore.getState().project.files), true);
  assert.equal(usePreviewProjectStore.getState().project.name, scene.name);
  // Repair legacy scene-only React snapshots without requiring a default template.
  store.importProject('react', { '/src/scene.json': JSON.stringify(scene) }, 'Legacy', 'legacy', 1, 2);
  assert.equal(usePreviewProjectStore.getState().project.template, 'html');
  const before = usePreviewProjectStore.getState().project;
  assert.equal(store.applyAiProjectCommit({ projectId: before.id, changedFiles: [{ path: '/src/scene.json', content: '{}' }], contentRevision: 2, serverRevision: 3 }), false);
  assert.equal(usePreviewProjectStore.getState().project, before);
  assert.equal(store.applyAiProjectCommit({ projectId: before.id, changedFiles: [
    { path: '/src/App.jsx', content: 'export default function App() { return <h1>React Todo Demo</h1>; }' },
    { path: '/src/main.jsx', content: "import React from 'react'; import { createRoot } from 'react-dom/client'; import App from './App.jsx'; createRoot(document.getElementById('root')).render(<App />);" },
  ], contentRevision: 2, serverRevision: 3 }), true);
  const react = usePreviewProjectStore.getState().project;
  assert.equal(isSceneRendererProject(react.files), false);
  assert.equal(react.template, 'react');
  assert.match(react.files['/index.html'], /src="\/src\/main\.jsx"/);
  assert.equal(createMessagePreviewSnapshot(react, 'react-turn', ['/src/App.jsx', '/src/main.jsx']).outputExtension, '.html');
  assert.equal(previewArtifactName(react, '.html'), 'React Todo Demo.html');
  store.importProject(react.template, react.files, react.name, react.id, 2, 3);
  assert.equal(isSceneRendererProject(usePreviewProjectStore.getState().project.files), false);
  store.clearProject();
});

test('new React and 3D requests create independent blank project identities without carrying old files', () => {
  for (const request of ['生成一份简单的react-demo', '新建一个React项目', '生成一个简单的3d模型', '创建一个3D项目']) assert.equal(isNewPreviewProjectRequest(request), true, request);
  for (const request of ['修改这个React项目', '继续完善当前项目', '给当前页面生成一个按钮', '不要生成react项目', '怎么创建3D模型']) assert.equal(isNewPreviewProjectRequest(request), false, request);
  const store = usePreviewProjectStore.getState();
  store.createBlankProject('react');
  const reactId = usePreviewProjectStore.getState().project.id;
  store.applyAiProjectCommit({ projectId: reactId, changedFiles: Object.entries(createReactTemplate()).map(([path, content]) => ({ path, content })), contentRevision: 1, serverRevision: 1 });
  const archivedReact = createMessagePreviewSnapshot(usePreviewProjectStore.getState().project, 'react-message', ['/src/App.tsx', '/src/main.tsx']);
  store.createBlankProject('html');
  const sceneId = usePreviewProjectStore.getState().project.id;
  assert.notEqual(sceneId, reactId);
  assert.deepEqual(Object.keys(usePreviewProjectStore.getState().project.files), []);
  assert.equal(archivedReact.outputExtension, '.html');
  assert.equal(archivedReact.files['/src/scene.json'], undefined);
  const scene = validateSceneSpec({ version: 1, name: 'Scene', objects: [{ id: 'body', name: 'Body', geometry: 'box', size: [1, 1, 1], position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], color: '#8b5cf6', metalness: 0, roughness: 1, copy_offsets: [] }] });
  store.applyAiProjectCommit({ projectId: sceneId, changedFiles: [{ path: '/src/scene.json', content: JSON.stringify(scene) }], contentRevision: 1, serverRevision: 2 });
  const archivedScene = createMessagePreviewSnapshot(usePreviewProjectStore.getState().project, 'scene-message', ['/src/scene.json']);
  assert.equal(archivedScene.outputExtension, '.glb');
  assert.equal(archivedScene.files['/src/App.tsx'], undefined);
  store.createBlankProject('react');
  assert.notEqual(usePreviewProjectStore.getState().project.id, sceneId);
  assert.deepEqual(Object.keys(usePreviewProjectStore.getState().project.files), []);
  assert.equal(archivedScene.outputExtension, '.glb');
  store.clearProject();
});

test('preview artifact tooltips expose the final output extension for current and future file types', () => {
  assert.equal(fileExtension('/models/car.GLB?download=1'), '.glb');
  assert.equal(fileExtension('/src/App.tsx'), '.tsx');
  assert.equal(generatedFileExtension({ fileType: '3d', displayName: 'Red car' }), '.glb');
  assert.equal(generatedFileExtension({ fileType: 'image', displayName: 'preview.webp' }), '.webp');
  assert.equal(previewArtifactTooltip('Guangzhou Weather', '.html'), 'Guangzhou Weather · .html');
  assert.equal(isSamePreviewArtifact('session-project', '广州天气.html', 'message-snapshot', '广州天气.html'), true);
  assert.equal(isSamePreviewArtifact('session-project', '广州天气.html', 'other-project', '红色汽车.glb'), false);
});

test('preview artifact names use content titles and the delivered extension, never template labels', () => {
  const reactProject = {
    name: 'React Preview',
    files: {
      '/index.html': '<title>今日广州天气 · React Demo</title>',
      '/src/App.tsx': "const city = '广州'; const weather = 'Sunny';",
    },
  };
  const sceneProject = {
    name: 'React Preview',
    files: { '/src/scene.json': JSON.stringify({ name: '红色低多边形汽车', objects: [] }) },
  };
  assert.equal(previewArtifactName(reactProject, '.html'), '今日广州天气.html');
  assert.equal(previewArtifactName(sceneProject, '.glb'), '红色低多边形汽车.glb');
});

test('workspace and message snapshot deduplicate the same output across mixed-stack workspace files', () => {
  const workspace = { '/index.html': '<title>Weather</title>', '/src/App.tsx': 'export default "weather";' };
  const sameSnapshot = { ...workspace };
  const differentProject = { ...workspace, '/src/App.tsx': 'export default "car";' };
  assert.equal(haveSamePreviewArtifactFiles(workspace, '.html', sameSnapshot, '.html'), true);
  assert.equal(haveSamePreviewArtifactFiles(workspace, '.html', differentProject, '.html'), false);
  assert.equal(haveSamePreviewArtifactFiles(workspace, '.html', { '/index.html': workspace['/index.html'] }, '.html'), false);

  const scene = JSON.stringify({ name: '汽车', objects: [{ id: 'body', color: '#d00' }] });
  const sceneWorkspace = {
    '/index.html': '<script type="module" src="/src/main.ts"></script>',
    '/src/main.ts': "import spec from './scene.json'; new THREE.WebGLRenderer();",
    '/src/scene.json': scene,
    '/src/App.tsx': 'stale React source',
  };
  const sceneSnapshot = { '/src/scene.json': JSON.stringify({ objects: [{ color: '#d00', id: 'body' }], name: '汽车' }) };
  const otherScene = { '/src/scene.json': JSON.stringify({ name: '汽车', objects: [{ id: 'body', color: '#00d' }] }) };
  assert.equal(haveSamePreviewArtifactFiles(sceneWorkspace, '.glb', sceneSnapshot, '.glb'), true);
  assert.equal(haveSamePreviewArtifactFiles(sceneWorkspace, '.glb', otherScene, '.glb'), false);
  assert.equal(haveSamePreviewArtifactFiles(sceneWorkspace, '.glb', sceneSnapshot, '.html'), false);

  const mixedReactWorkspace = {
    ...workspace,
    '/src/scene.json': scene,
    '/src/main.ts': "import spec from './scene.json'; new THREE.WebGLRenderer();",
  };
  assert.equal(haveSamePreviewArtifactFiles(mixedReactWorkspace, '.html', sameSnapshot, '.html'), true);
});

test('Preview Worker is considered empty only after every visible artifact source is gone', () => {
  const empty = { currentProjectVisible: false, projectSnapshotCount: 0, generatedFileCount: 0, uploadedAttachmentCount: 0, hasImportedDist: false };
  assert.equal(hasPreviewFiles(empty), false);
  assert.equal(hasPreviewFiles({ ...empty, projectSnapshotCount: 1 }), true);
  assert.equal(hasPreviewFiles({ ...empty, generatedFileCount: 1 }), true);
  assert.equal(hasPreviewFiles({ ...empty, uploadedAttachmentCount: 1 }), true);
  assert.equal(hasPreviewFiles({ ...empty, currentProjectVisible: true }), true);
  assert.equal(hasPreviewFiles({ ...empty, hasImportedDist: true }), true);
});

test('Preview Worker entry eligibility only counts files the worker can render', () => {
  assert.equal(isPreviewableGeneratedFile({ fileType: 'html', displayName: 'demo.html', downloadUrl: '/demo.html' }), true);
  assert.equal(isPreviewableGeneratedFile({ fileType: 'pdf', displayName: 'report.pdf', downloadUrl: '/report.pdf' }), true);
  assert.equal(isPreviewableGeneratedFile({ fileType: 'file', displayName: 'notes.txt', downloadUrl: '/notes.txt' }), false);
  assert.equal(isPreviewableUploadedAttachment({ kind: 'archive', name: 'source.zip', storageId: 'archive-id' }), true);
  assert.equal(isPreviewableUploadedAttachment({ kind: 'folder', name: 'source', previewStorageId: 'folder-id' }), true);
  assert.equal(isPreviewableUploadedAttachment({ kind: 'file', name: 'notes.pdf', storageId: 'file-id' }), false);
});

test('an empty virtual file tree is not treated as a current source just because its project was persisted', () => {
  assert.equal(hasCurrentProjectSource(0, false, true, 0), false);
  assert.equal(hasCurrentProjectSource(0, true, false, 0), false);
  assert.equal(hasCurrentProjectSource(1, false, true, 0), true);
  assert.equal(hasCurrentProjectSource(0, false, false, 1), true);
});

test('project snapshots suppress only same-message HTML entry artifacts from Preview files', () => {
  const messages = [{
    id: 'weather-turn',
    role: 'assistant' as const,
    content: '',
    previewSnapshot: { messageId: 'weather-turn', id: 'p', name: 'Weather', template: 'react' as const, outputExtension: '.html', files: {} },
    files: [{ fileType: 'html', displayName: 'Guangzhou Weather.html', downloadUrl: '/download/weather-html' }],
    projectChanges: [{ path: '/Guangzhou Weather.html', diff: '' }],
  }, {
    id: 'standalone-html',
    role: 'assistant' as const,
    content: '',
    files: [{ fileType: 'html', displayName: 'Report.html', downloadUrl: '/download/report' }],
  }, {
    id: 'glb-turn',
    role: 'assistant' as const,
    content: '',
    previewSnapshot: { messageId: 'glb-turn', id: 'p2', name: 'Car', template: 'html' as const, outputExtension: '.glb', files: {} },
    files: [{ fileType: '3d', displayName: 'Car.glb', downloadUrl: '/download/car' }],
  }];
  const suppressed = getSnapshotBackedHtmlArtifactUrls(messages);
  assert.deepEqual([...suppressed].sort(), ['//Guangzhou%20Weather.html', '/download/weather-html'].sort());
  assert.equal(suppressed.has('/download/report'), false);
  assert.equal(suppressed.has('/download/car'), false);
});

test('restored HTML-template project snapshot suppresses legacy project HTML entry rows', () => {
  const messages = [{
    id: 'react-project',
    role: 'assistant' as const,
    content: '',
    // Restored React projects may be normalized to the html template, so dedupe
    // should depend on the existence of a project snapshot, not its template label.
    previewSnapshot: { messageId: 'react-project', id: 'p', name: 'Weather', template: 'html' as const, outputExtension: '.html', files: {} },
  }];
  const projectChanges = [{ path: '/Guangzhou Weather.html', diff: '' }];
  assert.equal(getSnapshotBackedHtmlArtifactUrls(messages, projectChanges).has('//Guangzhou%20Weather.html'), true);
});

test('AI virtual file changes stay in memory and request a single Build & Run', () => {
  usePreviewProjectStore.getState().createProject('react');
  const original = usePreviewProjectStore.getState().project;
  assert.equal(usePreviewProjectStore.getState().applyAiFileChange({
    projectId: original.id,
    path: '/src/App.tsx',
    content: 'export default function App() { return <h1>Virtual only</h1>; }',
  }), true);
  assert.match(usePreviewProjectStore.getState().readFile('/src/App.tsx') ?? '', /Virtual only/);
  assert.equal(usePreviewProjectStore.getState().applyAiFileChange({
    projectId: 'stale-project', path: '/src/App.tsx', content: 'stale',
  }), false);
  assert.equal(usePreviewProjectStore.getState().applyAiFileChange({
    projectId: original.id, path: '/src/../secret.ts', content: 'unsafe',
  }), false);
  const beforeRevision = usePreviewProjectStore.getState().buildRunRevision;
  usePreviewProjectStore.getState().requestBuildAndRun();
  assert.equal(usePreviewProjectStore.getState().buildRunRevision, beforeRevision + 1);
  usePreviewProjectStore.getState().createProject('react');
  assert.equal(usePreviewProjectStore.getState().buildRunRevision, 0);
  assert.doesNotMatch(usePreviewProjectStore.getState().readFile('/src/App.tsx') ?? '', /Virtual only/);
});

test('batched server sync applies one revision atomically and ignores a slower stale response', () => {
  const store = usePreviewProjectStore.getState();
  const template = createReactTemplate();
  store.importProject('react', template, 'Sync Race', 'preview-sync-race', 10, 4);
  let notifications = 0;
  const unsubscribe = usePreviewProjectStore.subscribe(() => notifications++);
  try {
    const applied = usePreviewProjectStore.getState().applyAiProjectCommit({
      projectId: 'preview-sync-race',
      contentRevision: 12,
      serverRevision: 6,
      changedFiles: [
        { path: '/src/App.tsx', content: 'export default function App() { return <h1>Revision 12</h1>; }' },
        { path: '/src/style.css', content: 'body { color: purple; }' },
        { path: '/index.html', content: '<div id="latest-root"></div>' },
      ],
    });
    assert.equal(applied, true);
    assert.equal(notifications, 1);
    assert.equal(usePreviewProjectStore.getState().project.revision, 12);
    assert.equal(usePreviewProjectStore.getState().project.serverRevision, 6);
    assert.match(usePreviewProjectStore.getState().readFile('/src/App.tsx') ?? '', /Revision 12/);
    assert.equal(usePreviewProjectStore.getState().readFile('/src/style.css'), 'body { color: purple; }');
    assert.equal(usePreviewProjectStore.getState().readFile('/index.html'), '<div id="latest-root"></div>');

    const staleApplied = usePreviewProjectStore.getState().applyAiProjectCommit({
      projectId: 'preview-sync-race',
      contentRevision: 11,
      serverRevision: 5,
      changedFiles: [{ path: '/src/App.tsx', content: 'stale revision 11' }],
    });
    assert.equal(staleApplied, false);
    assert.equal(notifications, 1);
    assert.equal(usePreviewProjectStore.getState().project.revision, 12);
    assert.match(usePreviewProjectStore.getState().readFile('/src/App.tsx') ?? '', /Revision 12/);
  } finally {
    unsubscribe();
  }
});

test('changed Preview files are fetched in one revision-pinned batch request', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls++;
    assert.equal(String(input), '/api/chat/session/session-1/preview-project/files/read');
    assert.equal(init?.method, 'POST');
    const request = JSON.parse(String(init?.body));
    assert.deepEqual(request, {
      projectId: 'preview-sync-race',
      paths: ['/src/App.tsx', '/src/style.css', '/index.html'],
      expectedRevision: 12,
    });
    return new Response(JSON.stringify({
      success: true,
      projectId: 'preview-sync-race',
      revision: 12,
      serverRevision: 6,
      files: [
        { path: '/src/App.tsx', content: 'export default "current";' },
        { path: '/src/style.css', content: 'body { color: purple; }' },
        { path: '/index.html', content: '<div id="root"></div>' },
      ],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  try {
    const result = await readSessionPreviewProjectFiles(
      'session-1', 'preview-sync-race', ['/src/App.tsx', '/src/style.css', '/index.html'], 12,
    );
    assert.equal(calls, 1);
    assert.equal(result.revision, 12);
    assert.equal(result.files.length, 3);
    assert.ok(result.payloadBytes > 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('revision advanced sync response forces latest-project recovery instead of stale file application', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({
    success: false,
    code: 'PREVIEW_REVISION_ADVANCED',
    requestedRevision: 11,
    currentRevision: 12,
  }), { status: 409, headers: { 'Content-Type': 'application/json' } })) as typeof fetch;
  try {
    await assert.rejects(
      readSessionPreviewProjectFiles('session-1', 'preview-sync-race', ['/src/App.tsx'], 11),
      (error: unknown) => error instanceof PreviewRevisionAdvancedError && error.currentRevision === 12,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('resolves safe relative paths without allowing virtual-root escape', () => {
  assert.equal(resolvePreviewPath('/src/components', '../App.tsx'), '/src/App.tsx');
  assert.equal(resolvePreviewPath('/', './src/main.tsx'), '/src/main.tsx');
  assert.throws(() => resolvePreviewPath('/src', '../../secret.ts'));
});

test('resolves extensions and index modules from the existing Virtual FS', () => {
  const files = {
    '/src/main.tsx': '',
    '/src/App.tsx': '',
    '/src/helpers/index.ts': '',
    '/src/view/index.jsx': '',
    '/src/theme.css': '',
  };
  assert.equal(resolveVirtualModule(files, './App', '/src/main.tsx'), '/src/App.tsx');
  assert.equal(resolveVirtualModule(files, './helpers', '/src/main.tsx'), '/src/helpers/index.ts');
  assert.equal(resolveVirtualModule(files, './view', '/src/main.tsx'), '/src/view/index.jsx');
  assert.equal(resolveVirtualModule(files, './theme.css', '/src/main.tsx'), '/src/theme.css');
  assert.throws(() => resolveVirtualModule(files, './missing', '/src/main.tsx'));
});

test('maps supported loaders and rejects unknown file types', () => {
  assert.equal(loaderForPath('/a.ts'), 'ts');
  assert.equal(loaderForPath('/a.tsx'), 'tsx');
  assert.equal(loaderForPath('/a.js'), 'js');
  assert.equal(loaderForPath('/a.jsx'), 'jsx');
  assert.equal(loaderForPath('/a.css'), 'css');
  assert.equal(loaderForPath('/a.json'), 'json');
  assert.throws(() => loaderForPath('/a.vue'), /Unsupported/);
});

test('dependency resolver allows React and Three, not addons or arbitrary packages', () => {
  assert.equal(resolveAllowedDependency('react'), 'react');
  assert.equal(resolveAllowedDependency('react-dom/client'), 'react-dom/client');
  assert.equal(resolveAllowedDependency('three'), 'three');
  for (const dependency of ['three/addons/controls/OrbitControls.js', 'three/examples/jsm/loaders/GLTFLoader.js', '@react-three/fiber', '@react-three/drei']) {
    assert.throws(() => resolveAllowedDependency(dependency), /not allowed/);
  }
  assert.ok(listAllowedDependencies().includes('react/jsx-runtime'));
  assert.throws(() => resolveAllowedDependency('left-pad'), /not allowed/);
  assert.throws(() => resolveAllowedDependency('https://cdn.example/app.js'), /not allowed/);
});

test('virtual HTML selects Three entry without replacing the React template', () => {
  const project = { id: 'test', name: 'test', template: 'react' as const, files: createReactTemplate() };
  assert.equal(getPreviewEntryPoint(project), '/src/main.tsx');
  project.files['/index.html'] = `<title>汽车公路</title><script type="module" src="./src/main.ts"></script>`;
  assert.equal(getPreviewEntryPoint(project), '/src/main.ts');
  project.files['/index.html'] = `<script src="ignored.js"></script>`;
  assert.equal(getPreviewEntryPoint(project), '/src/main.tsx');
});

test('actual esbuild compiles multi-file Three geometry plus CSS and preserves React JSX', async () => {
  const files = {
    '/src/main.ts': `import * as THREE from 'three'; import { car } from './car'; import './style.css'; const scene = new THREE.Scene(); scene.add(car); console.log(scene);`,
    '/src/car.ts': `import { Group, Mesh, BoxGeometry, MeshStandardMaterial } from 'three'; export const car = new Group(); car.add(new Mesh(new BoxGeometry(2, 1, 4), new MeshStandardMaterial()));`,
    '/src/style.css': 'canvas { display: block; }',
  };
  const compile = (input: Record<string, string>, entry: string) => build({
    entryPoints: [entry], bundle: true, write: false, outdir: '/out', format: 'iife',
    platform: 'browser', jsx: 'automatic', logLevel: 'silent', plugins: [createVirtualFsPlugin(() => input)],
  });
  const result = await compile(files, '/src/main.ts');
  assert.ok(result.outputFiles?.some(file => file.path.endsWith('.css')));
  assert.match(result.outputFiles?.find(file => file.path.endsWith('.js'))?.text ?? '', /__GOR_PREVIEW_RUNTIME__\.THREE/);
  assert.ok((await compile(createReactTemplate(), '/src/main.tsx')).outputFiles?.length);
  const defaultReactDomClient = createReactTemplate();
  defaultReactDomClient['/src/main.tsx'] = `import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
ReactDOM.createRoot(document.getElementById('root')!).render(React.createElement(App));`;
  assert.ok((await compile(defaultReactDomClient, '/src/main.tsx')).outputFiles?.length);
  await assert.rejects(compile({ '/bad.ts': `import 'three/addons/controls/OrbitControls.js';` }, '/bad.ts'), /not allowed/);
  await assert.rejects(compile({ '/bad.ts': 'const broken = ;' }, '/bad.ts'), /Unexpected/);
  await assert.rejects(compile(files, '/missing.ts'), /Cannot resolve/);
});

test('legacy Babel React HTML compiles ordered components, global runtime and linked CSS without changing source', async () => {
  const project = { id: 'babel-react', name: 'React Demo', template: 'react' as const, revision: 1, files: {
    '/index.html': `<link rel="stylesheet" href="./src/styles.css">
<script src="https://unpkg.com/react@18/umd/react.production.min.js"></script>
<script type="text/babel" src="./src/Counter.jsx"></script>
<script type="text/babel" src="./src/App.jsx"></script>
<script type="text/babel" src="./src/main.jsx"></script>`,
    '/src/Counter.jsx': `const { useState } = React; function Counter() { const [count] = useState(2); return <p>{count}</p>; } window.Counter = Counter;`,
    '/src/App.jsx': `const { useState } = React; function App() { const [title] = useState('Demo'); return <main>{title}<Counter /></main>; } window.App = App;`,
    '/src/main.jsx': `ReactDOM.createRoot(document.getElementById('root')).render(<App />);`,
    '/src/styles.css': `body { background: #123456; }`,
  } };
  const original = structuredClone(project.files);
  const snapshot = createMessagePreviewSnapshot(project, 'message-babel', Object.keys(project.files));
  assert.equal(snapshot.files['/index.html'], original['/index.html'], 'snapshot must not replace CDN script with main.jsx');
  assert.equal(getPreviewEntryPoint(project), BABEL_PREVIEW_ENTRY);
  const input = preparePreviewCompilation(snapshot.files, getPreviewEntryPoint(project));
  const result = await build({ entryPoints: [BABEL_PREVIEW_ENTRY], bundle: true, write: false,
    outdir: '/out', format: 'iife', platform: 'browser', jsx: 'automatic',
    plugins: [createVirtualFsPlugin(() => input)], logLevel: 'silent' });
  assert.match(result.outputFiles?.find(file => file.path.endsWith('.css'))?.text ?? '', /#123456/);
  const output = result.outputFiles?.find(file => file.path.endsWith('.js'))?.text ?? '';
  assert.doesNotMatch(output, /unpkg\.com|babel\.min\.js/, 'no CDN or Babel script is loaded');
  let rendered: any;
  const jsx = (type: any, props: any) => ({ type, props });
  const context: any = { document: { getElementById: () => ({}) }, __GOR_PREVIEW_RUNTIME__: {
    React: { useState: (value: any) => [value] }, ReactDOM: {},
    ReactDOMClient: { createRoot: () => ({ render: (element: any) => { rendered = element.type(); } }) },
    jsxRuntime: { jsx, jsxs: jsx },
  } };
  context.window = context;
  runInNewContext(output, context);
  assert.equal(rendered.type, 'main');
  assert.equal(context.Counter().props.children, 2);
  assert.deepEqual(project.files, original);
  assert.equal(snapshot.files[BABEL_PREVIEW_ENTRY], undefined, 'compiler scaffolding is not user source');
});

test('entry fallback uses existing JSX and preserves explicit missing module diagnostics', () => {
  const project = { id: 'jsx', name: 'JSX', template: 'react' as const,
    files: { '/index.html': '<div id="root"></div>', '/src/main.jsx': '' } };
  assert.equal(getPreviewEntryPoint(project), '/src/main.jsx');
  project.files['/index.html'] = '<script type="module" src="/src/missing.tsx"></script>';
  assert.equal(getPreviewEntryPoint(project), '/src/missing.tsx');
  assert.equal(preparePreviewCompilation(project.files, '/src/main.jsx'), project.files);
});

test('Babel adapter handles inline JSX and rejects external source, traversal, missing files and name collisions', async () => {
  const inline = preparePreviewCompilation({ '/index.html': '<script type="text/babel">window.App = () => <p>ok</p>;</script>' }, BABEL_PREVIEW_ENTRY);
  assert.match(inline['/__gor_babel_inline_0.jsx'], /window.App/);
  for (const src of ['https://example.com/main.jsx', '//example.com/main.jsx', '../private.jsx']) {
    assert.throws(() => preparePreviewCompilation({ '/index.html': `<script type="text/babel" src="${src}"></script>` }, BABEL_PREVIEW_ENTRY));
  }
  assert.throws(() => preparePreviewCompilation({ '/index.html': '<script type="text/babel">ok()</script>', [BABEL_PREVIEW_ENTRY]: 'user code' }, BABEL_PREVIEW_ENTRY), /conflicts/);
  const files = preparePreviewCompilation({ '/index.html': '<script type="text/babel" src="/src/missing.jsx"></script>' }, BABEL_PREVIEW_ENTRY);
  await assert.rejects(build({ entryPoints: [BABEL_PREVIEW_ENTRY], bundle: true, write: false,
    plugins: [createVirtualFsPlugin(() => files)], logLevel: 'silent' }), /Cannot resolve/);
});

test('runtime reload, reset and dispose discard old scene identity and listeners', () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const listeners = new Map<string, (event: any) => void>();
  const iframeListeners = new Map<string, unknown>();
  const sent: unknown[] = [];
  const contentWindow = { postMessage: (value: unknown) => sent.push(value) };
  const iframe = { src: '', contentWindow,
    addEventListener: (type: string, listener: unknown) => iframeListeners.set(type, listener),
    removeEventListener: (type: string) => iframeListeners.delete(type),
  };
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    addEventListener: (type: string, listener: (event: any) => void) => listeners.set(type, listener),
    removeEventListener: (type: string) => listeners.delete(type), clearTimeout,
  } });
  try {
    const events: unknown[] = [];
    const controller = new PreviewRuntimeController({ iframe: iframe as unknown as HTMLIFrameElement, runtimeUrl: '/preview-runtime.html', onEvent: value => events.push(value) });
    const result: PreviewBuildResult = { projectId: 'p', buildId: 'b1', entryPoint: '/src/main.ts', outputFiles: [{ path: '/out/bundle.js', type: 'js', contents: '/* never executed in this test */' }], warnings: [], duration: 0 };
    const first = controller.run(result);
    const second = controller.run({ ...result, buildId: 'b2' });
    assert.notEqual(first, second);
    assert.ok(iframe.src.includes(second));
    const message = { type: 'RUNTIME_READY', runtimeId: second, projectId: 'p', buildId: 'b2' };
    const receive = listeners.get('message')!;
    receive({ source: {}, data: message });
    receive({ source: contentWindow, data: { ...message, runtimeId: first, buildId: 'b1' } });
    assert.equal(events.length, 0);
    receive({ source: contentWindow, data: message });
    assert.equal(sent.length, 1);
    controller.reset();
    assert.equal(iframe.src, 'about:blank');
    receive({ source: contentWindow, data: message });
    assert.equal(events.length, 1);
    controller.dispose();
    assert.equal(listeners.size, 0);
    assert.equal(iframeListeners.size, 0);
  } finally {
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});

test('normalizes compiler diagnostics to cloneable plain data', () => {
  const diagnostics = normalizeDiagnostics([{ text: 'Expected identifier', location: { file: '/src/App.tsx', line: 4, column: 6, lineText: 'const App = (' } }]);
  assert.deepEqual(diagnostics, [{ message: 'Expected identifier', file: '/src/App.tsx', line: 4, column: 7, lineText: 'const App = (' }]);
  assert.doesNotThrow(() => structuredClone(diagnostics));
});

test('worker protocol messages and build results are structured-cloneable', () => {
  const toWorker: MainToWorkerMessage = { type: 'SYNC_FILES', requestId: 'request-1', projectId: 'project-1', files: createReactTemplate() };
  const result: PreviewBuildResult = {
    buildId: 'build-1',
    projectId: 'project-1',
    entryPoint: '/src/main.tsx',
    outputFiles: [
      { path: '/out/bundle.js', type: 'js', contents: 'export {}' },
      { path: '/out/bundle.css', type: 'css', contents: 'body{}' },
    ],
    warnings: [],
    duration: 12.5,
  };
  const fromWorker: WorkerToMainMessage = { type: 'BUILD_SUCCESS', requestId: 'request-1', result };
  assert.doesNotThrow(() => structuredClone(toWorker));
  assert.doesNotThrow(() => structuredClone(fromWorker));
  assert.equal(isWorkerToMainMessage(structuredClone(fromWorker)), true);
  assert.equal(isWorkerToMainMessage({ type: 'UNKNOWN' }), false);
});

test('a committed Preview source revision requests exactly one automatic build', () => {
  const store = usePreviewProjectStore.getState();
  store.createProject('react');
  const project = usePreviewProjectStore.getState().project;
  const changedApp = `${project.files['/src/App.tsx']}\n// committed edit\n`;
  assert.equal(usePreviewProjectStore.getState().applyAiProjectCommit({
    projectId: project.id,
    changedFiles: [{ path: '/src/App.tsx', content: changedApp }],
    contentRevision: 1,
    serverRevision: 1,
  }), true);
  assert.equal(usePreviewProjectStore.getState().buildRunRevision, 1);

  assert.equal(usePreviewProjectStore.getState().applyAiProjectCommit({
    projectId: project.id,
    changedFiles: [{ path: '/src/App.tsx', content: changedApp }],
    contentRevision: 2,
    serverRevision: 2,
  }), true);
  assert.equal(usePreviewProjectStore.getState().buildRunRevision, 1);
});

test('runtime protocol requires matching metadata and remains structured-cloneable', () => {
  const runtimeMessage = { type: 'RUNTIME_RUN' as const, runtimeId: 'runtime-1', projectId: 'project-1', buildId: 'build-1', javascript: '(() => {})()', css: 'body{}' };
  const hostReady = { type: 'RUNTIME_HOST_READY' as const, runtimeId: 'runtime-1' };
  const consoleMessage = { type: 'RUNTIME_CONSOLE' as const, runtimeId: 'runtime-1', projectId: 'project-1', buildId: 'build-1', entry: { runtimeId: 'runtime-1', projectId: 'project-1', buildId: 'build-1', level: 'log' as const, args: ['ready'], timestamp: 1 } };
  assert.equal(isParentToRuntimeMessage(runtimeMessage), true);
  assert.equal(isRuntimeToParentMessage(consoleMessage), true);
  assert.equal(isRuntimeToParentMessage(hostReady), true);
  assert.equal(isParentToRuntimeMessage({ type: 'RUNTIME_RUN', javascript: '' }), false);
  assert.doesNotThrow(() => structuredClone(runtimeMessage));
  assert.doesNotThrow(() => structuredClone(consoleMessage));
});

test('runtime console serialization handles Error and circular values', () => {
  const circular: { name: string; self?: unknown } = { name: 'preview' };
  circular.self = circular;
  const args = serializeConsoleArgs([circular, new Error('runtime test')]);
  assert.match(args[0] ?? '', /Circular/);
  assert.match(args[1] ?? '', /Error: runtime test/);
  const diagnostic = normalizeRuntimeError(new Error('runtime test'), { runtimeId: 'runtime-1', projectId: 'project-1', buildId: 'build-1' }, { source: 'bundle.js', line: 2, column: 3 });
  assert.equal(diagnostic.message, 'runtime test');
  assert.equal(diagnostic.line, 2);
  assert.doesNotThrow(() => structuredClone(diagnostic));
});
