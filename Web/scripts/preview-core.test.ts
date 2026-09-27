import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { unzipSync, strFromU8, strToU8, zipSync } from 'fflate';
import { createPreviewArchive, createPreviewDistArchive, previewArchiveName, previewDistArchiveName } from '../src/preview/core/exportProject.ts';
import { importPreviewArchive, importPreviewDirectory } from '../src/preview/core/importArchive.ts';
import { createReactTemplate } from '../src/preview/templates/reactTemplate.ts';
import { createMessagePreviewSnapshot } from '../src/preview/core/projectSnapshot.ts';
import { fileExtension, generatedFileExtension, haveSamePreviewArtifactFiles, isSamePreviewArtifact, previewArtifactName, previewArtifactTooltip, previewSnapshotExtension } from '../src/preview/core/artifactFormat.ts';
import { hasCurrentProjectSource, hasPreviewFiles } from '../src/preview/core/previewFilePresence.ts';
import { getSnapshotBackedHtmlArtifactUrls } from '../src/preview/core/snapshotArtifactDedup.ts';
import { canonicalizePresentationFiles, createPresentationSnapshot, isPresentationSnapshotFile, restorePresentationSnapshot } from '../src/preview/core/presentationSnapshot.ts';
import { createUploadSummaryRequest } from '../src/utils/uploadSummary.ts';
import { createSceneProjectFiles, exportSceneGlb, isSceneRendererProject, validateSceneSpec } from '../src/modeling/sceneSpec.ts';

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
  const sourceZip = createPreviewArchive(createReactTemplate());
  const imported = await importPreviewArchive(sourceZip, 'weather-source.zip');
  assert.equal(imported.kind, 'source');
  if (imported.kind !== 'source') return;
  assert.equal(imported.template, 'react');
  assert.equal(imported.files['/index.html'] !== undefined, true);
  assert.match(imported.files['/src/main.tsx'] ?? '', /createRoot/);
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
import { PreviewRuntimeController } from '../src/preview/runtime/runtimeController.ts';
import { buildFileTree } from '../src/preview/core/fileTree.ts';
import { normalizePreviewPath, resolvePreviewPath, validatePreviewPath } from '../src/preview/core/pathUtils.ts';
import { deleteFile, fileExists, listFiles, readFile, writeFile } from '../src/preview/core/virtualFs.ts';
import { createHtmlTemplate } from '../src/preview/templates/htmlTemplate.ts';
import { usePreviewProjectStore } from '../src/stores/previewProjectStore.ts';
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
