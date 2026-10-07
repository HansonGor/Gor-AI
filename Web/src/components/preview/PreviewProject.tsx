import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { deleteFile as deleteVirtualFile, readFile, writeFile as writeVirtualFile } from '../../preview/core/virtualFs';
import { getPreviewEntryPoint } from '../../preview/core/entryPoint';
import { canBuildPreviewSource } from '../../preview/core/buildReadiness';
import { usePreviewProjectStore } from '../../stores/previewProjectStore';
import { usePreviewCompiler } from '../../preview/runtime/usePreviewCompiler';
import { usePreviewRuntime } from '../../preview/runtime/usePreviewRuntime';
import PreviewFileTree from './PreviewFileTree';
import PreviewProjectCreateDialog from './PreviewProjectCreateDialog';
import PreviewSourceViewer from './PreviewSourceViewer';
import PreviewRuntimePanel from './PreviewRuntimePanel';
import { saveBlob, saveBlobTask } from '../../preview/core/saveFile';
import { createPreviewDistArchive, previewDistArchiveName } from '../../preview/core/exportProject';
import { exportSceneGlb, isSceneRendererProject, validateSceneSpec, type SceneSpec } from '../../modeling/sceneSpec';
import type { GeneratedFile } from '../../types';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '../ui/alert-dialog';
import { Trash2 } from 'lucide-react';
import type { FileTreeNode, PreviewProject as PreviewProjectData } from '../../preview/core/types';
import type { PreviewProjectSnapshot } from '../../types';
import { glbFileName } from '../../preview/core/artifactFormat';

interface IsolatedProjectState {
  project: PreviewProjectData;
  selectedFilePath: string | null;
}

export default function PreviewProject({
  view,
  runtimeActionsHost,
  onDownloadDistReady,
  onSaveSceneGlb,
  canSaveSceneGlb = true,
  projectSnapshot,
  initialSelectedFilePath,
  sourcePending = false,
}: {
  view: 'preview' | 'code';
  runtimeActionsHost?: HTMLElement | null;
  onDownloadDistReady?: (handler: ((title: string) => Promise<void>) | null) => void;
  onSaveSceneGlb?: (blob: Blob, name: string) => Promise<GeneratedFile>;
  canSaveSceneGlb?: boolean;
  projectSnapshot?: PreviewProjectSnapshot;
  initialSelectedFilePath?: string;
  sourcePending?: boolean;
}) {
  const globalStore = usePreviewProjectStore();
  const [isolatedState, setIsolatedState] = useState<IsolatedProjectState | null>(null);
  const isolatedKey = projectSnapshot?.messageId;
  useEffect(() => {
    if (!projectSnapshot) {
      setIsolatedState(null);
      return;
    }
    const files = { ...projectSnapshot.files };
    const selectedFilePath = initialSelectedFilePath && files[initialSelectedFilePath] !== undefined
      ? initialSelectedFilePath
      : files['/src/scene.json'] !== undefined
        ? '/src/scene.json'
        : Object.keys(files)[0] ?? null;
    setIsolatedState({
      project: {
        id: projectSnapshot.id,
        name: projectSnapshot.name,
        template: projectSnapshot.template === 'html' ? 'html' : 'react',
        files,
        revision: projectSnapshot.revision,
      },
      selectedFilePath,
    });
  }, [isolatedKey, initialSelectedFilePath, projectSnapshot]);
  const isIsolated = projectSnapshot !== undefined;
  const project = isIsolated ? isolatedState?.project ?? {
    id: projectSnapshot.id,
    name: projectSnapshot.name,
    template: projectSnapshot.template === 'html' ? 'html' : 'react',
    files: projectSnapshot.files,
    revision: projectSnapshot.revision,
  } : globalStore.project;
  const selectedFilePath = isIsolated
    ? isolatedState?.selectedFilePath ?? (project.files['/src/scene.json'] !== undefined ? '/src/scene.json' : Object.keys(project.files)[0] ?? null)
    : globalStore.selectedFilePath;
  const runtimeProjectId = isIsolated ? `${project.id}:${isolatedKey}` : project.id;
  const sourceReady = canBuildPreviewSource(project.files, !isIsolated && sourcePending);
  const compiler = usePreviewCompiler(runtimeProjectId, project.files, project.revision ?? 0);
  const runtime = usePreviewRuntime(runtimeProjectId);
  const selectProjectFile = useCallback((path: string | null) => {
    if (!isIsolated) {
      globalStore.selectFile(path);
      return;
    }
    if (path !== null && readFile(project.files, path) === undefined) return;
    setIsolatedState((current) => current ? { ...current, selectedFilePath: path } : current);
  }, [isIsolated, globalStore.selectFile, project.files]);
  const writeProjectFile = useCallback((path: string, content: string) => {
    if (!isIsolated) {
      globalStore.writeFile(path, content);
      return;
    }
    try {
      const files = writeVirtualFile(project.files, path, content);
      setIsolatedState((current) => current ? {
        project: { ...current.project, files, revision: (current.project.revision ?? 0) + 1 },
        selectedFilePath: path,
      } : current);
    } catch {
      // The virtual file tree validates paths before invoking this callback.
    }
  }, [isIsolated, globalStore.writeFile, project.files]);
  const removeProjectFile = useCallback((path: string) => {
    if (!isIsolated) {
      globalStore.deleteFile(path);
      return;
    }
    const files = deleteVirtualFile(project.files, path);
    const selected = selectedFilePath && readFile(files, selectedFilePath) !== undefined
      ? selectedFilePath
      : Object.keys(files)[0] ?? null;
    setIsolatedState((current) => current ? {
      project: { ...current.project, files, revision: (current.project.revision ?? 0) + 1 },
      selectedFilePath: selected,
    } : current);
  }, [isIsolated, globalStore.deleteFile, project.files, selectedFilePath]);
  const lastAutoRunRef = useRef(0);
  const lastRunFilesRef = useRef<typeof project.files | null>(null);
  const lastViewRef = useRef<typeof view | null>(null);
  useEffect(() => {
    lastAutoRunRef.current = 0;
    lastRunFilesRef.current = null;
    lastViewRef.current = null;
    setDownloadError('');
  }, [runtimeProjectId]);
  const [downloadError, setDownloadError] = useState('');
  const [isSavingGlb, setIsSavingGlb] = useState(false);
  const [createDirectory, setCreateDirectory] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<FileTreeNode | null>(null);
  const buildRunRevision = isIsolated ? 0 : globalStore.buildRunRevision;
  const buildRunGlbRevision = isIsolated ? 0 : globalStore.buildRunGlbRevision;
  const shouldExportGlb = buildRunRevision > 0 && buildRunGlbRevision === buildRunRevision;
  const entryPoint = getPreviewEntryPoint(project);
  const source = useMemo(
    () =>
      selectedFilePath ? readFile(project.files, selectedFilePath) : undefined,
    [project.files, selectedFilePath],
  );
  const sceneSpec = useMemo<SceneSpec | null>(() => {
    const serialized = project.files['/src/scene.json'];
    if (!serialized) return null;
    try { return validateSceneSpec(JSON.parse(serialized)); } catch { return null; }
  }, [project.files]);

  const buildAndRun = useCallback((generateGlb = false) => {
    if (!sourceReady) return;
    lastRunFilesRef.current = project.files;
    void compiler.build(entryPoint).then((result) => {
      if (result) runtime.run(result);
    });
    void (async () => {
      if (!generateGlb || !sceneSpec || !isSceneRendererProject(project.files) || !onSaveSceneGlb || !canSaveSceneGlb || isSavingGlb) return;
      setIsSavingGlb(true);
      setDownloadError('');
      try {
        const blob = await exportSceneGlb(sceneSpec);
        await onSaveSceneGlb(blob, glbFileName(sceneSpec.name));
      } catch (error) {
        setDownloadError(error instanceof Error ? error.message : 'GLB 生成或保存失败，请重试。');
      } finally {
        setIsSavingGlb(false);
      }
    })();
  }, [sourceReady, project.files, compiler.build, entryPoint, runtime.run, sceneSpec, onSaveSceneGlb, canSaveSceneGlb, isSavingGlb]);

  const downloadSource = useCallback(async (path: string) => {
    const content = readFile(project.files, path);
    if (content === undefined) return;
    setDownloadError('');
    try {
      const name = path.split('/').pop() || 'source.txt';
      await saveBlob({
        suggestedName: name,
        blob: new Blob([content], { type: 'text/plain;charset=utf-8' }),
      });
    } catch {
      setDownloadError(`无法下载 ${path}，请重试。`);
    }
  }, [project.files]);

  const downloadDist = useCallback(async (title: string) => {
    await saveBlobTask(previewDistArchiveName(title), async () => {
      if (!sourceReady) throw new Error('项目源码尚未就绪，请等待生成完成。');
      const result = compiler.state.result ?? await compiler.build(entryPoint);
      if (!result) throw new Error('当前项目构建失败，无法导出 Preview dist。');
      const runtimeUrl = `${import.meta.env.BASE_URL}preview-runtime-dist/preview-runtime.js`;
      const response = await fetch(runtimeUrl);
      if (!response.ok) throw new Error('Preview Runtime 文件不可用，请重启项目后重试。');
      const runtimeSource = await response.text();
      const archive = createPreviewDistArchive(result, runtimeSource);
      return new Blob([new Uint8Array(archive)], { type: 'application/zip' });
    });
  }, [sourceReady, compiler.state.result, compiler.build, entryPoint]);

  useEffect(() => {
    onDownloadDistReady?.(downloadDist);
    return () => onDownloadDistReady?.(null);
  }, [downloadDist, onDownloadDistReady]);

  useEffect(() => {
    if (
      !sourceReady ||
      buildRunRevision === 0 ||
      buildRunRevision === lastAutoRunRef.current ||
      (shouldExportGlb && !canSaveSceneGlb) ||
      compiler.state.status === 'initializing' ||
      compiler.state.status === 'building'
    ) return;
    lastAutoRunRef.current = buildRunRevision;
    if (lastRunFilesRef.current === project.files && !shouldExportGlb) return;
    buildAndRun(shouldExportGlb);
  }, [sourceReady, buildRunRevision, buildRunGlbRevision, shouldExportGlb, canSaveSceneGlb, buildAndRun, compiler.state.status, project.files]);

  useEffect(() => {
    if (
      sourceReady &&
      view === 'preview' &&
      lastViewRef.current === 'code' &&
      buildRunRevision === 0 &&
      lastRunFilesRef.current !== project.files
    ) {
      buildAndRun();
    }
    lastViewRef.current = view;
  }, [sourceReady, view, project.files, buildAndRun]);

  useEffect(() => {
    if (
      sourceReady &&
      view === 'preview' &&
      buildRunRevision === 0 &&
      compiler.state.status === 'ready' &&
      runtime.state.status === 'idle' &&
      lastRunFilesRef.current !== project.files
    ) {
      buildAndRun();
    }
  }, [sourceReady, view, buildRunRevision, compiler.state.status, runtime.state.status, project.files, buildAndRun]);

  const createFile = useCallback((path: string): string | null => {
    if (Object.keys(project.files).length >= 40) return '项目文件数量已达上限（40 个）。';
    const size = Object.values(project.files).reduce((total, content) => total + new TextEncoder().encode(content).byteLength, 0);
    if (size > 500_000) return '项目大小已达上限，无法继续添加文件。';
    writeProjectFile(path, '');
    return null;
  }, [project.files, writeProjectFile]);
  const createFolder = useCallback((markerPath: string): string | null => {
    if (Object.keys(project.files).length >= 40) return '项目文件数量已达上限（40 个）。';
    const size = Object.values(project.files).reduce((total, content) => total + new TextEncoder().encode(content).byteLength, 0);
    if (size > 500_000) return '项目大小已达上限，无法继续添加文件夹。';
    writeProjectFile(markerPath, '');
    selectProjectFile(null);
    return null;
  }, [project.files, writeProjectFile, selectProjectFile]);

  const deletePendingNode = useCallback(() => {
    if (!pendingDelete) return;
    const paths = pendingDelete.type === 'directory'
      ? Object.keys(project.files).filter((path) => path.startsWith(`${pendingDelete.path}/`))
      : [pendingDelete.path];
    paths.sort((left, right) => right.length - left.length).forEach((path) => removeProjectFile(path));
    setPendingDelete(null);
  }, [pendingDelete, project.files, removeProjectFile]);

  return (
    <section className={`preview-project view-${view}`} aria-label="Preview Project">
      <div className="preview-project-code" aria-hidden={view !== 'code'}>
        <PreviewProjectCreateDialog
          open={createDirectory !== null}
          baseDirectory={createDirectory ?? '/'}
          existingPaths={Object.keys(project.files)}
          onOpenChange={(open) => { if (!open) setCreateDirectory(null); }}
          onCreateFile={createFile}
          onCreateFolder={createFolder}
        />
        {downloadError && (
          <div className="preview-runtime-error" role="alert">
            {downloadError}
          </div>
        )}
        <div className="preview-project-workspace">
          <PreviewFileTree
            files={project.files}
            selectedFilePath={selectedFilePath}
            onSelectFile={selectProjectFile}
            onDownloadFile={(path) => void downloadSource(path)}
            onCreateInDirectory={setCreateDirectory}
            onRequestDelete={setPendingDelete}
          />
          <div className="preview-project-main">
            <PreviewSourceViewer
              path={selectedFilePath}
              source={source}
              onChange={(content) => {
                if (selectedFilePath) writeProjectFile(selectedFilePath, content);
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
          sourcePending={!sourceReady}
          buildDisabled={
            !sourceReady || compiler.state.status === 'initializing' || compiler.state.status === 'building' || (sceneSpec !== null && !canSaveSceneGlb)
          }
          onBuildAndRun={() => buildAndRun(true)}
          isSavingGlb={isSavingGlb}
          actionsHost={runtimeActionsHost}
        />
      </div>
      <AlertDialog open={pendingDelete !== null} onOpenChange={(open) => { if (!open) setPendingDelete(null); }}>
        <AlertDialogContent overlayClassName="chat-theme-dialog-overlay" className="chat-theme-dialog w-[min(440px,calc(100%-32px))] max-w-none gap-0 rounded-2xl border border-white/10 p-5 text-[#f4f3f8] shadow-[0_28px_90px_rgba(0,0,0,0.5)] sm:p-6">
          <AlertDialogHeader className="gap-[10px]">
            <AlertDialogTitle className="flex items-center gap-3 text-base tracking-tight">
              <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-red-500/10 text-red-300"><Trash2 size={18} aria-hidden="true" /></span>
              确认删除{pendingDelete?.type === 'directory' ? '文件夹' : '文件'}？
            </AlertDialogTitle>
            <AlertDialogDescription className="pl-[52px] text-[13px] leading-[1.5] text-white/55">
              {pendingDelete?.type === 'directory'
                ? <>将删除 <code>{pendingDelete.path}</code> 及其包含的所有文件，此操作无法撤销。</>
                : <>将删除文件 <code>{pendingDelete?.path}</code>，此操作无法撤销。</>}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="mt-5 flex-row gap-2 border-t border-white/[0.08] pt-4">
            <AlertDialogCancel className="h-10 min-w-[88px] rounded-xl border-white/10 bg-white/[0.04] text-white/75 hover:bg-white/[0.09] hover:text-white">取消</AlertDialogCancel>
            <AlertDialogAction className="h-10 min-w-[88px] rounded-xl bg-red-600 text-white shadow-sm shadow-red-950/20 hover:bg-red-500" onClick={deletePendingNode}>删除</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
