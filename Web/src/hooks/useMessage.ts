// 消息发送与 SSE 接收 Hook
// 负责发送消息、接收 SSE 流式响应、管理消息状态
import { useState, useRef, useCallback, useEffect } from 'react';
import { useFeedback } from '../components/ui/feedback';
import { useFileEditMode } from './useFileEditMode';
import { useThinkingMode } from './useThinkingMode';
import { applyChatModelSelection, useChatModel } from './useChatModel';
import { sendChatMessage } from '../api/chat';
import { acceptThinkingEvent, finishThinking } from '../utils/thinking';
import { saveGeneratedGlb } from '../api/webProjectArtifacts';
import { validateSceneSpec, type SceneSpec } from '../modeling/sceneSpec.ts';
import { saveSceneArtifact } from '../modeling/sceneArtifact.ts';
import { isNewPreviewProjectRequest } from '../preview/core/creationIntent.ts';
import { appendMessageErrorOnce } from '../utils/chatMessageError.ts';
import { getChatClientMode } from '../utils/clientMode';
import { bindLiveChangeSet } from '../utils/changeSetReference';
import { createMessagePreviewSnapshot } from '../preview/core/projectSnapshot.ts';
import { MODEL_CONFIG } from '../config';
import { useVideoPolling } from './useVideoPolling';
import type {
  ChatMessage,
  TokenUsage,
  ModelQuotaInfo,
  ProjectChange,
  PreviewFileChange,
  GeneratedFile,
  UploadedAttachment,
  SearchSource,
  SearchTrace,
} from '../types';
import { createBlankProjectState, usePreviewProjectStore } from '../stores/previewProjectStore.ts';
import { canPublishStagedProject, stageProjectSources } from '../preview/core/stagedProject.ts';
import { reconcilePreviewProject } from '../preview/core/projectSnapshot.ts';
import {
  getSessionPreviewProject,
  PreviewRevisionAdvancedError,
  readSessionPreviewProjectFiles,
  saveSessionPreviewProject,
} from '../api/previewProject';
import { createPresentationSnapshot } from '../preview/core/presentationSnapshot.ts';
import type { PreviewProject, PreviewTemplate } from '../preview/core/types.ts';

const { QUOTA_WARNING_THRESHOLD } = MODEL_CONFIG;

function newMessageId(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function requestedPreviewTemplate(text: string): PreviewTemplate {
  return /(?:html\b|3d|三维|模型|glb)/i.test(text) && !/react/i.test(text) ? 'html' : 'react';
}

interface PendingImage {
  file: File;
  name: string;
  base64: string;
}

interface ContextRemain {
  prompt_tokens: number;
  max_context: number;
  remain_token: number;
  warning: boolean;
}

export function useMessage(sessionId: string | null) {
  const { alert, notify } = useFeedback();
  const { fileEditMode, fileEditModeLoading, setFileEditMode, freezeFileEditMode } = useFileEditMode(sessionId, (message) => notify(message, 'error'));
  const { thinkingMode, thinkingModeLoading, setThinkingMode, freezeThinkingMode } = useThinkingMode(sessionId, (message) => notify(message, 'error'));
  const { chatModelId, chatModelLoading, setChatModel, freezeChatModel } = useChatModel(sessionId, (message) => notify(message, 'error'));
  const changeChatModel = useCallback((modelId: string) => {
    applyChatModelSelection(modelId, chatModelId, setChatModel, setThinkingMode);
  }, [chatModelId, setChatModel, setThinkingMode]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  // 使用 ref 跟踪 messages 最新值，避免 useCallback 依赖 messages 导致重渲染循环
  const messagesRef = useRef(messages);
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);
  const [input, setInput] = useState('');
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [contextRemain, setContextRemain] = useState<ContextRemain | null>(null);
  const [modelQuotaInfo, setModelQuotaInfo] = useState<ModelQuotaInfo | null>(null);
  const [projectChanges, setProjectChanges] = useState<ProjectChange[]>([]);
  const [projectRevision, setProjectRevision] = useState(0);
  const [previewRevision, setPreviewRevision] = useState(0);
  const [pendingUploadSummary, setPendingUploadSummary] = useState<{
    prompt: string;
    images?: string[];
    displayText?: string;
    analysisContext?: string;
    attachments?: UploadedAttachment[];
  } | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const { startVideoPolling, stopVideoPolling } = useVideoPolling();

  useEffect(() => {
    setPendingUploadSummary(null);
  }, [sessionId]);

  useEffect(() => {
    if (getChatClientMode() !== 'web') return;
    const confirmed = (event: Event) => {
      const detail = (event as CustomEvent<{ sessionId: string; changeSetId: string; project: PreviewProject }>).detail;
      if (detail.sessionId !== sessionId) return;
      setMessages(previous => previous.map(message => {
        if (message.projectChangeSet?.id !== detail.changeSetId) return message;
        const changes = message.projectChanges ?? message.previewChanges ?? [];
        const paths = changes.map(change => change.path);
        return { ...message,
          previewChanges: changes.map(change => ({ ...change, projectId: detail.project.id })),
          projectChanges: undefined,
          previewSnapshot: createMessagePreviewSnapshot(detail.project, message.id, paths),
        };
      }));
      setProjectRevision(previous => previous + 1);
      const target = messagesRef.current.find(message => message.projectChangeSet?.id === detail.changeSetId);
      if (target && detail.project.template === 'html' && detail.project.files['/src/scene.json']) {
        // Export only the confirmed scene, into the existing virtual artifact store.
        // Bind to the initiating message rather than whichever reply is latest.
        void (async () => {
          try {
            const scene = validateSceneSpec(JSON.parse(detail.project.files['/src/scene.json']));
            const file = await saveSceneArtifact(scene, (blob, name) => saveGeneratedGlb(detail.sessionId, blob, name, target.id));
            setMessages(previous => previous.map(message => message.id === target.id
              ? { ...message, files: [...(message.files ?? (message.file ? [message.file] : [])), file], file }
              : message));
          } catch (error) {
            notify(error instanceof Error ? error.message : '文件变更请求失败。', 'error');
          }
        })();
      }
    };
    window.addEventListener('gor:review-project-confirmed', confirmed);
    return () => window.removeEventListener('gor:review-project-confirmed', confirmed);
  }, [sessionId, notify]);

  /**
   * 更新最后一条 assistant 消息
   */
  const updateLastAssistant = useCallback((updater: (last: ChatMessage) => ChatMessage) => {
    setMessages((prev) => {
      const updated = [...prev];
      const lastIndex = updated.length - 1;
      if (lastIndex >= 0 && updated[lastIndex].role === 'assistant') {
        updated[lastIndex] = updater(updated[lastIndex]);
      }
      return updated;
    });
  }, []);

  /**
   * 处理图片文件选择
   */
  const handleImageSelect = useCallback(async (files: FileList | File[]) => {
    if (!files || files.length === 0) return;

    const imageFiles = Array.from(files).filter((f) => f.type.startsWith('image/'));
    if (imageFiles.length === 0) {
      return;
    }

    const processed: PendingImage[] = imageFiles.map((file) => ({
      file,
      name: file.name,
      base64: URL.createObjectURL(file),
    }));
    setPendingImages((prev) => [...prev, ...processed]);
  }, []);

  /**
   * 移除待发送的图片
   */
  const removePendingImage = useCallback((index: number) => {
    setPendingImages((prev) => prev.filter((_, i) => i !== index));
  }, []);

  /**
   * 触发文件选择
   */
  const triggerFileInput = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  /**
   * 设置消息列表（用于加载历史消息）
   */
  const setMessagesList = useCallback((msgList: ChatMessage[]) => {
    setMessages(msgList);
    setProjectChanges([]);
    setProjectRevision(0);
    setPreviewRevision(0);
  }, []);

  /**
   * 清空输入和待发送图片
   */
  const clearInput = useCallback(() => {
    setInput('');
    setPendingImages([]);
  }, []);

  /**
   * 发送消息
   */
  const handleSend = useCallback(
    async (
      presetText?: string,
      imageOverrides?: string[],
      displayText?: string,
      analysisContext?: string,
    ) => {
      const typedContent = (presetText ?? input).trim();
      const uploadSummary = pendingUploadSummary;
      const content = typedContent || (uploadSummary ? uploadSummary.prompt : '');
      const attachments = uploadSummary?.attachments ?? pendingImages.map((image) => ({ name: image.name, kind: 'file' as const }));
      const attachmentLabel = attachments.map((attachment) => attachment.name).filter(Boolean).join('、');
      const visibleContent = (displayText ?? (typedContent || (attachmentLabel ? `已发送：${attachmentLabel}` : uploadSummary?.displayText || content))).trim();
      const images = imageOverrides ?? uploadSummary?.images ?? pendingImages.map((image) => image.base64);
      const requestAnalysisContext = analysisContext ?? uploadSummary?.analysisContext;
      const analysisContextMode = uploadSummary || pendingImages.length > 0
        ? (typedContent ? 'reference' : 'summary')
        : undefined;
      const hasImages = images.length > 0;

      if ((!content && !hasImages) || isLoading) return;

      if (!sessionId) {
        console.error('[Message] 会话未初始化');
        return;
      }

      const userMsg: ChatMessage = {
        id: newMessageId(),
        role: 'user',
        content: visibleContent || '（图片）',
        analysisContext,
        attachments: attachments.length ? attachments : undefined,
        images: hasImages ? images : undefined,
      };
      // Capture at send, not after flushing Preview or waiting for the network.
      const frozenEditMode = freezeFileEditMode();
      void frozenEditMode.catch(() => undefined);
      // 失败时已回退为随思，不阻止发送
      const frozenThinkingMode = freezeThinkingMode();
      // 读取失败时不传 modelId，由服务端使用注册表默认模型。
      const frozenChatModel = freezeChatModel();
      const assistantMsg: ChatMessage & { isStreaming?: boolean; toolStatus?: string } = {
        id: newMessageId(),
        role: 'assistant',
        content: '',
        isStreaming: true,
        toolStatus: '',
        executionPhase: 'thinking',
      };

      setMessages((prev) => [...prev, userMsg, assistantMsg]);
      setInput('');
      if (uploadSummary) setPendingUploadSummary(null);
      if (!imageOverrides) setPendingImages([]);
      setIsLoading(true);

      // 构建历史消息（包含图片）——使用 messagesRef 避免依赖 messages
      const history = [...messagesRef.current, userMsg].map((m) => ({
        role: m.role,
        content: m.content,
        images: m.images,
        attachments: m.attachments,
        project_changes: m.projectChanges,
      }));

      const controller = new AbortController();
      abortRef.current = controller;
      let previewFilesChanged = false;
      let sceneToExport: SceneSpec | null = null;
      let completed = false;
      let creationFailed = false;
      let previousPreviewProject: PreviewProject | null = null;
      let createdProjectId: string | null = null;
      let stagedProject: PreviewProject | null = null;
      let stagedProjectReady = false;

      try {
        const editMode = await frozenEditMode;
        const thinkingMode = await frozenThinkingMode;
        const modelId = await frozenChatModel;
        let previewReference: {
          previewProjectId?: string;
          previewServerRevision?: number;
          previewContentRevision?: number;
          previewProjectBootstrap?: PreviewProject;
          previewProjectOrigin?: 'generated' | 'uploaded-source';
          previewProjectUploadName?: string | null;
          newPreviewProject?: boolean;
        } = {};
        if (getChatClientMode() === 'web') {
          let previewProject = structuredClone(usePreviewProjectStore.getState().project);
          if (previewProject.id && (
            previewProject.serverRevision !== undefined
            && (previewProject.revision ?? 0) !== (previewProject.persistedRevision ?? -1)
          )) {
            const origin = previewProject.origin ?? 'generated';
            const saved = await saveSessionPreviewProject(
              sessionId,
              previewProject,
              origin,
              previewProject.uploadName ?? null,
              previewProject.serverRevision,
            );
            usePreviewProjectStore.getState().markServerSaved(
              previewProject.id,
              previewProject.revision ?? 0,
              saved.revision,
              origin,
              previewProject.uploadName ?? null,
            );
            previewProject = structuredClone(usePreviewProjectStore.getState().project);
          }
          if (isNewPreviewProjectRequest(visibleContent)) {
            previousPreviewProject = previewProject;
            if (previewProject.id && Object.keys(previewProject.files).length > 0) {
              // Archive the previous project's latest source for the Worker list.
              // Sources remain separate from prose/model history.
              const archived = previewProject;
              setMessages((previous) => {
                let index = previous.length - 1;
                while (index >= 0 && !(previous[index].role === 'assistant' && previous[index].previewChanges?.some((change) => change.projectId === archived.id))) index--;
                if (index < 0) return previous;
                return previous.map((message, position) => position === index ? {
                  ...message,
                  previewSnapshot: createMessagePreviewSnapshot(archived, message.id, message.previewChanges?.map((change) => change.path) ?? []),
                } : message);
              });
            }
            previewProject = createBlankProjectState(requestedPreviewTemplate(visibleContent));
            stagedProject = previewProject;
            createdProjectId = previewProject.id;
          }
          if (previewProject.id) {
            previewReference = previewProject.serverRevision !== undefined
              ? {
                  previewProjectId: previewProject.id,
                  previewServerRevision: previewProject.serverRevision,
                  previewContentRevision: previewProject.revision ?? 0,
                }
              : {
                  previewProjectBootstrap: previewProject,
                  previewProjectOrigin: previewProject.origin ?? 'generated',
                  previewProjectUploadName: previewProject.uploadName ?? null,
                  ...(createdProjectId ? { newPreviewProject: true, previewServerRevision: previousPreviewProject?.serverRevision } : {}),
                };
          }
        }
        await sendChatMessage(
          {
            sessionId,
            message: visibleContent || '（图片）',
            messages: history,
            attachments,
            analysisContext: requestAnalysisContext,
            analysisContextMode,
            ...previewReference,
            assistantMessageId: assistantMsg.id,
            editMode,
            thinkingMode,
            modelId,
          },
          {
            onThinking: (event) => {
              setMessages(previous => previous.map(message => message.id === assistantMsg.id
                ? { ...message, thinkingTrace: acceptThinkingEvent(message.thinkingTrace, event) } : message));
            },
            onToken: (tokenContent: string) => {
              updateLastAssistant((last) => ({
                ...last,
                content: last.content + tokenContent,
                toolStatus: '',
                executionPhase: 'composing',
              }));
            },
            onToolStart: (name: string, _args: string) => {
              updateLastAssistant((last) => ({
                ...last,
                toolStatus: `正在调用 ${name}...`,
                executionPhase: 'tool',
                executionToolName: name,
              }));
              if (name === 'generate_xiaoyunque_video') {
                startVideoPolling(
                  (videoUrl: string) => {
                    updateLastAssistant((last) => ({
                      ...last,
                      content: last.content + `\n\n视频生成完成：${videoUrl}`,
                      isStreaming: false,
                    }));
                  },
                  (status: string) => {
                    updateLastAssistant((last) => ({
                      ...last,
                      toolStatus: status,
                    }));
                  },
                );
              }
            },
            onToolEnd: () => {
              updateLastAssistant((last) => ({
                ...last,
                toolStatus: '',
                executionPhase: 'summarizing',
              }));
            },
            onFileReady: (fileInfo: GeneratedFile) => {
              updateLastAssistant((last) => {
                const messageFile = { ...fileInfo, messageId: last.id, sessionId };
                const presentationSnapshot = createPresentationSnapshot(fileInfo, last.id, sessionId);
                return {
                  ...last,
                  file: messageFile,
                  files: [
                    ...(last.files ?? []).filter((item) => item.artifactId !== fileInfo.artifactId && item.downloadUrl !== fileInfo.downloadUrl),
                    messageFile,
                  ],
                  ...(presentationSnapshot ? { previewSnapshot: presentationSnapshot } : {}),
                };
              });
            },
            onProjectFileChanged: (change: ProjectChange) => {
              setProjectChanges((previous) => [
                ...previous.filter((item) => item.path !== change.path),
                change,
              ]);
              if (!change.pending) setProjectRevision((revision) => revision + 1);
              updateLastAssistant((last) => ({
                ...last,
                projectChanges: [
                  ...(last.projectChanges ?? []).filter((item) => item.path !== change.path),
                  change,
                ],
              }));
            },
            onChangeSet: (change) => {
              updateLastAssistant((last) => ({ ...last, ...bindLiveChangeSet(last, change) }));
            },
            onPreviewFileChanged: (change: PreviewFileChange & { content: string }) => {
              const store = usePreviewProjectStore.getState();
              const isSceneSpec = change.path === '/src/scene.json';
              if (stagedProject && change.projectId === stagedProject.id) {
                stagedProject = stageProjectSources(stagedProject, [change], change.revision ?? (stagedProject.revision ?? 0) + 1);
                previewFilesChanged = true;
                if (isSceneSpec) sceneToExport = validateSceneSpec(JSON.parse(stagedProject.files['/src/scene.json']));
                updateLastAssistant((last) => ({ ...last, previewChanges: [
                  ...(last.previewChanges ?? []).filter((item) => item.path !== change.path),
                  { projectId: change.projectId, path: change.path, diff: change.diff },
                ] }));
                return;
              }
              const applied = isSceneSpec
                ? store.applyAiSceneSpec(change)
                : store.applyAiFileChange(change);
              if (!applied) return;
              previewFilesChanged = true;
              if (isSceneSpec) sceneToExport = validateSceneSpec(JSON.parse(usePreviewProjectStore.getState().project.files['/src/scene.json']));
              setPreviewRevision((revision) => revision + 1);
              updateLastAssistant((last) => {
                const previewChanges = [
                  ...(last.previewChanges ?? []).filter((item) => item.path !== change.path),
                  { projectId: change.projectId, path: change.path, diff: change.diff },
                ];
                return {
                  ...last,
                  previewChanges,
                };
              });
            },
            onPreviewProjectPersisted: (change) => {
              if (stagedProject && change.projectId === stagedProject.id) {
                stagedProject = { ...stagedProject, serverRevision: change.serverRevision, persistedRevision: change.contentRevision };
                stagedProjectReady = true;
                return;
              }
              usePreviewProjectStore.getState().applyServerProjectRevision(
                change.projectId,
                change.contentRevision,
                change.serverRevision,
              );
            },
            onPreviewProjectCommitted: async (change) => {
              const paths = change.changedFiles.map((file) => file.path);
              updateLastAssistant((last) => ({
                ...last,
                previewChanges: [
                  ...(last.previewChanges ?? []).filter((item) => !change.changedFiles.some((file) => file.path === item.path)),
                  ...change.changedFiles.map((file) => ({ projectId: change.projectId, path: file.path, diff: file.diff })),
                ],
              }));
              if (paths.length === 0) return;

              if (stagedProject && change.projectId === stagedProject.id) {
                try {
                  const response = await readSessionPreviewProjectFiles(sessionId, change.projectId, paths, change.contentRevision);
                  if (response.revision !== change.contentRevision || response.serverRevision < change.serverRevision
                    || response.files.length !== paths.length || paths.some((path) => !response.files.some((file) => file.path === path))) {
                    throw new Error('新项目的完整源码尚未同步成功。');
                  }
                  stagedProject = stageProjectSources(stagedProject, response.files, response.revision, response.serverRevision);
                  stagedProjectReady = true;
                  previewFilesChanged = true;
                  if (paths.includes('/src/scene.json')) sceneToExport = validateSceneSpec(JSON.parse(stagedProject.files['/src/scene.json']));
                  return response.payloadBytes;
                } catch (error) {
                  if (error instanceof PreviewRevisionAdvancedError) {
                    const latest = await getSessionPreviewProject(sessionId);
                    if (latest?.project.id === change.projectId) {
                      stagedProject = reconcilePreviewProject({ ...latest.project, serverRevision: latest.revision,
                        persistedRevision: latest.project.revision, origin: latest.origin, uploadName: latest.uploadName }, [], true);
                      stagedProjectReady = true;
                      previewFilesChanged = true;
                      if (paths.includes('/src/scene.json')) sceneToExport = validateSceneSpec(JSON.parse(stagedProject.files['/src/scene.json']));
                      return latest.payloadBytes;
                    }
                  }
                  stagedProjectReady = false;
                  updateLastAssistant((last) => ({ ...last, content: `${last.content}\n\n新项目源码同步未完成，当前预览保持不变。请刷新后重试。` }));
                  return;
                }
              }

              const initialState = usePreviewProjectStore.getState();
              if (change.projectId !== initialState.project.id) {
                console.warn(`[PreviewSync] ignored commit for inactive project=${change.projectId}`);
                return;
              }
              if (change.contentRevision < (initialState.project.revision ?? 0)) {
                console.info(
                  `[PreviewSync] ignored stale commit revision=${change.contentRevision} local_revision=${initialState.project.revision ?? 0}`,
                );
                return;
              }

              console.info(
                `[PreviewSync] commit_revision=${change.contentRevision} changed_paths=${paths.length} fetch_started=true`,
              );
              try {
                let response;
                try {
                  response = await readSessionPreviewProjectFiles(
                    sessionId,
                    change.projectId,
                    paths,
                    change.contentRevision,
                  );
                } catch (error) {
                  if (!(error instanceof PreviewRevisionAdvancedError)) throw error;
                  const latest = await getSessionPreviewProject(sessionId);
                  if (!latest || latest.project.id !== change.projectId) {
                    throw new Error('服务器当前 Preview Project 已变化，请刷新页面后重试。');
                  }
                  const latestRevision = latest.project.revision ?? 0;
                  const latestState = usePreviewProjectStore.getState();
                  if (latestRevision < (latestState.project.revision ?? 0)) {
                    console.info(
                      `[PreviewSync] ignored recovery revision=${latestRevision} local_revision=${latestState.project.revision ?? 0}`,
                    );
                    return;
                  }
                  const selectedPath = latestState.selectedFilePath;
                  usePreviewProjectStore.getState().importProject(
                    latest.project.template,
                    latest.project.files,
                    latest.project.name,
                    latest.project.id,
                    latestRevision,
                    latest.revision,
                    latest.origin,
                    latest.uploadName,
                  );
                  const recovered = usePreviewProjectStore.getState();
                  if (paths.includes('/src/scene.json')) sceneToExport = validateSceneSpec(JSON.parse(recovered.project.files['/src/scene.json']));
                  if (selectedPath && recovered.project.files[selectedPath] !== undefined) recovered.selectFile(selectedPath);
                  const sourceBytes = Object.values(latest.project.files).reduce(
                    (total, content) => total + new TextEncoder().encode(content).byteLength,
                    0,
                  );
                  previewFilesChanged = true;
                  setPreviewRevision((revision) => revision + 1);
                  console.info(
                    `[PreviewSync] revision_advanced=true response_revision=${latestRevision} `
                    + `files_received=${Object.keys(latest.project.files).length} content_bytes=${sourceBytes} `
                    + `response_bytes=${latest.payloadBytes ?? 0} local_vfs_updated=true`,
                  );
                  return latest.payloadBytes;
                }

                const latestState = usePreviewProjectStore.getState();
                if (response.revision < (latestState.project.revision ?? 0)) {
                  console.info(
                    `[PreviewSync] ignored stale response revision=${response.revision} local_revision=${latestState.project.revision ?? 0}`,
                  );
                  return;
                }
                if (response.revision !== change.contentRevision) {
                  throw new Error(`源码响应 revision 不匹配：期望 ${change.contentRevision}，收到 ${response.revision}。`);
                }
                if (response.serverRevision < change.serverRevision) {
                  throw new Error(`源码响应 server revision 过旧：期望至少 ${change.serverRevision}，收到 ${response.serverRevision}。`);
                }
                const fetchedPaths = response.files.map((file) => file.path);
                if (paths.length !== fetchedPaths.length || paths.some((path) => !fetchedPaths.includes(path))) {
                  throw new Error('批量源码响应未包含全部变更文件。');
                }
                const applied = usePreviewProjectStore.getState().applyAiProjectCommit({
                  projectId: change.projectId,
                  changedFiles: response.files,
                  contentRevision: response.revision,
                  serverRevision: response.serverRevision,
                });
                if (!applied) {
                  const currentRevision = usePreviewProjectStore.getState().project.revision ?? 0;
                  console.info(
                    `[PreviewSync] apply_rejected response_revision=${response.revision} local_revision=${currentRevision}`,
                  );
                  if (currentRevision > response.revision) return;
                  throw new Error('源码没有应用到当前项目，请刷新页面加载服务器最新版本。');
                }
                previewFilesChanged = true;
                if (paths.includes('/src/scene.json')) sceneToExport = validateSceneSpec(JSON.parse(usePreviewProjectStore.getState().project.files['/src/scene.json']));
                setPreviewRevision((revision) => revision + 1);
                const contentBytes = response.files.reduce(
                  (total, file) => total + new TextEncoder().encode(file.content).byteLength,
                  0,
                );
                console.info(
                  `[PreviewSync] response_revision=${response.revision} files_received=${response.files.length} `
                  + `content_bytes=${contentBytes} response_bytes=${response.payloadBytes} local_vfs_updated=true`,
                );
                return response.payloadBytes;
              } catch (error) {
                console.error(
                  `[PreviewSync] fetch_failed revision=${change.contentRevision} error=${error instanceof Error ? error.message : 'unknown'}`,
                );
                updateLastAssistant((last) => ({
                  ...last,
                  content: `${last.content}\n\n⚠️ 服务器源码已更新，但当前浏览器同步失败；请刷新页面加载最新项目。`,
                }));
              }
            },
            onPreviewProjectConflict: (message) => {
              creationFailed = true;
              updateLastAssistant((last) => ({
                ...last,
                content: `${last.content}\n\n⚠️ ${message}`,
              }));
            },
            onVideoReady: (videoInfo: any) => {
              updateLastAssistant((last) => ({
                ...last,
                videoUrl: videoInfo.videoUrl,
              }));
            },
            onToolProgress: (_name: string, status: string) => {
              updateLastAssistant((last) => ({
                ...last,
                toolStatus: status,
                executionPhase: 'tool',
                executionToolName: _name,
              }));
            },
            onTokenUsage: (usage: TokenUsage) => {
              updateLastAssistant((last) => ({
                ...last,
                tokenUsage: usage,
              }));
            },
            onContextRemain: (contextInfo: ContextRemain) => {
              setContextRemain(contextInfo);
              updateLastAssistant((last) => ({
                ...last,
                contextRemain: contextInfo,
              }));
              if (contextInfo.warning) {
                alert({
                  title: '上下文空间即将耗尽',
                  description: `当前剩余上下文 token：${contextInfo.remain_token}，低于 10000。建议新建会话，否则会触发消息裁剪或者调用报错。`,
                });
              }
            },
            onModelQuotaInfo: (quotaInfo: ModelQuotaInfo) => {
              setModelQuotaInfo(quotaInfo);
              updateLastAssistant((last) => ({
                ...last,
                modelQuotaInfo: quotaInfo,
              }));
              if (quotaInfo.new_remain <= QUOTA_WARNING_THRESHOLD) {
                alert({
                  title: '模型额度即将耗尽',
                  description: `${quotaInfo.model_name} 当前剩余 token：${quotaInfo.new_remain}，低于 ${QUOTA_WARNING_THRESHOLD}。请留意充值，否则可能无法继续对话。`,
                });
              }
            },
            onSearchSources: (sources: SearchSource[], searchTrace?: SearchTrace) => {
              updateLastAssistant((last) => {
                // 合并多次搜索的结果（相同 url 去重），并保留最近一次 trace
                const merged = [...(last.searchSources ?? [])];
                for (const src of sources) {
                  if (!src.url) continue;
                  if (!merged.some((item) => item.url === src.url)) {
                    merged.push(src);
                  }
                }
                return {
                  ...last,
                  searchSources: merged,
                  searchTrace: searchTrace ?? last.searchTrace,
                };
              });
            },
            onDone: (status = 'completed') => {
              completed = status === 'completed';
              if (previewFilesChanged && !stagedProject) {
                console.info(`[PreviewSync] local_vfs_updated=true build_triggered=true`);
                usePreviewProjectStore.getState().requestBuildAndRun();
              }
              updateLastAssistant((last) => ({
                ...last,
                isStreaming: false,
                toolStatus: '',
                thinkingTrace: finishThinking(last.thinkingTrace, status),
              }));
            },
            onError: (err: Error) => {
              creationFailed = true;
              updateLastAssistant((last) => ({
                ...last,
                content: appendMessageErrorOnce(last.content, err.message, '服务异常'),
                thinkingTrace: finishThinking(last.thinkingTrace, 'failed'),
                isStreaming: false,
                toolStatus: '',
              }));
            },
          },
          controller.signal,
        );
        // SSE has now persisted the assistant message. Export the exact scene
        // received for this turn, never whichever project happens to be active.
        if (completed && !creationFailed && sceneToExport && !controller.signal.aborted) {
          try {
            const file = await saveSceneArtifact(sceneToExport, (blob, name) => {
              if (controller.signal.aborted) throw new DOMException('已取消模型导出', 'AbortError');
              return saveGeneratedGlb(sessionId, blob, name, assistantMsg.id);
            });
            setMessages((previous) => previous.map((message) => message.id === assistantMsg.id ? {
              ...message,
              file,
              files: [...(message.files ?? []).filter((item) => item.downloadUrl !== file.downloadUrl), file],
            } : message));
          } catch (error) {
            if (controller.signal.aborted) return;
            if (stagedProject) stagedProjectReady = false;
            const detail = error instanceof Error ? error.message : '模型文件保存失败';
            setMessages((previous) => previous.map((message) => message.id === assistantMsg.id ? {
              ...message, content: `${message.content}\n\nGLB 导出失败：${detail}。场景源码已保留，可重试导出。`,
            } : message));
          }
        }
        // Publish only after SSE completion, full source sync and (for 3D) GLB save.
        // A cancelled/failed request never replaces the visible project.
        if (stagedProject && previousPreviewProject && canPublishStagedProject({
          completed, ready: stagedProjectReady, changed: previewFilesChanged, aborted: controller.signal.aborted,
          failed: creationFailed, activeProjectId: usePreviewProjectStore.getState().project.id,
          previousProjectId: previousPreviewProject.id,
        })) {
          const store = usePreviewProjectStore.getState();
          store.importProject(stagedProject.template, stagedProject.files, stagedProject.name,
            stagedProject.id, stagedProject.revision, stagedProject.serverRevision, stagedProject.origin, stagedProject.uploadName);
          setPreviewRevision((revision) => revision + 1);
          store.requestBuildAndRun();
        }
      } catch (err: any) {
        if (err.name !== 'AbortError') {
          console.error('[Message] 发送消息失败:', err);
          updateLastAssistant((last) => ({
            ...last,
            content: appendMessageErrorOnce(last.content, err.message, '发送失败，请重试'),
            thinkingTrace: finishThinking(last.thinkingTrace, 'failed'),
            isStreaming: false,
            toolStatus: '',
          }));
        }
      } finally {
        setIsLoading(false);
        abortRef.current = null;
        stopVideoPolling();
      }
    },
    [
      input,
      isLoading,
      pendingImages,
      pendingUploadSummary,
      freezeFileEditMode,
      freezeThinkingMode,
      freezeChatModel,
          sessionId,
      updateLastAssistant,
      startVideoPolling,
      stopVideoPolling,
      alert,
    ],
  );

  const queueUploadSummary = useCallback((
    prompt: string,
    images?: string[],
    displayText?: string,
    analysisContext?: string,
    attachments?: UploadedAttachment[],
  ) => {
    setPendingUploadSummary((previous) => {
      if (!previous) return { prompt, images, displayText, analysisContext, attachments };
      const mergedAttachments = [...(previous.attachments ?? [])];
      for (const attachment of attachments ?? []) {
        if (!mergedAttachments.some((item) => item.name === attachment.name && item.kind === attachment.kind)) {
          mergedAttachments.push(attachment);
        }
      }
      const contexts = [previous.analysisContext, analysisContext].filter((value): value is string => Boolean(value?.trim()));
      const prompts = [previous.prompt, prompt].filter((value): value is string => Boolean(value?.trim()));
      return {
        prompt: [...new Set(prompts)].join('\n'),
        images: [...(previous.images ?? []), ...(images ?? [])],
        displayText: displayText || previous.displayText,
        analysisContext: [...new Set(contexts)].join('\n\n'),
        attachments: mergedAttachments,
      };
    });
  }, []);

  const clearPendingUploadSummary = useCallback(() => setPendingUploadSummary(null), []);

  const addGeneratedFileToLatestAssistant = useCallback((file: GeneratedFile) => {
    updateLastAssistant((last) => ({
      ...last,
      file,
      files: [...(last.files ?? []).filter((item) => item.downloadUrl !== file.downloadUrl), file],
    }));
  }, [updateLastAssistant]);

  /**
   * 停止生成
   */
  const handleStop = useCallback(() => {
    abortRef.current?.abort();
    updateLastAssistant((last) => ({
      ...last,
      isStreaming: false,
      thinkingTrace: finishThinking(last.thinkingTrace, 'cancelled'),
      toolStatus: '',
    }));
    stopVideoPolling();
  }, [stopVideoPolling, updateLastAssistant]);

  return {
    // 状态
    messages,
    fileEditMode,
    fileEditModeLoading,
    setFileEditMode,
    thinkingMode,
    thinkingModeLoading,
    setThinkingMode,
    chatModelId,
    chatModelLoading,
    setChatModel: changeChatModel,
    input,
    setInput,
    pendingImages,
    pendingUploadAttachments: pendingUploadSummary?.attachments ?? pendingImages.map((image) => ({ name: image.name, kind: 'file' as const })),
    isLoading,
    contextRemain,
    modelQuotaInfo,
    projectChanges,
    projectRevision,
    previewRevision,
    fileInputRef,
    // 方法
    handleSend,
    queueUploadSummary,
    clearPendingUploadSummary,
    addGeneratedFileToLatestAssistant,
    hasPendingUploadSummary: pendingUploadSummary !== null,
    handleStop,
    handleImageSelect,
    removePendingImage,
    triggerFileInput,
    setMessagesList,
    clearInput,
  };
}

export default useMessage;
