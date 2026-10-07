import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Box,
  Download,
  FileCode2,
  FileSpreadsheet,
  FileText,
  Globe2,
  Maximize2,
  Minimize2,
  PanelLeftClose,
  PanelLeftOpen,
  Presentation,
  Trash2,
  X,
} from 'lucide-react';
import FilePreview from './FilePreview';
import PreviewProject from '../preview/PreviewProject';
import { exportSceneGlb, isSceneRendererProject, validateSceneSpec } from '../../modeling/sceneSpec';
import type { GeneratedFile, PreviewProjectSnapshot, UploadedAttachment } from '../../types';
import { Button } from '../ui/button';
import { Tabs, TabsList, TabsTrigger } from '../ui/tabs';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../ui/alert-dialog';
import { usePreviewProjectStore } from '../../stores/previewProjectStore';
import { fileExtension, generatedFileExtension, hasGeneratedSceneArtifact, haveSamePreviewArtifactFiles, previewArtifactName, previewArtifactTooltip, previewSnapshotExtension } from '../../preview/core/artifactFormat';
import { createPreviewArchive, previewArchiveName } from '../../preview/core/exportProject';
import { saveBlob, saveUrl } from '../../preview/core/saveFile';
import ImportedDistPreview from '../preview/ImportedDistPreview';
import PresentationPreview from '../preview/PresentationPreview';
import type { ImportedDistArchive } from '../../preview/core/importArchive';
import { sortPreviewArtifactEntries, sourceSnapshotForTarget } from '../../preview/core/artifactSelection';
import { glbFileName } from '../../preview/core/artifactFormat';

export type PreviewWorkerMode = 'preview' | 'code';
export type PreviewWorkerTarget = 'project' | 'project-snapshot' | 'generated' | 'uploaded-dist' | 'uploaded-missing';

interface PreviewWorkerProps {
  files: GeneratedFile[];
  messagePreviewArtifacts: Array<{ messageId: string; snapshot: PreviewProjectSnapshot | null; files: GeneratedFile[] }>;
  artifactCreationOrder: Record<string, number>;
  activeFile: GeneratedFile | null;
  projectSourcePaths: string[];
  uploadedAttachments: UploadedAttachment[];
  activeUploadedAttachmentKey: string | null;
  onSelectUploadedAttachment: (key: string | null) => void;
  onOpenUploadedAttachment: (attachment: UploadedAttachment) => void;
  hiddenArtifactKeys: string[];
  onDeleteArtifact: (keys: string[]) => void;
  hasProjectSource: boolean;
  mode: PreviewWorkerMode;
  target: PreviewWorkerTarget;
  projectSnapshots: PreviewProjectSnapshot[];
  activeProjectSnapshot: PreviewProjectSnapshot | null;
  activeProjectSourcePath?: string;
  onSelectProjectSnapshot: (snapshot: PreviewProjectSnapshot, intent?: 'preview' | 'source', sourcePath?: string) => void;
  onModeChange: (mode: PreviewWorkerMode) => void;
  onTargetChange: (target: PreviewWorkerTarget) => void;
  importedDist?: ImportedDistArchive | null;
  onSaveSceneGlb?: (blob: Blob, name: string) => Promise<GeneratedFile>;
  isChatLoading?: boolean;
  onClose: () => void;
}

function FileTypeIcon({ type }: { type: string }) {
  if (type === 'word' || type === 'pdf') return <FileText aria-hidden="true" />;
  if (type === 'excel') return <FileSpreadsheet aria-hidden="true" />;
  if (type === 'ppt') return <Presentation aria-hidden="true" />;
  if (type === '3d') return <Box aria-hidden="true" />;
  return <Globe2 aria-hidden="true" />;
}

function normalizeAttachmentName(name: string): string {
  return name.trim().replace(/\.zip$/i, '').toLocaleLowerCase();
}

function toSnapshotArtifactName(snapshot: PreviewProjectSnapshot): string {
  return previewArtifactName(snapshot, previewSnapshotExtension(snapshot));
}

export default function PreviewWorker({
  files,
  messagePreviewArtifacts,
  artifactCreationOrder,
  activeFile,
  projectSourcePaths,
  uploadedAttachments,
  activeUploadedAttachmentKey,
  onSelectUploadedAttachment,
  onOpenUploadedAttachment,
  hiddenArtifactKeys,
  onDeleteArtifact,
  hasProjectSource,
  mode,
  target,
  projectSnapshots,
  activeProjectSnapshot,
  activeProjectSourcePath,
  onSelectProjectSnapshot,
  onModeChange,
  onTargetChange,
  importedDist,
  onSaveSceneGlb,
  isChatLoading = false,
  onClose,
}: PreviewWorkerProps) {
  const projectStore = usePreviewProjectStore();
  const project = projectStore.project;
  const isSceneProject = isSceneRendererProject(project.files);
  const projectExtension = isSceneProject ? '.glb' : '.html';
  const projectFileName = previewArtifactName(project, projectExtension);
  const hasSnapshotForCurrentProject = projectSnapshots.some((snapshot) => {
    const snapshotExtension = previewSnapshotExtension(snapshot);
    if (snapshot.id === project.id && snapshotExtension === projectExtension) return true;
    // Compatibility for sessions saved before workspace IDs were preserved on restore.
    return snapshot.id !== project.id && haveSamePreviewArtifactFiles(
      project.files,
      projectExtension,
      snapshot.files,
      snapshotExtension,
    );
  });
  const [previewSidebarCollapsed, setPreviewSidebarCollapsed] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);
  const [isExpanding, setIsExpanding] = useState(false);
  const [isCollapsing, setIsCollapsing] = useState(false);
  const [downloadError, setDownloadError] = useState('');
  const [pendingDeleteArtifactKey, setPendingDeleteArtifactKey] = useState<string | null>(null);
  const [selectedGeneratedFile, setSelectedGeneratedFile] = useState<GeneratedFile | null>(activeFile);
  const [runtimeActionsHost, setRuntimeActionsHost] = useState<HTMLDivElement | null>(null);
  const downloadDistRef = useRef<((title: string) => Promise<void>) | null>(null);
  const registerDistDownload = useCallback((handler: ((title: string) => Promise<void>) | null) => {
    downloadDistRef.current = handler;
  }, []);
  const showGenerated =
    mode === 'preview' && target === 'generated' && selectedGeneratedFile !== null;
  const showImportedDist = mode === 'preview' && target === 'uploaded-dist' && importedDist != null;
  const projectArtifactKey = `project:${project.id}`;
  const snapshotArtifactKey = activeProjectSnapshot ? `project-snapshot:${activeProjectSnapshot.messageId}` : null;
  const hasVisibleProjectArtifact = hasProjectSource && !hiddenArtifactKeys.includes(projectArtifactKey);
  const hasExportedCurrentScene = isSceneProject && hasGeneratedSceneArtifact(
    project.id, files.filter((file) => !hiddenArtifactKeys.includes(`generated:${file.downloadUrl}`)),
  );
  const selectedUploadedDist = uploadedAttachments.find((attachment) =>
    attachment.kind === 'archive' && importedDist
      && normalizeAttachmentName(attachment.name) === normalizeAttachmentName(importedDist.name),
  );
  const selectedUploadedAttachment = uploadedAttachments.find((attachment) =>
    `uploaded:${attachment.kind}:${attachment.name}` === activeUploadedAttachmentKey,
  );
  const currentArtifactKey = target === 'generated' && selectedGeneratedFile
    ? `generated:${selectedGeneratedFile.downloadUrl}`
    : selectedUploadedAttachment && (target === 'uploaded-dist' || target === 'project' || target === 'uploaded-missing')
      ? `uploaded:${selectedUploadedAttachment.kind}:${selectedUploadedAttachment.name}`
      : target === 'uploaded-dist' && selectedUploadedDist
      ? `uploaded:${selectedUploadedDist.kind}:${selectedUploadedDist.name}`
      : target === 'project' && hasVisibleProjectArtifact
        ? projectArtifactKey
        : target === 'project-snapshot'
          ? snapshotArtifactKey
        : null;
  const currentArtifactCanDelete = Boolean(currentArtifactKey && !hiddenArtifactKeys.includes(currentArtifactKey));
  const selectedGeneratedSourcePath = selectedGeneratedFile
    ? (() => {
        if (selectedGeneratedFile.projectId !== project.id) return null;
        if (selectedGeneratedFile.fileType === '3d' && selectedGeneratedFile.projectId === project.id && project.files['/src/scene.json'] !== undefined) {
          try {
            validateSceneSpec(JSON.parse(project.files['/src/scene.json']));
            return '/src/scene.json';
          } catch {
            return null;
          }
        }
        try {
          const path = decodeURIComponent(new URL(selectedGeneratedFile.downloadUrl, window.location.origin).pathname);
          if (project.files[path] !== undefined) return path;
          const rootedPath = `/${path.replace(/^\/+/, '')}`;
          return project.files[rootedPath] !== undefined ? rootedPath : null;
        } catch {
          return null;
        }
      })()
    : null;
  const generatedSourceSnapshot = selectedGeneratedFile?.projectId === project.id ? undefined
    : projectSnapshots.find((snapshot) => snapshot.id === selectedGeneratedFile?.projectId);
  const selectedSourceSnapshot = sourceSnapshotForTarget(target, activeProjectSnapshot, generatedSourceSnapshot);
  const canShowCode = target === 'generated'
    ? selectedGeneratedFile?.previewRenderer === 'presentation' || selectedGeneratedSourcePath !== null || Boolean(generatedSourceSnapshot)
    : target === 'project' && hasProjectSource
      ? true
      : target === 'project-snapshot' && Boolean(activeProjectSnapshot && (activeProjectSnapshot.template === 'presentation' || Object.keys(activeProjectSnapshot.files).length > 0));
  const snapshotIsScene = Boolean(activeProjectSnapshot && isSceneRendererProject(activeProjectSnapshot.files));
  const currentProjectIsScene = isSceneProject;
  const downloadLabel = target === 'generated' && selectedGeneratedFile
    ? mode === 'preview' ? `下载 ${selectedGeneratedFile.displayName}` : selectedGeneratedFile.previewRenderer === 'presentation' ? `下载 ${selectedGeneratedFile.displayName.replace(/\.pptx$/i, '')} 源码（JSON）` : `下载 ${generatedSourceSnapshot?.name ?? projectFileName} 源码（ZIP）`
    : showImportedDist
      ? `下载 ${importedDist.name}.zip`
    : target === 'project-snapshot' && activeProjectSnapshot
        ? mode === 'code'
          ? `下载 ${activeProjectSnapshot.name} 源码（${activeProjectSnapshot.template === 'presentation' ? 'JSON' : 'ZIP'}）`
          : snapshotIsScene
            ? `下载 ${glbFileName(activeProjectSnapshot.name)}`
            : activeProjectSnapshot.template === 'presentation'
              ? `下载 ${activeProjectSnapshot.name}.pptx`
              : `下载 ${activeProjectSnapshot.name} 预览项目（ZIP）`
        : mode === 'code'
          ? `下载 ${projectFileName} 源码（ZIP）`
          : currentProjectIsScene
            ? `下载 ${glbFileName(project.name)}`
            : `下载 ${projectFileName} 预览项目（ZIP）`;
  const downloadPreview = async () => {
    if (target === 'uploaded-missing') return;
    setDownloadError('');
    try {
      if (target === 'generated' && selectedGeneratedFile && mode === 'preview') {
        await saveUrl(selectedGeneratedFile.downloadUrl, selectedGeneratedFile.displayName);
      } else if (showImportedDist && importedDist) {
        await saveBlob({
          suggestedName: `${importedDist.name}.zip`,
          blob: new Blob([new Uint8Array(importedDist.archiveBytes)], { type: 'application/zip' }),
        });
      } else if (target === 'project-snapshot' && activeProjectSnapshot) {
        if (mode === 'code') {
          if (activeProjectSnapshot.template === 'presentation') {
            const json = activeProjectSnapshot.files['/presentation.json'] ?? JSON.stringify(activeProjectSnapshot.presentationSchema, null, 2);
            await saveBlob({ suggestedName: `${activeProjectSnapshot.name}.json`, blob: new Blob([json], { type: 'application/json;charset=utf-8' }) });
            return;
          }
          const bytes = createPreviewArchive(activeProjectSnapshot.files);
          await saveBlob({
            suggestedName: previewArchiveName(activeProjectSnapshot.name),
            blob: new Blob([new Uint8Array(bytes)], { type: 'application/zip' }),
          });
        } else if (snapshotIsScene) {
          const scene = validateSceneSpec(JSON.parse(activeProjectSnapshot.files['/src/scene.json'] ?? ''));
          const blob = await exportSceneGlb(scene);
          await saveBlob({ suggestedName: glbFileName(scene.name), blob });
        } else if (activeProjectSnapshot.template === 'presentation' && activeProjectSnapshot.finalArtifact) {
          await saveUrl(activeProjectSnapshot.finalArtifact.downloadUrl, activeProjectSnapshot.finalArtifact.displayName);
        } else {
          const downloadDist = downloadDistRef.current;
          if (!downloadDist) throw new Error('Preview Runtime 尚未准备好，请稍后重试。');
          await downloadDist(toSnapshotArtifactName(activeProjectSnapshot));
        }
      } else if (target === 'generated' && mode === 'code') {
        if (selectedGeneratedFile?.previewRenderer === 'presentation') {
          const source = selectedGeneratedFile.sourceFiles?.['/presentation.json'] ?? JSON.stringify(selectedGeneratedFile.presentationSchema, null, 2);
          await saveBlob({ suggestedName: `${selectedGeneratedFile.displayName.replace(/\.pptx$/i, '')}.json`, blob: new Blob([source], { type: 'application/json;charset=utf-8' }) });
          return;
        }
        if (!generatedSourceSnapshot && selectedGeneratedFile?.projectId !== project.id) throw new Error('该产物没有对应的源码，不能使用其他项目的源码。');
        const bytes = createPreviewArchive(generatedSourceSnapshot?.files ?? project.files);
        await saveBlob({
          suggestedName: previewArchiveName(generatedSourceSnapshot?.name ?? projectFileName),
          blob: new Blob([new Uint8Array(bytes)], { type: 'application/zip' }),
        });
      } else if (mode === 'preview') {
        if (currentProjectIsScene) {
          const scene = validateSceneSpec(JSON.parse(project.files['/src/scene.json'] ?? ''));
          const blob = await exportSceneGlb(scene);
          await saveBlob({ suggestedName: glbFileName(scene.name), blob });
        } else {
          const downloadDist = downloadDistRef.current;
          if (!downloadDist) throw new Error('Preview Runtime 尚未准备好，请稍后重试。');
          await downloadDist(projectFileName);
        }
      } else {
        const bytes = createPreviewArchive(project.files);
        await saveBlob({
          suggestedName: previewArchiveName(projectFileName),
          blob: new Blob([new Uint8Array(bytes)], { type: 'application/zip' }),
        });
      }
    } catch {
      setDownloadError('下载失败，请稍后重试。');
    }
  };
  const deleteCurrentArtifact = () => {
    if (!currentArtifactKey) return;
    const keysToHide = new Set([currentArtifactKey]);
    const addSnapshotAndOutputs = (messageId: string) => {
      const messageArtifact = messagePreviewArtifacts.find((item) => item.messageId === messageId);
      if (!messageArtifact) return;
      if (messageArtifact.snapshot) keysToHide.add(`project-snapshot:${messageArtifact.snapshot.messageId}`);
      messageArtifact.files.forEach((file) => keysToHide.add(`generated:${file.downloadUrl}`));
    };

    if (target === 'generated' && selectedGeneratedFile) {
      const messageArtifact = messagePreviewArtifacts.find((item) =>
        item.files.some((file) => file.downloadUrl === selectedGeneratedFile.downloadUrl),
      );
      if (messageArtifact?.snapshot) {
        keysToHide.add(`project-snapshot:${messageArtifact.snapshot.messageId}`);
        if (messageArtifact.snapshot.id === project.id) keysToHide.add(projectArtifactKey);
      }
      else if (selectedGeneratedSourcePath && hasProjectSource) keysToHide.add(projectArtifactKey);
    } else if (target === 'project-snapshot' && activeProjectSnapshot) {
      addSnapshotAndOutputs(activeProjectSnapshot.messageId);
    } else if (target === 'project') {
      if (selectedUploadedAttachment) keysToHide.add(projectArtifactKey);
      const linkedSnapshots = messagePreviewArtifacts.filter((item) => item.snapshot?.id === project.id);
      linkedSnapshots.forEach((item) => addSnapshotAndOutputs(item.messageId));
      if (linkedSnapshots.length === 0) {
        files.filter((file) => file.displayName.toLocaleLowerCase() === projectFileName.toLocaleLowerCase())
          .forEach((file) => keysToHide.add(`generated:${file.downloadUrl}`));
      }
    }

    onDeleteArtifact([...keysToHide]);
    onSelectUploadedAttachment(null);
    const isHidden = (key: string) => hiddenArtifactKeys.includes(key) || keysToHide.has(key);
    const nextSnapshot = projectSnapshots.find((snapshot) => !isHidden(`project-snapshot:${snapshot.messageId}`));
    const nextFile = files.find((file) => !isHidden(`generated:${file.downloadUrl}`));
    const nextAttachment = uploadedAttachments.find((attachment) =>
      !isHidden(`uploaded:${attachment.kind}:${attachment.name}`),
    );
    const nextProjectVisible = hasProjectSource && !isHidden(projectArtifactKey);
    const nextDistVisible = Boolean(importedDist && selectedUploadedDist
      && !isHidden(`uploaded:${selectedUploadedDist.kind}:${selectedUploadedDist.name}`));

    if (nextFile) {
      setSelectedGeneratedFile(nextFile);
      onTargetChange('generated');
      onModeChange('preview');
    } else if (nextSnapshot) {
      onSelectProjectSnapshot(nextSnapshot);
      onModeChange('preview');
    } else if (nextAttachment) {
      onOpenUploadedAttachment(nextAttachment);
      onModeChange('preview');
    } else if (nextProjectVisible) {
      onTargetChange('project');
      onModeChange('preview');
    } else if (nextDistVisible) {
      onTargetChange('uploaded-dist');
      onModeChange('preview');
    } else {
      onClose();
    }
  };
  const selectProjectSource = (preferredName?: string, preferApp = false) => {
    if (!hasProjectSource) {
      return;
    }
    const matchingPath = preferredName
      ? Object.keys(project.files).find((path) => path.split('/').pop()?.toLowerCase() === preferredName.toLowerCase())
      : undefined;
    const preferredProjectPath = preferApp
      ? isSceneProject
        ? '/src/scene.json'
        : ['/src/App.tsx', '/src/App.jsx', '/src/App.ts', '/src/App.js', '/src/main.tsx', '/src/main.jsx', '/src/main.ts', '/src/main.js', '/index.html']
          .find((path) => project.files[path] !== undefined)
      : undefined;
    const sourcePath = matchingPath ?? preferredProjectPath ?? projectSourcePaths.find((path) => project.files[path] !== undefined);
    if (!sourcePath || project.files[sourcePath] === undefined) {
      return;
    }
    projectStore.selectFile(sourcePath);
  };

  useEffect(() => {
    if (activeFile) setSelectedGeneratedFile(files.find((file) => file.downloadUrl === activeFile.downloadUrl) ?? activeFile);
  }, [activeFile, files]);

  const openUploadedAttachment = (attachment: UploadedAttachment) => {
    onOpenUploadedAttachment(attachment);
  };

  const openGeneratedFile = (file: GeneratedFile) => {
    onSelectUploadedAttachment(null);
    setSelectedGeneratedFile(file);
    let sourcePath: string | null = null;
    try {
      const path = decodeURIComponent(new URL(file.downloadUrl, window.location.origin).pathname);
      const rootedPath = `/${path.replace(/^\/+/, '')}`;
      sourcePath = project.files[path] !== undefined ? path : project.files[rootedPath] !== undefined ? rootedPath : null;
    } catch {
      sourcePath = null;
    }
    const sceneSource = project.files['/src/scene.json'];
    if (file.fileType === '3d' && file.projectId === project.id && sceneSource !== undefined) {
      try {
        validateSceneSpec(JSON.parse(sceneSource));
        projectStore.selectFile('/src/scene.json');
      } catch {
        // A stale or invalid SceneSpec is not a source for this GLB.
      }
      onTargetChange('generated');
      onModeChange('preview');
      return;
    }
    if (sourcePath) {
      projectStore.selectFile(sourcePath);
    }
    onTargetChange('generated');
    onModeChange('preview');
  };
  return (
    <section
      className={`preview-worker ${isExpanded ? 'is-expanded' : ''} ${isCollapsing ? 'is-collapsing' : ''}`}
      aria-label="Preview Worker 文件预览"
      onAnimationEnd={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.animationName === 'preview-worker-tile-open') setIsExpanding(false);
        if (event.animationName === 'preview-worker-tile-close') {
          setIsExpanded(false);
          setIsCollapsing(false);
        }
      }}
    >
      <div className="preview-worker-tabsbar">
        <Tabs
          value={mode}
          onValueChange={(value) => onModeChange(value as PreviewWorkerMode)}
          className="contents"
        >
          <TabsList className="preview-worker-modes h-auto rounded-none" aria-label="预览模式">
            <TabsTrigger value="preview">Preview</TabsTrigger>
            {canShowCode && <TabsTrigger value="code">Code</TabsTrigger>}
          </TabsList>
        </Tabs>
        <div className="preview-worker-runtime-actions" ref={setRuntimeActionsHost} />
        <div className="preview-worker-actions">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="preview-worker-download"
            onClick={downloadPreview}
            disabled={target === 'uploaded-missing' || (
              target === 'generated'
                ? !selectedGeneratedFile || (mode === 'code' && selectedGeneratedFile.previewRenderer !== 'presentation' && Object.keys(project.files).length === 0)
                : target === 'uploaded-dist'
                  ? !importedDist
                  : target === 'project-snapshot'
                    ? !activeProjectSnapshot || (Object.keys(activeProjectSnapshot.files).length === 0 && !activeProjectSnapshot.finalArtifact)
                    : Object.keys(project.files).length === 0
            )}
            aria-label={downloadLabel}
            title={downloadLabel}
          >
            <Download size={18} />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="preview-worker-expand"
            onClick={() => {
              if (isExpanded) setIsCollapsing(true);
              else {
                setIsExpanding(true);
                setIsExpanded(true);
              }
            }}
            disabled={isExpanding || isCollapsing}
            aria-label={isExpanded ? '退出完整视图' : '进入完整视图'}
            aria-pressed={isExpanded}
            title={isExpanded ? '退出完整视图' : '覆盖聊天区查看'}
          >
            {isExpanded ? <Minimize2 size={17} /> : <Maximize2 size={17} />}
          </Button>
          {currentArtifactCanDelete && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="preview-worker-delete"
              onClick={() => setPendingDeleteArtifactKey(currentArtifactKey)}
              aria-label="从 Preview 列表隐藏当前产物"
              title="仅从列表隐藏，可从聊天记录恢复"
            >
              <Trash2 size={17} />
            </Button>
          )}
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="preview-worker-close"
            onClick={onClose}
            aria-label="关闭 Preview Worker"
            title="关闭预览"
          >
            <X size={18} />
          </Button>
        </div>
      </div>
      {downloadError && (
        <div role="alert" className="preview-runtime-error">
          {downloadError}
        </div>
      )}
      {mode === 'preview' && (
        <div className="preview-worker-preview-body">
          <nav
            className={`preview-worker-files ${previewSidebarCollapsed ? 'is-collapsed' : ''}`}
            aria-label="预览文件列表"
          >
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="preview-sidebar-toggle"
              onClick={() => setPreviewSidebarCollapsed((value) => !value)}
              aria-label={previewSidebarCollapsed ? '展开预览文件' : '收起预览文件'}
              title={previewSidebarCollapsed ? '展开文件' : '收起文件'}
            >
              {previewSidebarCollapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
            </Button>
            {!previewSidebarCollapsed && (
              <>
                <div className="preview-file-tree-label">Preview files</div>
                {sortPreviewArtifactEntries([
                  ...(hasVisibleProjectArtifact && !hasSnapshotForCurrentProject && !hasExportedCurrentScene ? [{ key: projectArtifactKey, node: <Button
                      key={projectArtifactKey}
                      type="button"
                      variant="ghost"
                      className={target === 'project' && !activeUploadedAttachmentKey ? 'active' : ''}
                      onClick={() => {
                        onSelectUploadedAttachment(null);
                        selectProjectSource(undefined, true);
                        onTargetChange('project');
                        onModeChange('preview');
                      }}
                      title={projectFileName}
                    >
                      {isSceneProject ? <Box aria-hidden="true" /> : <FileCode2 aria-hidden="true" />}
                      <span className="preview-worker-file-name">{projectFileName}</span>
                    </Button> }] : []),
                    ...projectSnapshots.filter((snapshot) => !hiddenArtifactKeys.includes(`project-snapshot:${snapshot.messageId}`)
                      && !(previewSnapshotExtension(snapshot) === '.glb' && hasGeneratedSceneArtifact(snapshot.id,
                        files.filter((file) => !hiddenArtifactKeys.includes(`generated:${file.downloadUrl}`))))).map((snapshot) => {
                      const artifactName = toSnapshotArtifactName(snapshot);
                      return { key: `project-snapshot:${snapshot.messageId}`, node: (
                      <Button
                        type="button"
                        variant="ghost"
                        key={`project-snapshot:${snapshot.messageId}`}
                        className={target === 'project-snapshot' && activeProjectSnapshot?.messageId === snapshot.messageId ? 'active' : ''}
                        onClick={() => onSelectProjectSnapshot(snapshot)}
                        title={previewArtifactTooltip(artifactName, null)}
                      >
                        {snapshot.template === 'react' ? <FileCode2 aria-hidden="true" /> : snapshot.template === 'presentation' ? <Presentation aria-hidden="true" /> : <Box aria-hidden="true" />}
                        <span className="preview-worker-file-name">{artifactName}</span>
                      </Button>
                    ) };}),
                    ...uploadedAttachments.filter((attachment) => !hiddenArtifactKeys.includes(`uploaded:${attachment.kind}:${attachment.name}`)).map((attachment, index) => {
                      const AttachmentIcon = attachment.kind === 'folder' ? FileCode2 : FileText;
                      return { key: `uploaded:${attachment.kind}:${attachment.name}`, node: (
                        <Button
                          type="button"
                          variant="ghost"
                          key={`uploaded:${attachment.kind}:${attachment.name}:${index}`}
                          className={(target === 'uploaded-dist' || target === 'project' || target === 'uploaded-missing')
                            && activeUploadedAttachmentKey === `uploaded:${attachment.kind}:${attachment.name}` ? 'active' : ''}
                          onClick={() => openUploadedAttachment(attachment)}
                          title={previewArtifactTooltip(`查看上传内容 ${attachment.name}`, attachment.kind === 'folder' ? null : fileExtension(attachment.name))}
                        >
                          <AttachmentIcon aria-hidden="true" />
                          <span className="preview-worker-file-name">{attachment.name}</span>
                        </Button>
                      ) };
                    }),
                    ...files.filter((file) => !hiddenArtifactKeys.includes(`generated:${file.downloadUrl}`)).map((file) => ({ key: `generated:${file.downloadUrl}`, node: (
                      <Button
                        type="button"
                        variant="ghost"
                        key={file.downloadUrl}
                        className={target === 'generated' && selectedGeneratedFile?.downloadUrl === file.downloadUrl ? 'active' : ''}
                        onClick={() => openGeneratedFile(file)}
                        title={previewArtifactTooltip(file.displayName, generatedFileExtension(file))}
                      >
                        <FileTypeIcon type={file.fileType} />
                        <span className="preview-worker-file-name">{file.displayName}</span>
                      </Button>
                    ) })),
                ], artifactCreationOrder).map((entry) => entry.node)}
              </>
            )}
          </nav>
          {target === 'uploaded-missing' ? (
            <div className="preview-worker-project preview-worker-empty-source" role="status">
              这份附件的预览数据当前不可用；可以从列表隐藏它，或重新上传并发送。
            </div>
          ) : target === 'project-snapshot' && activeProjectSnapshot ? (
            <div className="preview-worker-project">
              {activeProjectSnapshot.template === 'presentation' && activeProjectSnapshot.presentationSchema
                ? <PresentationPreview schema={activeProjectSnapshot.presentationSchema} backgrounds={activeProjectSnapshot.presentationBackgrounds} renderedSlides={activeProjectSnapshot.renderedSlides} />
                : <PreviewProject
                key={`snapshot:${activeProjectSnapshot.messageId}`}
                view="preview"
                projectSnapshot={activeProjectSnapshot}
                initialSelectedFilePath={activeProjectSourcePath}
                runtimeActionsHost={runtimeActionsHost}
                onDownloadDistReady={registerDistDownload}
                onSaveSceneGlb={onSaveSceneGlb}
                canSaveSceneGlb={!isChatLoading}
              />}
            </div>
          ) : showGenerated && selectedGeneratedFile ? (
            <div className={`preview-worker-content ${selectedGeneratedFile.fileType === '3d' ? 'is-3d-model' : ''}`}>
              {selectedGeneratedFile.fileType !== '3d' && (
                <div className="preview-worker-file-title">
                  <span>{selectedGeneratedFile.displayName}</span>
                  <button
                    type="button"
                    onClick={() => void downloadPreview()}
                    title="选择保存位置"
                    aria-label={`下载 ${selectedGeneratedFile.displayName}`}
                  >
                    <Download size={16} />
                  </button>
                </div>
              )}
              {selectedGeneratedFile.previewRenderer === 'presentation' && selectedGeneratedFile.presentationSchema
                ? <PresentationPreview schema={selectedGeneratedFile.presentationSchema} backgrounds={selectedGeneratedFile.presentationBackgrounds} renderedSlides={selectedGeneratedFile.renderedSlides} />
                : <FilePreview file={selectedGeneratedFile} />}
            </div>
          ) : showImportedDist && importedDist ? (
            <ImportedDistPreview archive={importedDist} />
          ) : (
            <div className="preview-worker-project">
              <PreviewProject
                key={`current:${project.id}`}
                view="preview"
                sourcePending={isChatLoading}
                runtimeActionsHost={runtimeActionsHost}
                onDownloadDistReady={registerDistDownload}
                onSaveSceneGlb={onSaveSceneGlb}
                canSaveSceneGlb={!isChatLoading}
              />
            </div>
          )}
        </div>
      )}
      {mode === 'code' && canShowCode && target === 'project-snapshot' && activeProjectSnapshot?.template === 'presentation' ? (
        <div className="presentation-source"><div className="presentation-source-title">/presentation.json</div><pre>{activeProjectSnapshot.files['/presentation.json'] ?? JSON.stringify(activeProjectSnapshot.presentationSchema, null, 2)}</pre></div>
      ) : mode === 'code' && canShowCode && target === 'generated' && selectedGeneratedFile?.previewRenderer === 'presentation' ? (
        <div className="presentation-source"><div className="presentation-source-title">/presentation.json</div><pre>{selectedGeneratedFile.sourceFiles?.['/presentation.json'] ?? JSON.stringify(selectedGeneratedFile.presentationSchema, null, 2)}</pre></div>
      ) : mode === 'code' && canShowCode && <PreviewProject key={`source:${target}:${selectedSourceSnapshot?.messageId ?? project.id}`} view="code" projectSnapshot={selectedSourceSnapshot} sourcePending={isChatLoading} initialSelectedFilePath={target === 'project-snapshot' ? activeProjectSourcePath : target === 'generated' ? selectedGeneratedSourcePath ?? undefined : undefined} runtimeActionsHost={runtimeActionsHost} onSaveSceneGlb={onSaveSceneGlb} canSaveSceneGlb={!isChatLoading} />}
      {showGenerated && selectedGeneratedFile?.fileType === '3d' && (generatedSourceSnapshot || selectedGeneratedFile.projectId === project.id) && (
        <div className="preview-worker-build-runtime" aria-hidden="true">
          <PreviewProject
            key={`generated-source:${generatedSourceSnapshot?.id ?? project.id}`}
            view="preview"
            projectSnapshot={generatedSourceSnapshot}
            sourcePending={isChatLoading}
            runtimeActionsHost={runtimeActionsHost}
            onSaveSceneGlb={onSaveSceneGlb}
            canSaveSceneGlb={!isChatLoading}
          />
        </div>
      )}
      <AlertDialog
        open={pendingDeleteArtifactKey !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDeleteArtifactKey(null);
        }}
      >
        <AlertDialogContent overlayClassName="chat-theme-dialog-overlay" className="chat-theme-dialog w-[min(440px,calc(100%-32px))] max-w-none gap-0 rounded-2xl border border-white/10 p-5 text-[#f4f3f8] shadow-[0_28px_90px_rgba(0,0,0,0.5)] sm:p-6">
          <AlertDialogHeader className="gap-[10px]">
            <AlertDialogTitle className="flex items-center gap-3 text-base tracking-tight">
              <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-red-500/10 text-red-300">
                <Trash2 size={18} aria-hidden="true" />
              </span>
              从 Preview Worker 删除该产物？
            </AlertDialogTitle>
            <AlertDialogDescription className="pl-[52px] text-[13px] leading-[1.5] text-white/55">
              确认后，该产物将从 Preview Worker 的文件目录树中移除。需要时可通过聊天气泡中的 Preview 入口重新添加。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="mt-5 flex-row gap-2 border-t border-white/[0.08] pt-4">
            <AlertDialogCancel className="h-10 min-w-[88px] rounded-xl border-white/10 bg-white/[0.04] text-white/75 hover:bg-white/[0.09] hover:text-white">
              取消
            </AlertDialogCancel>
            <AlertDialogAction
              className="h-10 min-w-[88px] rounded-xl bg-red-600 text-white shadow-sm shadow-red-950/20 hover:bg-red-500"
              onClick={() => {
                deleteCurrentArtifact();
                setPendingDeleteArtifactKey(null);
              }}
            >
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
