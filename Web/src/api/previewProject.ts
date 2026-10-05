import type { PreviewProject, PreviewTemplate } from '../preview/core/types';

export interface SessionPreviewProjectSnapshot {
  project: PreviewProject;
  origin: 'generated' | 'uploaded-source';
  uploadName: string | null;
  revision: number;
  updatedAt: string;
  payloadBytes?: number;
}

export interface SessionPreviewProjectFilesResponse {
  projectId: string;
  revision: number;
  serverRevision: number;
  files: Array<{ path: string; content: string }>;
  payloadBytes: number;
}

export class PreviewRevisionAdvancedError extends Error {
  readonly currentRevision: number;

  constructor(currentRevision: number) {
    super('服务器 Preview Project 已更新到较新的 revision。');
    this.name = 'PreviewRevisionAdvancedError';
    this.currentRevision = currentRevision;
  }
}

async function readResponse(response: Response): Promise<any> {
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.success === false) {
    throw new Error(data.detail || data.error || 'Preview 项目保存失败');
  }
  return data;
}

export async function getSessionPreviewProject(sessionId: string): Promise<SessionPreviewProjectSnapshot | null> {
  const response = await fetch(`/api/chat/session/${encodeURIComponent(sessionId)}/preview-project`);
  const raw = await response.text();
  const payloadBytes = new TextEncoder().encode(raw).byteLength;
  let data: any = {};
  try { data = raw ? JSON.parse(raw) : {}; } catch { /* surface the normal API error below */ }
  if (!response.ok || data.success === false) {
    throw new Error(data.detail || data.error || 'Preview 项目读取失败');
  }
  if (!data.snapshot) return null;
  return { ...data.snapshot, payloadBytes } as SessionPreviewProjectSnapshot;
}

export async function readSessionPreviewProjectFiles(
  sessionId: string,
  projectId: string,
  paths: string[],
  expectedRevision: number,
): Promise<SessionPreviewProjectFilesResponse> {
  const response = await fetch(`/api/chat/session/${encodeURIComponent(sessionId)}/preview-project/files/read`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      projectId,
      paths: [...new Set(paths)],
      expectedRevision,
    }),
  });
  const raw = await response.text();
  const payloadBytes = new TextEncoder().encode(raw).byteLength;
  let data: any = {};
  try { data = raw ? JSON.parse(raw) : {}; } catch { /* surface the normal API error below */ }
  if (response.status === 409 && data.code === 'PREVIEW_REVISION_ADVANCED') {
    throw new PreviewRevisionAdvancedError(Number(data.currentRevision));
  }
  if (!response.ok || data.success !== true) {
    throw new Error(data.detail || data.error || data.code || 'Preview 源码同步失败。');
  }
  if (
    data.projectId !== projectId
    || !Number.isSafeInteger(data.revision)
    || !Number.isSafeInteger(data.serverRevision)
    || !Array.isArray(data.files)
  ) {
    throw new Error('Preview 源码同步响应格式无效。');
  }
  return { ...data, payloadBytes } as SessionPreviewProjectFilesResponse;
}

export async function saveSessionPreviewProject(
    sessionId: string,
    project: PreviewProject,
    origin: SessionPreviewProjectSnapshot['origin'],
    uploadName: string | null,
    expectedRevision?: number,
): Promise<{ revision: number; updatedAt: string }> {
  const response = await fetch(`/api/chat/session/${encodeURIComponent(sessionId)}/preview-project`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project, origin, uploadName, expectedRevision }),
  });
  if (response.status === 409 && expectedRevision !== undefined) {
    const latest = await getSessionPreviewProject(sessionId).catch(() => null);
    const latestFiles = latest?.project.files;
    const projectPaths = Object.keys(project.files).sort();
    const latestPaths = Object.keys(latestFiles ?? {}).sort();
    const sameFiles = projectPaths.length === latestPaths.length
      && projectPaths.every((path, index) => path === latestPaths[index] && project.files[path] === latestFiles?.[path]);
    if (
      latest
      && latest.project.id === project.id
      && latest.project.revision === project.revision
      && sameFiles
    ) {
      // Another pending save already stored these exact source bytes.
      return { revision: latest.revision, updatedAt: latest.updatedAt };
    }
  }
  const data = await readResponse(response);
  return { revision: data.revision as number, updatedAt: data.updatedAt as string };
}

export async function deleteSessionPreviewProject(sessionId: string): Promise<void> {
  const response = await fetch(`/api/chat/session/${encodeURIComponent(sessionId)}/preview-project`, {
    method: 'DELETE',
  });
  await readResponse(response);
}

export function isPreviewTemplate(value: unknown): value is PreviewTemplate {
  return value === 'html' || value === 'react';
}
