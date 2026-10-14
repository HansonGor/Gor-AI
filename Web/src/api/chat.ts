// SSE 聊天 API 封装
import { parseSSEStream } from '../utils/sse';
import type { ThinkingEvent, ThinkingStatus } from '../utils/thinking';
import config from '../config';
import { getChatClientMode, projectClientContext } from '../utils/clientMode';
import type { Session, TokenUsage, ModelQuotaInfo, ProjectChange, UploadedAttachment, SearchSource, SearchTrace } from '../types';
import type { PreviewProject } from '../preview/core/types.ts';

interface SendChatMessageParams {
  editMode?: 'auto' | 'review';
  sessionId: string;
  message: string;
  messages?: Array<{ role: string; content: string; images?: string[]; attachments?: UploadedAttachment[] }>;
  attachments?: UploadedAttachment[];
  analysisContext?: string;
  analysisContextMode?: 'summary' | 'reference';
  previewProjectId?: string;
  previewServerRevision?: number;
  previewContentRevision?: number;
  previewProjectBootstrap?: PreviewProject;
  previewProjectOrigin?: 'generated' | 'uploaded-source';
  previewProjectUploadName?: string | null;
  assistantMessageId?: string;
  newPreviewProject?: boolean;
}

interface SendChatMessageCallbacks {
  onThinking?: (event: ThinkingEvent) => void;
  onToken?: (content: string) => void;
  onToolStart?: (name: string, args: string) => void;
  onToolEnd?: (name: string, result: string) => void;
  onFileReady?: (fileInfo: any) => void;
  onVideoReady?: (videoInfo: any) => void;
  onToolProgress?: (name: string, status: string) => void;
  onTokenUsage?: (usage: TokenUsage) => void;
  onContextRemain?: (contextInfo: any) => void;
  onModelQuotaInfo?: (quotaInfo: ModelQuotaInfo) => void;
  onProjectFileChanged?: (change: ProjectChange) => void;
  onPreviewFileChanged?: (change: { projectId: string; path: string; content: string; diff: string; revision?: number }) => void;
  onChangeSet?: (change: { id: string; sessionId: string; provider: 'preview' | 'vscode' }) => void;
  onPreviewProjectPersisted?: (change: { projectId: string; contentRevision: number; serverRevision: number }) => void;
  onPreviewProjectCommitted?: (change: {
    projectId: string;
    contentRevision: number;
    serverRevision: number;
    changedFiles: Array<{ path: string; diff: string; hash?: string }>;
  }) => void | number | Promise<void | number>;
  onPreviewProjectConflict?: (message: string) => void;
  onSearchSources?: (sources: SearchSource[], searchTrace?: SearchTrace) => void;
  onDone?: (status?: ThinkingStatus) => void;
  onError?: (error: Error) => void;
}

/**
 * 创建新会话
 */
export async function createSession(userId = 'default', sessionId?: string): Promise<Session> {
  const response = await fetch('/api/chat/session/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId, ...(sessionId ? { sessionId } : {}) }),
  });
  const data = await response.json();
  if (!data.success) {
    throw new Error(data.error || '创建会话失败');
  }
  return data.session;
}

/**
 * 获取会话历史消息
 */
export async function getSessionMessages(sessionId: string): Promise<any[]> {
  const response = await fetch(`/api/chat/session/${sessionId}/messages`);
  const data = await response.json();
  if (!data.success) {
    throw new Error(data.error || '获取消息失败');
  }
  return data.messages;
}

export async function uploadSessionAttachment(
  sessionId: string,
  file: File | Blob,
  name: string,
  kind: NonNullable<UploadedAttachment['kind']>,
): Promise<UploadedAttachment> {
  const form = new FormData();
  form.append('file', file, name);
  form.append('name', name);
  form.append('kind', kind);
  const response = await fetch(`/api/chat/session/${encodeURIComponent(sessionId)}/attachments`, {
    method: 'POST',
    body: form,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.success || !data.attachment) {
    throw new Error(data.detail || data.error || '附件保存失败，请重试。');
  }
  return data.attachment as UploadedAttachment;
}

export async function deletePendingSessionAttachment(sessionId: string, attachmentId: string): Promise<void> {
  const response = await fetch(
    `/api/chat/session/${encodeURIComponent(sessionId)}/attachments/${encodeURIComponent(attachmentId)}`,
    { method: 'DELETE' },
  );
  if (!response.ok) throw new Error('暂存附件未能从服务器清理。');
}

/**
 * 获取会话列表
 */
export async function getSessions(userId = 'default'): Promise<Session[]> {
  const response = await fetch(`/api/chat/sessions?userId=${encodeURIComponent(userId)}`);
  const data = await response.json();
  if (!data.success) {
    throw new Error(data.error || '获取会话列表失败');
  }
  return data.sessions;
}

/**
 * 删除会话
 */
export async function deleteSession(sessionId: string): Promise<void> {
  const response = await fetch(`/api/chat/session/${sessionId}`, {
    method: 'DELETE',
  });
  const data = await response.json();
  if (!data.success) {
    throw new Error(data.error || '删除会话失败');
  }
}

/**
 * 查询所有视频生成任务列表
 */
export async function getVideoTasks(): Promise<any[]> {
  try {
    const response = await fetch('/api/video/tasks');
    const data = await response.json();
    return data.success ? data.tasks : [];
  } catch (err) {
    console.error('查询视频任务失败:', err);
    return [];
  }
}

/**
 * 发送聊天消息，通过 SSE 流式接收响应
 */
export async function sendChatMessage(
  params: SendChatMessageParams | any[],
  callbacks: SendChatMessageCallbacks = {},
  signal?: AbortSignal
): Promise<void> {
  const { onToken, onToolStart, onToolEnd, onFileReady, onVideoReady, onToolProgress, onTokenUsage, onContextRemain, onModelQuotaInfo, onProjectFileChanged, onPreviewFileChanged, onChangeSet, onSearchSources, onDone, onError } = callbacks;
  let previewCommitPayloadBytes = 0;
  let previewSyncFetchBytes = 0;

  // 兼容旧版调用方式：sendChatMessage(messages, callbacks, signal)
  let sessionId: string | undefined;
  let message: string | undefined;
  let messages: any[] | undefined;
  let attachments: UploadedAttachment[] | undefined;
  let analysisContext: string | undefined;
  let analysisContextMode: 'summary' | 'reference' | undefined;
  let previewProjectId: string | undefined;
  let previewServerRevision: number | undefined;
  let previewContentRevision: number | undefined;
  let previewProjectBootstrap: PreviewProject | undefined;
  let previewProjectOrigin: 'generated' | 'uploaded-source' | undefined;
  let previewProjectUploadName: string | null | undefined;
  let assistantMessageId: string | undefined;
  let newPreviewProject: boolean | undefined;
  let editMode: 'auto' | 'review' | undefined;
  if (Array.isArray(params)) {
    messages = params;
  } else {
    sessionId = params.sessionId;
    message = params.message;
    messages = params.messages;
    attachments = params.attachments;
    analysisContext = params.analysisContext;
    analysisContextMode = params.analysisContextMode;
    previewProjectId = params.previewProjectId;
    previewServerRevision = params.previewServerRevision;
    previewContentRevision = params.previewContentRevision;
    previewProjectBootstrap = params.previewProjectBootstrap;
    previewProjectOrigin = params.previewProjectOrigin;
    previewProjectUploadName = params.previewProjectUploadName;
    assistantMessageId = params.assistantMessageId;
    newPreviewProject = params.newPreviewProject;
    editMode = params.editMode;
  }

  try {
    const clientMode = getChatClientMode();
    const vscodeMode = clientMode === 'vscode';
    const vscodeWorkspaceId = document.documentElement.dataset.gorWorkspaceId;
    const response = await fetch(config.api.chatEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify({
        sessionId, message, messages, attachments, analysisContext, analysisContextMode,
        assistantMessageId, editMode,
        ...(!vscodeMode ? { previewProjectId, previewServerRevision, previewContentRevision,
          previewProjectBootstrap, previewProjectOrigin, previewProjectUploadName, newPreviewProject } : {}),
        ...projectClientContext(clientMode, vscodeWorkspaceId),
      }),
      signal,
    });

    if (!response.ok) {
      throw new Error(`请求失败 (${response.status})`);
    }

    if (!response.body) {
      throw new Error('浏览器不支持流式读取');
    }

    for await (const event of parseSSEStream(response.body)) {
      switch (event.type) {
        case 'thinking_start':
        case 'thinking_delta':
        case 'thinking_end':
        case 'thinking_update':
        case 'thinking_title':
        case 'thinking_summary_delta':
          if (typeof event.roundId === 'string') callbacks.onThinking?.(event as ThinkingEvent);
          break;
        case 'token':
          onToken?.(event.content || '');
          break;
        case 'tool_start':
          onToolStart?.(event.name || '', event.args || '');
          break;
        case 'tool_end':
          onToolEnd?.(event.name || '', event.result || '');
          break;
        case 'file_ready':
          onFileReady?.({
            fileType: event.fileType || '',
            displayName: event.displayName || '',
            downloadUrl: event.downloadUrl || '',
            artifactId: event.artifactId,
            projectId: event.projectId,
            snapshotId: event.snapshotId,
            extension: event.extension,
            mimeType: event.mimeType,
            previewRenderer: event.previewRenderer,
            editableSource: event.editableSource,
            presentationSchema: event.presentationSchema,
            presentationBackgrounds: event.presentationBackgrounds,
            renderedSlides: event.renderedSlides,
            antiAIPatternReport: event.antiAIPatternReport,
            designCritique: event.designCritique,
            sourceFiles: event.sourceFiles,
            storyOutline: event.storyOutline,
            visualQA: event.visualQA,
          });
          break;
        case 'project_file_changed':
          if (typeof event.path === 'string' && typeof event.diff === 'string') {
            onProjectFileChanged?.({ path: event.path, diff: event.diff, ...(event.pending ? { pending: true } : {}) });
          }
          break;
        case 'preview_file_changed':
          if (typeof event.projectId === 'string' && typeof event.path === 'string' && typeof event.content === 'string' && typeof event.diff === 'string') {
            onPreviewFileChanged?.({ projectId: event.projectId, path: event.path, content: event.content, diff: event.diff, revision: event.revision });
          }
          break;
        case 'change_set':
          if (typeof event.changeSetId === 'string' && event.projectRef
            && (event.projectRef.provider === 'preview' || event.projectRef.provider === 'vscode')) {
            onChangeSet?.({ id: event.changeSetId, sessionId: sessionId || '', provider: event.projectRef.provider });
          }
          break;
        case 'preview_project_persisted':
          if (typeof event.projectId === 'string' && Number.isSafeInteger(event.contentRevision) && Number.isSafeInteger(event.serverRevision)) {
            callbacks.onPreviewProjectPersisted?.({
              projectId: event.projectId,
              contentRevision: event.contentRevision,
              serverRevision: event.serverRevision,
            });
          }
          break;
        case 'preview_project_committed':
          if (
            typeof event.projectId === 'string'
            && Number.isSafeInteger(event.contentRevision)
            && Number.isSafeInteger(event.serverRevision)
            && Array.isArray(event.changedFiles)
          ) {
            previewCommitPayloadBytes += new TextEncoder().encode(JSON.stringify(event)).byteLength;
            const syncBytes = await callbacks.onPreviewProjectCommitted?.({
              projectId: event.projectId,
              contentRevision: event.contentRevision,
              serverRevision: event.serverRevision,
              changedFiles: event.changedFiles.filter((item: any) =>
                item && typeof item.path === 'string' && typeof item.diff === 'string'
                  && (item.hash === undefined || typeof item.hash === 'string'),
              ),
            });
            if (typeof syncBytes === 'number' && Number.isFinite(syncBytes) && syncBytes > 0) {
              previewSyncFetchBytes += syncBytes;
            }
          }
          break;
        case 'preview_project_conflict':
          callbacks.onPreviewProjectConflict?.(event.message || 'Preview 项目版本冲突，请刷新后重试。');
          break;
        case 'video_ready':
          onVideoReady?.({
            taskId: event.taskId || '',
            videoUrl: event.videoUrl || '',
          });
          break;
        case 'tool_progress':
          onToolProgress?.(event.name || '', event.status || '');
          break;
        case 'token_usage':
          onTokenUsage?.({
            prompt_tokens: event.prompt_tokens || 0,
            completion_tokens: event.completion_tokens || 0,
            total_tokens: event.total_tokens || 0,
            llm_call_count: event.llm_call_count || 0,
            last_prompt_tokens: event.last_prompt_tokens || 0,
            calls: Array.isArray(event.calls) ? event.calls : [],
            execution_llm_calls: event.execution_llm_calls || 0,
            final_response_llm_calls: event.final_response_llm_calls || 0,
            preview_tool_calls: event.preview_tool_calls || 0,
            search_calls: event.search_calls || 0,
            search_queries: Array.isArray(event.search_queries) ? event.search_queries : [],
            read_calls: event.read_calls || 0,
            range_read_chars: event.range_read_chars || 0,
            full_preview_file_chars: event.full_preview_file_chars || 0,
            read_reason: Array.isArray(event.read_reason) ? event.read_reason : [],
            patch_calls: event.patch_calls || 0,
            batch_patch_calls: event.batch_patch_calls || 0,
            patch_operations: event.patch_operations || 0,
            preview_commit_payload_bytes: event.preview_commit_payload_bytes || previewCommitPayloadBytes,
            preview_sync_fetch_bytes: previewSyncFetchBytes,
          });
          break;
        case 'context_remain':
          onContextRemain?.({
            prompt_tokens: event.prompt_tokens || 0,
            max_context: event.max_context || 0,
            remain_token: event.remain_token || 0,
            warning: event.warning || false,
          });
          break;
        case 'model_quota_info':
          onModelQuotaInfo?.({
            model_name: event.model_name || '',
            old_remain: event.old_remain || 0,
            cost_total: event.cost_total || 0,
            new_remain: event.new_remain || 0,
          });
          break;
        case 'search_sources':
          if (Array.isArray(event.sources)) {
            onSearchSources?.(event.sources as SearchSource[], event.searchTrace as SearchTrace | undefined);
          }
          break;
        case 'done':
          onDone?.(event.status === 'cancelled' ? 'cancelled' : 'completed');
          return;
        case 'error':
          throw new Error(event.message || '服务端错误');
        default:
          break;
      }
    }
    if (!signal?.aborted) throw new Error('响应连接中断，未收到执行结束状态');
  } catch (err) {
    const error = err as Error;
    if (error.name === 'AbortError') {
      // 用户主动停止，不视为错误
      return;
    }
    onError?.(error);
    throw error;
  }
}

export default sendChatMessage;
