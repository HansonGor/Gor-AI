// SSE 聊天 API 封装
import { parseSSEStream } from '../utils/sse';
import config from '../config';
import type { Session, TokenUsage, ModelQuotaInfo, ProjectChange } from '../types';
import type { PreviewProject } from '../preview/core/types.ts';

interface SendChatMessageParams {
  sessionId: string;
  message: string;
  messages?: Array<{ role: string; content: string; images?: string[] }>;
  previewProject?: PreviewProject;
}

interface SendChatMessageCallbacks {
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
  onPreviewFileChanged?: (change: { projectId: string; path: string; content: string; diff: string }) => void;
  onDone?: () => void;
  onError?: (error: Error) => void;
}

/**
 * 创建新会话
 */
export async function createSession(userId = 'default'): Promise<Session> {
  const response = await fetch('/api/chat/session/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId }),
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
  const { onToken, onToolStart, onToolEnd, onFileReady, onVideoReady, onToolProgress, onTokenUsage, onContextRemain, onModelQuotaInfo, onProjectFileChanged, onPreviewFileChanged, onDone, onError } = callbacks;

  // 兼容旧版调用方式：sendChatMessage(messages, callbacks, signal)
  let sessionId: string | undefined;
  let message: string | undefined;
  let messages: any[] | undefined;
  let previewProject: PreviewProject | undefined;
  if (Array.isArray(params)) {
    messages = params;
  } else {
    sessionId = params.sessionId;
    message = params.message;
    messages = params.messages;
    previewProject = params.previewProject;
  }

  try {
    const response = await fetch(config.api.chatEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify({ sessionId, message, messages, previewProject }),
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
          });
          break;
        case 'project_file_changed':
          if (typeof event.path === 'string' && typeof event.diff === 'string') {
            onProjectFileChanged?.({ path: event.path, diff: event.diff });
          }
          break;
        case 'preview_file_changed':
          if (typeof event.projectId === 'string' && typeof event.path === 'string' && typeof event.content === 'string' && typeof event.diff === 'string') {
            onPreviewFileChanged?.({ projectId: event.projectId, path: event.path, content: event.content, diff: event.diff });
          }
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
        case 'done':
          onDone?.();
          return;
        case 'error':
          throw new Error(event.message || '服务端错误');
        default:
          break;
      }
    }
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
