import type { PreviewProject } from '../preview/core/types';

export type ProjectRef = { project_id: string; provider: 'preview' | 'vscode'; root: string | null };
export type ChangeSet = { id: string; sessionId: string; roundId: string; projectRef: ProjectRef;
  previewNewProject?: boolean; previewParentProjectId?: string | null;
  sealed: boolean; files: Array<{ id: string; path: string; status: string }> };
export type UndoResult = { success: boolean; changeSetId: string; code?: string;
  results: Array<{ fileId: string; path: string; success: boolean; code?: string; changed?: boolean }>;
  previewProject?: PreviewProject; serverRevision?: number; previewSynced?: boolean };
type Host = { mode: 'vscode' } | { mode: 'web'; preview: {
  current: () => PreviewProject;
  restore: (project: PreviewProject, serverRevision: number, newProject?: boolean) => void;
} };

/** Explicit host adapter for confirmation and undo; UI wording remains host-owned. */
export function createProjectChangeClient(sessionId: string, host: Host) {
  const base = `/api/chat/session/${encodeURIComponent(sessionId)}/change-sets/`;
  async function request<T>(path: string, method = 'GET'): Promise<T> {
    const response = await fetch(base + path, { method });
    const data = await response.json();
    if (!response.ok) throw new Error(data.detail?.message || data.detail || data.error || '文件变更请求失败。');
    return data;
  }
  async function getChangeSet(id: string): Promise<ChangeSet> {
    const record = await request<ChangeSet>(encodeURIComponent(id));
    if (record.sessionId !== sessionId || record.projectRef.provider !== (host.mode === 'web' ? 'preview' : 'vscode')) {
      throw new Error('变更记录不属于当前会话或宿主。');
    }
    return record;
  }
  async function mutate(id: string, fileId?: string, action: 'undo' | 'apply' = 'undo'): Promise<UndoResult> {
    const record = await getChangeSet(id);
    const state = host.mode === 'web' ? host.preview.current() : null;
    const previous = state ? { ...state, files: { ...state.files } } : null;
    const newProject = record.previewNewProject && previous?.id !== record.projectRef.project_id;
    if (previous && ((previous.id !== record.projectRef.project_id
      && !(newProject && previous.id === (record.previewParentProjectId ?? '')))
      || (previous.id && previous.revision !== previous.persistedRevision))) {
      throw new Error('当前虚拟项目不匹配或有未保存改动，请先保存并同步。');
    }
    const result = await request<UndoResult>(`${encodeURIComponent(id)}/${fileId
      ? `files/${encodeURIComponent(fileId)}/${action}` : action}`, 'POST');
    if (host.mode === 'web' && result.previewProject && result.serverRevision !== undefined && previous) {
      const current = host.preview.current();
      // An in-flight request must not replace a newly selected project or local edits.
      const unchanged = current.id === previous.id && current.revision === previous.revision
        && JSON.stringify(current.files) === JSON.stringify(previous.files)
        && (current.serverRevision ?? -1) <= result.serverRevision;
      result.previewSynced = unchanged && (result.previewProject.id === previous.id
        || Boolean(newProject && result.previewProject.id === record.projectRef.project_id));
      if (result.previewSynced) host.preview.restore(result.previewProject, result.serverRevision, Boolean(newProject));
    }
    return result;
  }
  return { getChangeSet, undoFile: (id: string, fileId: string) => mutate(id, fileId),
    undoChangeSet: (id: string) => mutate(id),
    applyFile: (id: string, fileId: string) => mutate(id, fileId, 'apply'),
    applyChangeSet: (id: string) => mutate(id, undefined, 'apply') };
}
