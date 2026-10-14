import { createProjectChangeClient, type UndoResult } from './projectChanges.ts';
import { usePreviewProjectStore } from '../stores/previewProjectStore.ts';

/** Web-only VFS synchronization; never imported or mounted by the VS Code adapter. */
export function createWebProjectChangeClient(sessionId: string) {
  const client = createProjectChangeClient(sessionId, { mode: 'web', preview: {
    current: () => usePreviewProjectStore.getState().project,
    restore(project, serverRevision, newProject) {
      if (newProject) {
        const store = usePreviewProjectStore.getState();
        store.importProject(project.template, project.files, project.name, project.id, project.revision,
          serverRevision, project.origin, project.uploadName);
        store.requestBuildAndRun();
        return;
      }
      if (!usePreviewProjectStore.getState().applyUndoProject(project, serverRevision)) {
        throw new Error('撤销已保存，但当前预览状态已变化；请重新同步项目。');
      }
    },
  } });
  const publish = (id: string, result: UndoResult) => {
    if (result.success && result.previewSynced && result.previewProject && typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('gor:review-project-confirmed', { detail: {
        sessionId, changeSetId: id, project: result.previewProject,
      } }));
    }
    return result;
  };
  return { ...client,
    applyFile: async (id: string, fileId: string) => publish(id, await client.applyFile(id, fileId)),
    applyChangeSet: async (id: string) => publish(id, await client.applyChangeSet(id)),
  };
}
