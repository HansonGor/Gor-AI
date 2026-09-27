// AI 对话页面组件
import { useEffect, useCallback, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  ChevronLeft,
  Menu,
  Bell,
  Sun,
  Moon,
  MonitorPlay,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightOpen,
} from 'lucide-react';
import { Button } from '../../components/ui/button';
import { Badge } from '../../components/ui/badge';
import AppAvatar from '../../components/AppAvatar';
import ChatBox from '../../components/ChatBox';
import WebPreview from '../../components/ChatBox/WebPreview';
import PreviewWorker from '../../components/ChatBox/PreviewWorker';
import type {
  PreviewWorkerMode,
  PreviewWorkerTarget,
} from '../../components/ChatBox/PreviewWorker';
import Sidebar from '../../components/Sidebar/Sidebar';
import { useChat } from '../../hooks/useChat';
import { useLayout } from '../../hooks/useLayout';
import { useTheme } from '../../hooks/useTheme';
import { nativeBridge } from '../../utils/nativeBridge';
import '../../App.less';
import './chat.less';
import type { GeneratedFile, PreviewProjectSnapshot, UploadedAttachment } from '../../types';
import { importPreviewArchive, importPreviewDirectory } from '../../preview/core/importArchive';
import type { ImportedDistArchive, ImportedPreviewArchive } from '../../preview/core/importArchive';
import { usePreviewProjectStore } from '../../stores/previewProjectStore';
import { validateSceneSpec } from '../../modeling/sceneSpec';
import { createUploadSummaryRequest } from '../../utils/uploadSummary';
import { getSessionPreview, getSessionPreviewArtifact, saveSessionPreview, saveSessionPreviewUi } from '../../utils/sessionPreviewStorage';
import { getSessionPreviewProject, saveSessionPreviewProject } from '../../api/previewProject';
import { hasCurrentProjectSource, hasPreviewFiles } from '../../preview/core/previewFilePresence';
import { getSnapshotBackedHtmlArtifactUrls } from '../../preview/core/snapshotArtifactDedup';
import { canonicalizePresentationFiles, isPresentationSnapshotFile } from '../../preview/core/presentationSnapshot';
import { deletePendingSessionAttachment, saveGeneratedGlb, uploadSessionAttachment } from '../../api/chat';
import { createTemplateFiles } from '../../preview/templates';
import { useFeedback } from '../../components/ui/feedback';

export default function ChatPage() {
  const {
    sessions,
    sessionId,
    isSessionReady,
    messages,
    projectChanges,
    projectRevision,
    previewRevision,
    input,
    setInput,
    pendingImages,
    pendingUploadAttachments,
    isLoading,
    selectSession,
    createNewSession,
    deleteSessionById,
    handleSend,
    queueUploadSummary,
    clearPendingUploadSummary,
    addGeneratedFileToLatestAssistant,
    hasPendingUploadSummary,
    handleSummarizeImages,
    handleStop,
    handleImageSelect,
    removePendingImage,
    initApp,
  } = useChat();

  const {
    mobileSidebarVisible,
    sidebarOpen,
    togglePCSidebar,
    openMobileSidebar,
    closeMobileSidebar,
  } = useLayout();

  const { theme, toggleTheme } = useTheme();
  const { notify } = useFeedback();
  const handleSaveSceneGlb = useCallback(async (blob: Blob, name: string) => {
    if (!sessionId) throw new Error('当前没有活动会话，无法保存模型。');
    const file = await saveGeneratedGlb(sessionId, blob, name);
    addGeneratedFileToLatestAssistant(file);
    notify(`已保存 ${file.displayName} 到当前会话。`);
    return file;
  }, [sessionId, addGeneratedFileToLatestAssistant, notify]);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewWorkerOpen, setPreviewWorkerOpen] = useState(false);
  const [previewWorkerMode, setPreviewWorkerMode] = useState<PreviewWorkerMode>('preview');
  const [previewWorkerTarget, setPreviewWorkerTarget] = useState<PreviewWorkerTarget>('project');
  const [activeProjectSnapshotMessageId, setActiveProjectSnapshotMessageId] = useState<string | null>(null);
  const [activeProjectSourcePath, setActiveProjectSourcePath] = useState<string | undefined>();
  const [hiddenArtifactsBySession, setHiddenArtifactsBySession] = useState<Record<string, string[]>>({});
  const [activePreviewFile, setActivePreviewFile] = useState<GeneratedFile | null>(null);
  const [activeUploadedAttachmentKey, setActiveUploadedAttachmentKey] = useState<string | null>(null);
  const [importedDist, setImportedDist] = useState<ImportedDistArchive | null>(null);
  const [hasImportedSource, setHasImportedSource] = useState(false);
  const [hasServerPreviewProject, setHasServerPreviewProject] = useState(false);
  const [importedUploadName, setImportedUploadName] = useState<string | null>(null);
  const [pendingImportedUploadName, setPendingImportedUploadName] = useState<string | null>(null);
  const [loadedPreviewSessionId, setLoadedPreviewSessionId] = useState<string | null>(null);
  const previewProjectState = usePreviewProjectStore();
  const projectSnapshots = useMemo(() => {
    const seen = new Set<string>();
    return messages.flatMap((message) => {
      const snapshot = message.role === 'assistant' ? message.previewSnapshot : undefined;
      if (!snapshot || seen.has(snapshot.messageId)) return [];
      seen.add(snapshot.messageId);
      return [snapshot];
    });
  }, [messages]);
  const messagePreviewArtifacts = useMemo(() => messages.flatMap((message) => {
    if (message.role !== 'assistant') return [];
    const files = message.files?.length ? message.files : message.file ? [message.file] : [];
    if (!message.previewSnapshot && files.length === 0) return [];
    return [{ messageId: message.previewSnapshot?.messageId ?? message.id, snapshot: message.previewSnapshot ?? null, files }];
  }), [messages]);
  const activeProjectSnapshot = projectSnapshots.find((snapshot) => snapshot.messageId === activeProjectSnapshotMessageId) ?? null;
  const loadedPreviewSessionRef = useRef<string | null>(null);
  const activeSessionRef = useRef(sessionId);
  const failedPersistenceSessionsRef = useRef(new Set<string>());
  const pendingImportedPreviewRef = useRef<{ imported: ImportedPreviewArchive; uploadName: string } | null>(null);
  const restoredActivePreviewFileUrlRef = useRef<string | null>(null);
  const skipContentSaveSessionRef = useRef<string | null>(null);
  const persistedSourceProjectIdRef = useRef<string | null>(null);
  const serverSaveQueueRef = useRef(Promise.resolve());
  const sourceProjectSnapshot = hasImportedSource ? previewProjectState.project : null;
  const generatedFiles = useMemo(() => {
    const unique = new Map<string, GeneratedFile>();
    messages.forEach((message) => {
      const files = message.files?.length ? message.files : message.file ? [message.file] : [];
      canonicalizePresentationFiles(files, message.previewSnapshot).forEach((file) => unique.set(file.downloadUrl, file));
    });
    projectChanges.forEach((change) => {
      if (!/\.html?$/i.test(change.path)) return;
      const downloadUrl = `/${change.path.split('/').map(encodeURIComponent).join('/')}`;
      unique.set(downloadUrl, {
        fileType: 'html',
        displayName: change.path.split('/').pop() || change.path,
        downloadUrl,
      });
    });
    return Array.from(unique.values());
  }, [messages, projectChanges]);
  const snapshotBackedHtmlArtifactUrls = useMemo(
    () => getSnapshotBackedHtmlArtifactUrls(messages, projectChanges),
    [messages, projectChanges],
  );
  const previewSourcePaths = useMemo(() => {
    const changedPaths = new Set<string>();
    messages.forEach((message) => {
      message.previewChanges?.forEach((change) => changedPaths.add(change.path));
    });
    const existingChangedPaths = [...changedPaths].filter((path) => Object.prototype.hasOwnProperty.call(previewProjectState.project.files, path));
    if (hasImportedSource) {
      const sourcePaths = Object.keys(previewProjectState.project.files).filter((path) => /\.(?:html?|[cm]?[jt]sx?|css|json|svg|md|txt)$/i.test(path));
      return [...new Set([...sourcePaths, ...existingChangedPaths])];
    }
    return existingChangedPaths;
  }, [messages, previewProjectState.project.files, hasImportedSource]);
  const uploadedAttachments = useMemo(() => {
    const unique = new Map<string, UploadedAttachment>();
    messages.forEach((message) => {
      if (message.role !== 'user') return;
      message.attachments?.forEach((attachment) => {
        const key = attachment.storageId ?? `${attachment.kind ?? 'file'}:${attachment.name}`;
        unique.set(key, attachment);
      });
    });
    return Array.from(unique.values());
  }, [messages]);
  useEffect(() => {
    if (!sessionId) return;
    setActiveProjectSnapshotMessageId(null);
    setActiveProjectSourcePath(undefined);
    try {
      const saved = localStorage.getItem(`gor-preview-hidden-artifacts:${sessionId}`);
      setHiddenArtifactsBySession((current) => ({
        ...current,
        [sessionId]: saved ? JSON.parse(saved) as string[] : [],
      }));
    } catch {
      setHiddenArtifactsBySession((current) => ({ ...current, [sessionId]: [] }));
    }
  }, [sessionId]);
  const hiddenArtifactKeys = sessionId ? hiddenArtifactsBySession[sessionId] ?? [] : [];
  const visibleUploadedAttachments = useMemo(
    () => uploadedAttachments.filter((attachment) => !hiddenArtifactKeys.includes(`uploaded:${attachment.kind}:${attachment.name}`)),
    [uploadedAttachments, hiddenArtifactKeys],
  );
  const visibleGeneratedFiles = useMemo(
    () => generatedFiles.filter((file) =>
      !hiddenArtifactKeys.includes(`generated:${file.downloadUrl}`)
      && !snapshotBackedHtmlArtifactUrls.has(file.downloadUrl)
      && !isPresentationSnapshotFile(file, projectSnapshots),
    ),
    [generatedFiles, hiddenArtifactKeys, snapshotBackedHtmlArtifactUrls, projectSnapshots],
  );
  const handleDeletePreviewArtifact = useCallback((keys: string[]) => {
    if (!sessionId) return;
    setActiveUploadedAttachmentKey((current) => current && keys.includes(current) ? null : current);
    setHiddenArtifactsBySession((current) => {
      const next = [...new Set([...(current[sessionId] ?? []), ...keys])];
      try {
        localStorage.setItem(`gor-preview-hidden-artifacts:${sessionId}`, JSON.stringify(next));
      } catch {
        notify('该产物已从本次预览列表移除，但浏览器未能保存此设置。');
      }
      return { ...current, [sessionId]: next };
    });
  }, [sessionId, notify]);
  const restorePreviewArtifact = useCallback((key: string) => {
    if (!sessionId) return;
    setHiddenArtifactsBySession((current) => {
      const next = (current[sessionId] ?? []).filter((item) => item !== key);
      try {
        localStorage.setItem(`gor-preview-hidden-artifacts:${sessionId}`, JSON.stringify(next));
      } catch {
        notify('已恢复预览列表，但浏览器未能保存此设置。');
      }
      return { ...current, [sessionId]: next };
    });
  }, [sessionId, notify]);
  const handlePreviewAttachment = useCallback(async (attachment: UploadedAttachment) => {
    if (!sessionId) return;
    const key = `uploaded:${attachment.kind}:${attachment.name}`;
    setHiddenArtifactsBySession((current) => {
      const next = (current[sessionId] ?? []).filter((item) => item !== key);
      try {
        localStorage.setItem(`gor-preview-hidden-artifacts:${sessionId}`, JSON.stringify(next));
      } catch {
        notify('已恢复预览列表，但浏览器未能保存此设置。');
      }
      return { ...current, [sessionId]: next };
    });
    setActiveUploadedAttachmentKey(key);
    setPreviewOpen(false);
    setPreviewWorkerMode('preview');
    setPreviewWorkerOpen(true);
    try {
      const artifact = await getSessionPreviewArtifact(sessionId, attachment.name);
      const legacySnapshot = artifact ? undefined : await getSessionPreview(sessionId);
      if (activeSessionRef.current !== sessionId) return;
      const savedUploadName = artifact?.uploadName ?? legacySnapshot?.uploadName;
      const savedContent = artifact?.content ?? legacySnapshot?.content;
      const attachmentName = attachment.name.trim().replace(/\.zip$/i, '').toLocaleLowerCase();
      const savedNameMatches = savedUploadName?.trim().replace(/\.zip$/i, '').toLocaleLowerCase() === attachmentName;
      if (savedNameMatches && savedContent?.kind === 'dist') {
        setImportedDist(savedContent.archive);
        setHasImportedSource(false);
        setImportedUploadName(savedUploadName!);
        setPreviewWorkerTarget('uploaded-dist');
        return;
      }
      if (savedNameMatches && savedContent?.kind === 'source') {
        const store = usePreviewProjectStore.getState();
        store.importProject(savedContent.template, savedContent.files, savedContent.name, savedContent.projectId);
        store.requestBuildAndRun();
        setImportedDist(null);
        setHasImportedSource(true);
        setImportedUploadName(savedUploadName!);
        setPreviewWorkerTarget('project');
        return;
      }
      const previewStorageId = attachment.previewStorageId ?? (
        attachment.kind === 'archive' || attachment.kind === 'folder' ? attachment.storageId : undefined
      );
      if (!savedNameMatches && previewStorageId) {
        const response = await fetch(`/api/chat/session/${encodeURIComponent(sessionId)}/attachments/${encodeURIComponent(previewStorageId)}`);
        if (!response.ok) throw new Error('无法从服务器读取此附件。');
        const uploadedArchive = new Uint8Array(await response.arrayBuffer());
        const restored = await importPreviewArchive(uploadedArchive, `${attachment.name.replace(/\.zip$/i, '')}.zip`);
        if (activeSessionRef.current !== sessionId) return;
        const content = restored.kind === 'dist'
          ? { kind: 'dist' as const, archive: restored }
          : { kind: 'source' as const, name: restored.name, template: restored.template, files: restored.files };
        await saveSessionPreview({ sessionId, uploadName: attachment.name, content, updatedAt: Date.now() });
        if (restored.kind === 'dist') {
          setImportedDist(restored);
          setHasImportedSource(false);
          setPreviewWorkerTarget('uploaded-dist');
        } else {
          const store = usePreviewProjectStore.getState();
          store.importProject(restored.template, restored.files, restored.name);
          store.requestBuildAndRun();
          setImportedDist(null);
          setHasImportedSource(true);
          setPreviewWorkerTarget('project');
        }
        setImportedUploadName(attachment.name);
        return;
      }
      if (!savedNameMatches) {
        const serverArtifact = await getSessionPreviewProject(sessionId);
        const serverNameMatches = serverArtifact?.origin === 'uploaded-source'
          && serverArtifact.uploadName?.trim().replace(/\.zip$/i, '').toLocaleLowerCase() === attachmentName;
        if (serverNameMatches && serverArtifact) {
          const store = usePreviewProjectStore.getState();
          store.importProject(serverArtifact.project.template, serverArtifact.project.files, serverArtifact.project.name, serverArtifact.project.id);
          store.requestBuildAndRun();
          setImportedDist(null);
          setHasImportedSource(true);
          setImportedUploadName(serverArtifact.uploadName);
          setPreviewWorkerTarget('project');
          return;
        }
      }
    } catch (error) {
      console.warn('[Preview] 恢复附件预览数据失败:', error);
    }
    const sameUpload = importedUploadName?.trim().replace(/\.zip$/i, '').toLocaleLowerCase()
      === attachment.name.trim().replace(/\.zip$/i, '').toLocaleLowerCase();
    setPreviewWorkerTarget(sameUpload && importedDist ? 'uploaded-dist' : sameUpload && hasImportedSource ? 'project' : 'uploaded-missing');
  }, [sessionId, importedUploadName, importedDist, hasImportedSource, notify]);
  const isPreviewSessionLoaded = Boolean(sessionId) && loadedPreviewSessionId === sessionId;
  const visibleImportedDist = isPreviewSessionLoaded ? importedDist : null;
  const visibleImportedSource = isPreviewSessionLoaded && hasImportedSource;
  const hasProjectSource = hasCurrentProjectSource(
    Object.keys(previewProjectState.project.files).length,
    visibleImportedSource,
    hasServerPreviewProject,
    previewSourcePaths.length,
  );
  const hasVisibleCurrentProject = hasProjectSource && !hiddenArtifactKeys.includes(`project:${previewProjectState.project.id}`);
  const hasVisibleProjectSnapshot = projectSnapshots.some(
    (snapshot) => !hiddenArtifactKeys.includes(`project-snapshot:${snapshot.messageId}`),
  );
  const hasPreviewWorkerContent = isPreviewSessionLoaded && hasPreviewFiles({
    currentProjectVisible: hasVisibleCurrentProject,
    projectSnapshotCount: hasVisibleProjectSnapshot ? 1 : 0,
    generatedFileCount: visibleGeneratedFiles.length,
    uploadedAttachmentCount: visibleUploadedAttachments.length,
    hasImportedDist: visibleImportedDist !== null,
  });
  const visiblePreviewWorkerOpen = isPreviewSessionLoaded && previewWorkerOpen && hasPreviewWorkerContent;
  const visiblePreviewOpen = isPreviewSessionLoaded && previewOpen;

  useEffect(() => {
    if (!isPreviewSessionLoaded || hasPreviewWorkerContent) return;
    setPreviewWorkerOpen(false);
  }, [isPreviewSessionLoaded, hasPreviewWorkerContent]);

  useEffect(() => {
    let cancelled = false;
    activeSessionRef.current = sessionId;
    loadedPreviewSessionRef.current = null;
    setLoadedPreviewSessionId(null);
    setPreviewOpen(false);
    setPreviewWorkerOpen(false);
    setPreviewWorkerMode('preview');
    setPreviewWorkerTarget('project');
    setActivePreviewFile(null);
    setActiveUploadedAttachmentKey(null);
    setImportedDist(null);
    setHasImportedSource(false);
    setHasServerPreviewProject(false);
    setImportedUploadName(null);
    restoredActivePreviewFileUrlRef.current = null;
    persistedSourceProjectIdRef.current = null;
    pendingImportedPreviewRef.current = null;
    setPendingImportedUploadName(null);

    if (!sessionId) return () => { cancelled = true; };

    void Promise.allSettled([getSessionPreview(sessionId), getSessionPreviewProject(sessionId)])
      .then(([localResult, serverResult]) => {
        if (cancelled || activeSessionRef.current !== sessionId) return;
        const localSnapshot = localResult.status === 'fulfilled' ? localResult.value : undefined;
        const serverSnapshot = serverResult.status === 'fulfilled' ? serverResult.value : null;
        if (localResult.status === 'rejected') console.warn('[Preview] 恢复本地会话上传内容失败:', localResult.reason);
        if (serverResult.status === 'rejected') console.warn('[Preview] 恢复服务端 Preview 项目失败，将尝试本地缓存:', serverResult.reason);

        if (localSnapshot || serverSnapshot) {
          skipContentSaveSessionRef.current = sessionId;
          if (serverSnapshot) {
            const store = usePreviewProjectStore.getState();
            const savedProject = serverSnapshot.project;
            store.importProject(savedProject.template, savedProject.files, savedProject.name, savedProject.id);
            if (localSnapshot?.selectedFilePath) store.selectFile(localSnapshot.selectedFilePath);
            persistedSourceProjectIdRef.current = store.project.id;
            store.requestBuildAndRun();
            setHasImportedSource(serverSnapshot.origin === 'uploaded-source');
            setHasServerPreviewProject(true);
            setImportedUploadName(serverSnapshot.origin === 'uploaded-source' ? serverSnapshot.uploadName : localSnapshot?.uploadName ?? null);
          } else if (localSnapshot?.content.kind === 'source') {
            const store = usePreviewProjectStore.getState();
            store.importProject(localSnapshot.content.template, localSnapshot.content.files, localSnapshot.content.name, localSnapshot.content.projectId);
            if (localSnapshot.selectedFilePath) store.selectFile(localSnapshot.selectedFilePath);
            persistedSourceProjectIdRef.current = store.project.id;
            store.requestBuildAndRun();
            setHasImportedSource(true);
            setImportedUploadName(localSnapshot.uploadName);
          }
          if (localSnapshot?.content.kind === 'dist') setImportedDist(localSnapshot.content.archive);
          if (localSnapshot) {
            if (!serverSnapshot) setImportedUploadName(localSnapshot.uploadName);
            setPreviewOpen(localSnapshot.previewOpen);
            setPreviewWorkerOpen(localSnapshot.previewWorkerOpen || Boolean(serverSnapshot));
            setPreviewWorkerMode(localSnapshot.previewWorkerMode);
            // A per-message snapshot is selected in-memory; the worker's UI snapshot only
            // stores the target kind, so do not restore an orphaned snapshot target.
            setPreviewWorkerTarget(localSnapshot.previewWorkerTarget === 'project-snapshot' ? 'project' : localSnapshot.previewWorkerTarget);
            restoredActivePreviewFileUrlRef.current = localSnapshot.activePreviewFileUrl;
          } else if (serverSnapshot) {
            setPreviewWorkerOpen(true);
            setPreviewWorkerTarget('project');
          }
          // The generated-file history may still be loading; its existing selection effect
          // will select the latest file once messages have been restored.
        }
        loadedPreviewSessionRef.current = sessionId;
        setLoadedPreviewSessionId(sessionId);
      })
      .catch((error: unknown) => console.warn('[Preview] 恢复会话预览状态失败:', error))
      .finally(() => {
        if (!cancelled && activeSessionRef.current === sessionId) {
          loadedPreviewSessionRef.current = sessionId;
          setLoadedPreviewSessionId(sessionId);
        }
      });

    return () => { cancelled = true; };
  }, [sessionId]);

  useEffect(() => {
    const restoredUrl = restoredActivePreviewFileUrlRef.current;
    if (!restoredUrl) return;
    const restoredFile = generatedFiles.find((file) => file.downloadUrl === restoredUrl);
    if (restoredFile) {
      setActivePreviewFile(restoredFile);
      restoredActivePreviewFileUrlRef.current = null;
    }
  }, [generatedFiles]);

  // Project source, uploaded dist bytes, and the panel state are stored per session.
  // The loaded-session guard prevents a just-switched session from saving stale state.
  useEffect(() => {
    if (!sessionId || loadedPreviewSessionRef.current !== sessionId || !importedUploadName) return;
    if (skipContentSaveSessionRef.current === sessionId) {
      skipContentSaveSessionRef.current = null;
      return;
    }

    const content = sourceProjectSnapshot
      ? {
          kind: 'source' as const,
          projectId: sourceProjectSnapshot.id,
          name: sourceProjectSnapshot.name,
          template: sourceProjectSnapshot.template,
          files: sourceProjectSnapshot.files,
        }
      : importedDist
        ? { kind: 'dist' as const, archive: importedDist }
        : null;
    if (!content) return;

    const snapshot = {
      sessionId,
      uploadName: importedUploadName,
      content,
      updatedAt: Date.now(),
    };
    const timer = window.setTimeout(() => {
      if (sourceProjectSnapshot) persistedSourceProjectIdRef.current = sourceProjectSnapshot.id;
      void saveSessionPreview(snapshot).catch((error: unknown) => {
        console.warn('[Preview] 保存会话上传内容失败:', error);
        if (!failedPersistenceSessionsRef.current.has(sessionId)) {
          failedPersistenceSessionsRef.current.add(sessionId);
          notify('本地缓存上传内容失败，切换会话后可能无法恢复。');
        }
      });
    }, sourceProjectSnapshot && persistedSourceProjectIdRef.current === sourceProjectSnapshot.id ? 250 : 0);
    return () => window.clearTimeout(timer);
  }, [
    sessionId,
    importedUploadName,
    importedDist,
    sourceProjectSnapshot,
    notify,
  ]);

  // Persist generated and uploaded source projects in PostgreSQL. The untouched starter
  // template is not stored; an existing snapshot is still saved after Reset Project.
  useEffect(() => {
    if (!sessionId || loadedPreviewSessionRef.current !== sessionId) return;
    const project = previewProjectState.project;
    const defaultFiles = createTemplateFiles(project.template);
    const differsFromTemplate = project.name !== (project.template === 'react' ? 'React Preview' : 'HTML Preview')
      || JSON.stringify(project.files) !== JSON.stringify(defaultFiles);
    if (!hasImportedSource && !hasServerPreviewProject && !differsFromTemplate) return;

    const timer = window.setTimeout(() => {
      const save = async () => {
        await saveSessionPreviewProject(
          sessionId,
          project,
          hasImportedSource ? 'uploaded-source' : 'generated',
          hasImportedSource ? importedUploadName : null,
        );
        if (activeSessionRef.current === sessionId) setHasServerPreviewProject(true);
      };
      serverSaveQueueRef.current = serverSaveQueueRef.current
        .catch(() => undefined)
        .then(save)
        .catch((error: unknown) => {
          console.warn('[Preview] 保存服务端 Preview 项目失败:', error);
          if (!failedPersistenceSessionsRef.current.has(sessionId)) {
            failedPersistenceSessionsRef.current.add(sessionId);
            notify('Preview 项目暂未同步到服务器，当前浏览器仍会保留上传缓存。');
          }
        });
    }, 450);
    return () => window.clearTimeout(timer);
  }, [
    sessionId,
    previewProjectState.project,
    hasImportedSource,
    hasServerPreviewProject,
    importedUploadName,
    notify,
  ]);

  useEffect(() => {
    if (!sessionId || loadedPreviewSessionRef.current !== sessionId || !importedUploadName) return;
    try {
      saveSessionPreviewUi(sessionId, {
      previewOpen,
      previewWorkerOpen,
      previewWorkerMode,
      previewWorkerTarget,
        activePreviewFileUrl: activePreviewFile?.downloadUrl ?? null,
        selectedFilePath: hasImportedSource ? previewProjectState.selectedFilePath : null,
      });
    } catch (error) {
      console.warn('[Preview] 保存会话预览面板状态失败:', error);
    }
  }, [
    sessionId,
    importedUploadName,
    previewOpen,
    previewWorkerOpen,
    previewWorkerMode,
    previewWorkerTarget,
    activePreviewFile,
    hasImportedSource,
    previewProjectState.selectedFilePath,
  ]);

  useEffect(() => {
    if (previewRevision > 0) {
      setPreviewOpen(false);
      setPreviewWorkerMode('preview');
      setPreviewWorkerTarget('project');
      setPreviewWorkerOpen(true);
    }
  }, [previewRevision]);

  useEffect(() => {
    if (!isLoading) return;
    const latest = messages[messages.length - 1];
    if (latest?.role !== 'assistant' || latest.previewSnapshot?.template !== 'presentation') return;
    setActiveProjectSnapshotMessageId(latest.previewSnapshot.messageId);
    setActiveProjectSourcePath(undefined);
    setPreviewWorkerMode('preview');
    setPreviewWorkerTarget('project-snapshot');
    setPreviewOpen(false);
    setPreviewWorkerOpen(true);
  }, [messages, isLoading]);

  useEffect(() => {
    if (projectRevision > 0) {
      const latestChange = projectChanges[projectChanges.length - 1];
      if (latestChange && /\.html?$/i.test(latestChange.path)) {
        const previewUrl = `/${latestChange.path.split('/').map(encodeURIComponent).join('/')}`;
        const htmlFile = generatedFiles.find((file) => file.downloadUrl === previewUrl);
        if (htmlFile) {
          setActivePreviewFile(htmlFile);
          setPreviewWorkerMode('preview');
          setPreviewWorkerTarget('generated');
          setPreviewOpen(false);
          setPreviewWorkerOpen(true);
        }
      } else {
        setPreviewWorkerOpen(false);
        setPreviewOpen(true);
      }
    }
  }, [generatedFiles, projectChanges, projectRevision]);

  useEffect(() => {
    if (generatedFiles.length === 0) {
      setActivePreviewFile(null);
      return;
    }
    if (
      !activePreviewFile ||
      !generatedFiles.some((file) => file.downloadUrl === activePreviewFile.downloadUrl)
    ) {
      setActivePreviewFile(generatedFiles[generatedFiles.length - 1]);
    }
  }, [activePreviewFile, generatedFiles]);

  const openPreviewWorker = useCallback((file?: GeneratedFile, intent: 'preview' | 'source' = 'source') => {
    setPreviewOpen(false);
    let openSource = false;
    if (file) {
      restorePreviewArtifact(`generated:${file.downloadUrl}`);
      setActivePreviewFile(file);
      setPreviewWorkerTarget('generated');
      if (file.fileType === '3d') {
        const store = usePreviewProjectStore.getState();
        const sceneSource = store.project.files['/src/scene.json'];
        if (sceneSource !== undefined) {
          try {
            validateSceneSpec(JSON.parse(sceneSource));
            store.selectFile('/src/scene.json');
            openSource = true;
          } catch {
            // This GLB has no valid SceneSpec source in the current project.
          }
        }
      }
    } else if (importedDist) {
      setPreviewWorkerTarget('uploaded-dist');
    } else {
      setPreviewWorkerTarget('project');
    }
    setPreviewWorkerMode(openSource && intent === 'source' ? 'code' : 'preview');
    setPreviewWorkerOpen(true);
  }, [importedDist, restorePreviewArtifact]);

  const handleChatSend = useCallback(async (...args: Parameters<typeof handleSend>) => {
    const pendingPreview = pendingImportedPreviewRef.current;
    if (pendingPreview) {
      pendingImportedPreviewRef.current = null;
      const { imported, uploadName } = pendingPreview;
      if (imported.kind === 'source') {
        usePreviewProjectStore.getState().importProject(imported.template, imported.files, imported.name);
        usePreviewProjectStore.getState().requestBuildAndRun();
        setImportedDist(null);
        setHasImportedSource(true);
        setPreviewWorkerTarget('project');
      } else {
        setImportedDist(imported);
        setHasImportedSource(false);
        setPreviewWorkerTarget('uploaded-dist');
      }
      setImportedUploadName(uploadName);
      const sentAttachment = pendingUploadAttachments.find((attachment) =>
        attachment.name.trim().replace(/\.zip$/i, '').toLocaleLowerCase()
          === uploadName.trim().replace(/\.zip$/i, '').toLocaleLowerCase(),
      ) ?? pendingUploadAttachments[0];
      setActiveUploadedAttachmentKey(sentAttachment
        ? `uploaded:${sentAttachment.kind}:${sentAttachment.name}`
        : `uploaded:${imported.kind === 'dist' ? 'archive' : 'folder'}:${uploadName}`);
      setPendingImportedUploadName(null);
      setPreviewOpen(false);
      setPreviewWorkerMode('preview');
      setPreviewWorkerOpen(true);
    }
    await handleSend(...args);
  }, [handleSend, pendingUploadAttachments]);

  const applyImportedPreview = useCallback((imported: ImportedPreviewArchive, uploadName: string, signal?: AbortSignal) => {
    if (signal?.aborted) return;
    pendingImportedPreviewRef.current = { imported, uploadName };
    setPendingImportedUploadName(uploadName);
  }, []);

  const handleArchiveSelect = useCallback(async (file: File, signal?: AbortSignal) => {
    if (file.size > 20 * 1024 * 1024) throw new Error('ZIP 文件超过 20 MB，暂不支持导入。');
    const imported = await importPreviewArchive(new Uint8Array(await file.arrayBuffer()), file.name, signal);
    if (!signal?.aborted) {
      const summary = createUploadSummaryRequest(imported, file.name, 'archive');
      if (!sessionId) throw new Error('会话尚未准备好，请稍后重试。');
      summary.attachments = [{ ...summary.attachments[0], ...await uploadSessionAttachment(sessionId, file, file.name, 'archive') }];
      if (signal?.aborted) return;
      applyImportedPreview(imported, file.name, signal);
      queueUploadSummary(summary.prompt, undefined, summary.displayText, summary.analysisContext, summary.attachments);
    }
  }, [applyImportedPreview, queueUploadSummary, sessionId]);

  const handleFolderSelect = useCallback(async (files: FileList | File[], signal?: AbortSignal) => {
    const imported = await importPreviewDirectory(files, signal);
    const selectedFiles = Array.from(files);
    const isFolderUpload = selectedFiles.some((file) => Boolean(file.webkitRelativePath));
    const folderName = selectedFiles[0]?.webkitRelativePath.split('/')[0] || imported.name;
    if (!signal?.aborted) {
      const summary = createUploadSummaryRequest(imported, folderName, 'folder');
      if (!sessionId) throw new Error('会话尚未准备好，请稍后重试。');
      const archiveBlob = new Blob([Uint8Array.from(imported.archiveBytes).buffer as ArrayBuffer], { type: 'application/zip' });
      if (isFolderUpload) {
        const stored = await uploadSessionAttachment(sessionId, archiveBlob, `${folderName}.zip`, 'folder');
        summary.attachments = [{ ...summary.attachments[0], ...stored, name: folderName, kind: 'folder' }];
      } else {
        const storedFiles = await Promise.all(selectedFiles.map((file) => uploadSessionAttachment(sessionId, file, file.name, 'file')));
        const storedPreviewBundle = await uploadSessionAttachment(
          sessionId,
          archiveBlob,
          `${folderName}.zip`,
          'archive',
        );
        summary.attachments = storedFiles.map((stored) => ({ ...stored, previewStorageId: storedPreviewBundle.storageId }));
      }
      if (signal?.aborted) return;
      applyImportedPreview(imported, folderName, signal);
      queueUploadSummary(summary.prompt, undefined, summary.displayText, summary.analysisContext, summary.attachments);
    }
  }, [applyImportedPreview, queueUploadSummary, sessionId]);

  const removeImportedUpload = useCallback(() => {
    if (sessionId) {
      const attachmentIds = new Set(pendingUploadAttachments.flatMap((attachment) =>
        [(attachment as UploadedAttachment).storageId, (attachment as UploadedAttachment).previewStorageId]
          .filter((id): id is string => Boolean(id)),
      ));
      void Promise.allSettled([...attachmentIds].map((id) => deletePendingSessionAttachment(sessionId, id)));
    }
    pendingImportedPreviewRef.current = null;
    setPendingImportedUploadName(null);
    clearPendingUploadSummary();
  }, [clearPendingUploadSummary, pendingUploadAttachments, sessionId]);

  useEffect(() => {
    initApp();
  }, [initApp]);

  const handleSelectSession = useCallback(
    (id: string) => {
      selectSession(id);
      closeMobileSidebar();
    },
    [selectSession, closeMobileSidebar],
  );

  const showNativeBack = nativeBridge.shouldShowBackButton();
  const handleHeaderLeft = useCallback(() => {
    if (showNativeBack) {
      nativeBridge.goBack();
    } else {
      openMobileSidebar();
    }
  }, [showNativeBack, openMobileSidebar]);

  const goBack = useCallback(() => {
    if (window.history.length > 1) {
      window.history.back();
    } else {
      window.location.hash = '#/';
    }
  }, []);

  return (
    <div
      className={`chat-page theme-${theme} relative flex h-full flex-row overflow-hidden bg-[#0f0f19] text-[#f5f5f7]`}
    >
      {/* PC端常驻左侧边栏 */}
      {sidebarOpen && (
        <aside className="hidden lg:flex lg:h-full lg:w-[280px] lg:shrink-0 lg:border-r lg:border-white/5 lg:bg-[#0b0b14]">
          <Sidebar
            sessions={sessions}
            activeSessionId={sessionId}
            onSelectSession={selectSession}
            onCreateSession={createNewSession}
            onDeleteSession={deleteSessionById}
            theme={theme}
            isCollapsed={false}
          />
        </aside>
      )}
      <Button
        type="button"
        variant="ghost"
        size="icon"
        onClick={togglePCSidebar}
        className={`desktop-sidebar-toggle absolute top-1/2 z-30 hidden h-9 w-7 -translate-y-1/2 rounded-r-lg border shadow-md lg:grid ${sidebarOpen ? 'left-[calc(280px-28px)]' : 'left-0'}`}
        aria-label={sidebarOpen ? '收起会话侧边栏' : '展开会话侧边栏'}
        title={sidebarOpen ? '收起会话列表' : '展开会话列表'}
      >
        {sidebarOpen ? <PanelLeftClose size={17} /> : <PanelLeftOpen size={17} />}
      </Button>

      {/* 移动端悬浮侧边栏 */}
      {mobileSidebarVisible && (
        <>
          <div
            className="fixed inset-0 z-40 bg-black/50"
            onClick={closeMobileSidebar}
            aria-hidden="true"
          />
          <div className="fixed inset-y-0 left-0 z-50 lg:hidden">
            <Sidebar
              sessions={sessions}
              activeSessionId={sessionId}
              onSelectSession={handleSelectSession}
              onCreateSession={createNewSession}
              onDeleteSession={deleteSessionById}
              theme={theme}
              isCollapsed={false}
            />
          </div>
        </>
      )}

      {/* 右侧主内容区 */}
      <div className="chat-main-content relative flex h-full min-w-0 flex-1 flex-col overflow-hidden bg-[#0f0f19]">
        <header className="chat-header relative flex shrink-0 items-center justify-between bg-[#0f0f19]/70 backdrop-blur-xl px-[0.28rem] pb-[0.18rem] pt-[0.22rem] shadow-sm lg:px-8 lg:py-3.5">
          <div className="chat-header-left flex items-center gap-[0.18rem] lg:hidden">
            <Button
              variant="ghost"
              size="icon"
              onClick={goBack}
              aria-label="返回上一页"
              title="返回上一页"
              className="chat-icon-btn h-[0.72rem] w-[0.72rem] rounded-full bg-transparent text-white/80 hover:bg-transparent hover:text-white active:scale-90"
            >
              <ArrowLeft size={22} />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={handleHeaderLeft}
              aria-label={showNativeBack ? '返回首页' : '打开会话列表'}
              className="chat-icon-btn h-[0.72rem] w-[0.72rem] rounded-full text-white hover:bg-white/10 hover:text-white active:scale-95"
            >
              {showNativeBack ? <ChevronLeft size={22} /> : <Menu size={20} />}
            </Button>
          </div>
          <span className="chat-brand absolute left-1/2 -translate-x-1/2 text-[0.3rem] font-medium tracking-wide text-white/60 lg:text-base">
            Assistant
          </span>
          <div className="chat-header-right flex items-center gap-[0.12rem] lg:ml-auto lg:gap-3">
            {isPreviewSessionLoaded && projectRevision > 0 && (
              <Button
                variant="ghost"
                size="icon"
                onClick={() =>
                  setPreviewOpen((open) => {
                    const next = !open;
                    if (next) setPreviewWorkerOpen(false);
                    return next;
                  })
                }
                aria-label={previewOpen ? '收起项目网页预览' : '打开项目网页预览'}
                title={previewOpen ? '收起项目网页预览' : '打开项目网页预览'}
                className="chat-icon-btn h-[0.72rem] w-[0.72rem] rounded-full text-white hover:bg-white/10 lg:h-9 lg:w-9"
              >
                <MonitorPlay size={18} />
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon"
              onClick={toggleTheme}
              aria-label={theme === 'dark' ? '切换到白天模式' : '切换到暗黑模式'}
              className="chat-icon-btn h-[0.72rem] w-[0.72rem] rounded-full text-white hover:bg-white/10 hover:text-white active:scale-95 lg:h-9 lg:w-9"
            >
              {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
            </Button>
            <AppAvatar className="chat-header-avatar h-[0.62rem] w-[0.62rem] rounded-full lg:h-9 lg:w-9" />
            <div className="chat-bell relative flex h-[0.72rem] w-[0.72rem] shrink-0 items-center justify-center text-white lg:h-9 lg:w-9">
              <Bell size={18} />
              <Badge className="chat-bell-badge absolute -right-[0.16rem] -top-[0.06rem] h-[0.36rem] min-w-[0.36rem] items-center justify-center rounded-full border-none bg-gradient-to-br from-rose-500 to-red-500 px-[0.06rem] pb-[0.02rem] text-[0.2rem] font-semibold leading-none text-white lg:-right-1 lg:-top-0.5 lg:h-4 lg:min-w-4 lg:text-[10px]">
                2
              </Badge>
            </div>
            {hasPreviewWorkerContent && (
              <Button
                variant="ghost"
                size="icon"
                onClick={() =>
                  visiblePreviewWorkerOpen ? setPreviewWorkerOpen(false) : openPreviewWorker()
                }
                aria-label={visiblePreviewWorkerOpen ? '关闭 Preview Worker' : '打开 Preview Worker'}
                title={visiblePreviewWorkerOpen ? '关闭 Preview Worker' : 'Preview Worker'}
                className={`preview-worker-trigger chat-icon-btn relative h-[0.72rem] w-[0.72rem] rounded-full text-white hover:bg-white/10 lg:h-9 lg:w-9 ${visiblePreviewWorkerOpen ? 'is-active' : ''}`}
              >
                <PanelRightOpen size={18} />
                {generatedFiles.length > 0 && (
                  <span className="preview-worker-count">{generatedFiles.length}</span>
                )}
              </Button>
            )}
          </div>
        </header>

        <main className="chat-main relative flex min-h-0 flex-1 overflow-hidden bg-[#0f0f19]">
          <div className="chat-conversation min-w-0 flex-1">
            {isSessionReady ? (
              <ChatBox
                key={sessionId ?? 'chat'}
                messages={messages}
                input={input}
                setInput={setInput}
                pendingImages={pendingImages}
                pendingUploadAttachments={pendingUploadAttachments}
                isLoading={isLoading}
                handleSend={handleChatSend}
                handleStop={handleStop}
                handleImageSelect={handleImageSelect}
                removePendingImage={removePendingImage}
                onArchiveSelect={handleArchiveSelect}
                onFolderSelect={handleFolderSelect}
                onUploadImages={handleSummarizeImages}
                importedUploadName={isPreviewSessionLoaded && hasPendingUploadSummary ? pendingImportedUploadName : null}
                hasPendingUploadSummary={hasPendingUploadSummary}
                onRemoveImportedUpload={removeImportedUpload}
                onClearPendingUpload={clearPendingUploadSummary}
                onPreviewFile={openPreviewWorker}
                onPreviewAttachment={handlePreviewAttachment}
                onPreviewProject={(file, intent = 'preview', sourcePath, snapshot) => {
                  if (snapshot) {
                    setPreviewOpen(false);
                    setActiveProjectSnapshotMessageId(snapshot.messageId);
                    setActiveProjectSourcePath(sourcePath);
                    restorePreviewArtifact(`project-snapshot:${snapshot.messageId}`);
                    setPreviewWorkerTarget('project-snapshot');
                    setPreviewWorkerMode(intent === 'source' ? 'code' : 'preview');
                    setPreviewWorkerOpen(true);
                    return;
                  }
                  if (file) {
                    openPreviewWorker(file, intent);
                    return;
                  }
                  setPreviewOpen(false);
                  restorePreviewArtifact(`project:${previewProjectState.project.id}`);
                  if (intent === 'source') {
                    const store = usePreviewProjectStore.getState();
                    const sourceCandidates = [
                      sourcePath,
                      '/src/App.tsx', '/src/App.jsx', '/src/App.ts', '/src/App.js',
                      '/src/main.tsx', '/src/main.jsx', '/src/main.ts', '/src/main.js',
                      '/index.html',
                    ];
                    const selectedSource = sourceCandidates.find(
                      (path) => path && store.project.files[path] !== undefined,
                    );
                    if (selectedSource) store.selectFile(selectedSource);
                  }
                  setPreviewWorkerTarget('project');
                  setPreviewWorkerMode(intent === 'source' ? 'code' : 'preview');
                  setPreviewWorkerOpen(true);
                }}
              />
            ) : (
              <div className="app-loading flex h-full flex-col items-center justify-center gap-[0.2rem]">
                <div className="loading-spinner"></div>
                <span className="text-[0.26rem]">正在初始化...</span>
              </div>
            )}
          </div>
          {visiblePreviewOpen && (
            <WebPreview revision={projectRevision} onClose={() => setPreviewOpen(false)} />
          )}
          {visiblePreviewWorkerOpen && (
            <PreviewWorker
              files={visibleGeneratedFiles}
              messagePreviewArtifacts={messagePreviewArtifacts}
              activeFile={activePreviewFile}
              projectSourcePaths={previewSourcePaths}
              uploadedAttachments={visibleUploadedAttachments}
              activeUploadedAttachmentKey={activeUploadedAttachmentKey}
              onSelectUploadedAttachment={setActiveUploadedAttachmentKey}
              onOpenUploadedAttachment={handlePreviewAttachment}
              hiddenArtifactKeys={hiddenArtifactKeys}
              onDeleteArtifact={handleDeletePreviewArtifact}
              hasProjectSource={hasProjectSource}
              mode={previewWorkerMode}
              target={previewWorkerTarget}
              projectSnapshots={projectSnapshots}
              activeProjectSnapshot={activeProjectSnapshot}
              activeProjectSourcePath={activeProjectSourcePath}
              onSelectProjectSnapshot={(snapshot: PreviewProjectSnapshot, intent = 'preview', sourcePath) => {
                setActiveProjectSnapshotMessageId(snapshot.messageId);
                setActiveProjectSourcePath(sourcePath);
                restorePreviewArtifact(`project-snapshot:${snapshot.messageId}`);
                setPreviewWorkerTarget('project-snapshot');
                setPreviewWorkerMode(intent === 'source' ? 'code' : 'preview');
              }}
              onModeChange={setPreviewWorkerMode}
              onTargetChange={setPreviewWorkerTarget}
              importedDist={visibleImportedDist}
              onSaveSceneGlb={handleSaveSceneGlb}
              isChatLoading={isLoading}
              onClose={() => setPreviewWorkerOpen(false)}
            />
          )}
        </main>
      </div>
    </div>
  );
}
