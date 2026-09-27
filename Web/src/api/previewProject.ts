import type { PreviewProject, PreviewTemplate } from '../preview/core/types';

export interface SessionPreviewProjectSnapshot {
  project: PreviewProject;
  origin: 'generated' | 'uploaded-source';
  uploadName: string | null;
  revision: number;
  updatedAt: string;
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
  const data = await readResponse(response);
  if (!data.snapshot) return null;
  return data.snapshot as SessionPreviewProjectSnapshot;
}

export async function saveSessionPreviewProject(
  sessionId: string,
  project: PreviewProject,
  origin: SessionPreviewProjectSnapshot['origin'],
  uploadName: string | null,
): Promise<void> {
  const response = await fetch(`/api/chat/session/${encodeURIComponent(sessionId)}/preview-project`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project, origin, uploadName }),
  });
  await readResponse(response);
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
