import { useCallback, useEffect, useMemo, useRef } from 'react';
import { readFile } from '../../preview/core/virtualFs';
import { getPreviewEntryPoint } from '../../preview/core/entryPoint';
import { usePreviewProjectStore } from '../../stores/previewProjectStore';
import { usePreviewCompiler } from '../../preview/runtime/usePreviewCompiler';
import { usePreviewRuntime } from '../../preview/runtime/usePreviewRuntime';
import PreviewFileTree from './PreviewFileTree';
import PreviewProjectToolbar from './PreviewProjectToolbar';
import PreviewSourceViewer from './PreviewSourceViewer';
import PreviewRuntimePanel from './PreviewRuntimePanel';

const TEST_FILE_PATH = '/src/components/Test.tsx';
const TEST_FILE_SOURCE = `export default function Test() {
  return <div>Test</div>;
}`;

export default function PreviewProject({ view }: { view: 'preview' | 'code' }) {
  const store = usePreviewProjectStore();
  const compiler = usePreviewCompiler(store.project.id, store.project.files);
  const runtime = usePreviewRuntime(store.project.id);
  const lastAutoRunRef = useRef(0);
  const lastRunFilesRef = useRef<typeof store.project.files | null>(null);
  const lastViewRef = useRef<typeof view | null>(null);
  const entryPoint = getPreviewEntryPoint(store.project);
  const source = useMemo(
    () =>
      store.selectedFilePath ? readFile(store.project.files, store.selectedFilePath) : undefined,
    [store.project.files, store.selectedFilePath],
  );

  const buildAndRun = useCallback(() => {
    lastRunFilesRef.current = store.project.files;
    void compiler.build(entryPoint).then((result) => {
      if (result) runtime.run(result);
    });
  }, [store.project.files, compiler.build, entryPoint, runtime.run]);

  useEffect(() => {
    if (store.buildRunRevision === 0 || store.buildRunRevision === lastAutoRunRef.current) return;
    lastAutoRunRef.current = store.buildRunRevision;
    buildAndRun();
  }, [store.buildRunRevision, buildAndRun]);

  useEffect(() => {
    if (
      view === 'preview' &&
      lastViewRef.current !== 'preview' &&
      lastRunFilesRef.current !== store.project.files
    ) {
      buildAndRun();
    }
    lastViewRef.current = view;
  }, [view, store.project.files, buildAndRun]);

  useEffect(() => {
    if (
      view === 'preview' &&
      compiler.state.status === 'ready' &&
      runtime.state.status === 'idle'
    ) {
      buildAndRun();
    }
  }, [view, compiler.state.status, runtime.state.status, buildAndRun]);

  return (
    <section className={`preview-project view-${view}`} aria-label="Preview Project">
      <div className="preview-project-code" aria-hidden={view !== 'code'}>
        <PreviewProjectToolbar
          template={store.project.template}
          hasSelectedFile={store.selectedFilePath !== null}
          onCreateProject={store.createProject}
          onCreateTestFile={() => store.writeFile(TEST_FILE_PATH, TEST_FILE_SOURCE)}
          onDeleteSelected={() => {
            if (store.selectedFilePath) store.deleteFile(store.selectedFilePath);
          }}
          onReset={store.resetProject}
        />
        <div className="preview-project-workspace">
          <PreviewFileTree
            files={store.project.files}
            selectedFilePath={store.selectedFilePath}
            onSelectFile={store.selectFile}
          />
          <div className="preview-project-main">
            <PreviewSourceViewer
              path={store.selectedFilePath}
              source={source}
              onChange={(content) => {
                if (store.selectedFilePath) store.writeFile(store.selectedFilePath, content);
              }}
            />
          </div>
        </div>
      </div>
      <div className="preview-project-preview" aria-hidden={view !== 'preview'}>
        <PreviewRuntimePanel
          iframeRef={runtime.iframeRef}
          state={runtime.state}
          buildState={compiler.state}
          buildDisabled={
            compiler.state.status === 'initializing' || compiler.state.status === 'building'
          }
          onBuildAndRun={buildAndRun}
          onRestartWorker={compiler.restartWorker}
          onReset={runtime.reset}
        />
      </div>
    </section>
  );
}
