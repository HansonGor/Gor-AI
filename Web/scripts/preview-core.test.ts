import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { build } from 'esbuild-wasm';
import { getPreviewEntryPoint } from '../src/preview/core/entryPoint.ts';
import { PreviewRuntimeController } from '../src/preview/runtime/runtimeController.ts';
import { buildFileTree } from '../src/preview/core/fileTree.ts';
import { normalizePreviewPath, resolvePreviewPath, validatePreviewPath } from '../src/preview/core/pathUtils.ts';
import { deleteFile, fileExists, listFiles, readFile, writeFile } from '../src/preview/core/virtualFs.ts';
import { createHtmlTemplate } from '../src/preview/templates/htmlTemplate.ts';
import { createReactTemplate } from '../src/preview/templates/reactTemplate.ts';
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
