import type { PreviewProject } from './types.ts';
import { writeFile } from './virtualFs.ts';
import { reconcilePreviewProject } from './projectSnapshot.ts';

/** Completion alone is insufficient: sync, artifacts and the active session must agree. */
export function canPublishStagedProject(state: {
  completed: boolean;
  ready: boolean;
  changed: boolean;
  aborted: boolean;
  failed: boolean;
  activeProjectId: string;
  previousProjectId: string;
}): boolean {
  return state.completed && state.ready && state.changed && !state.aborted && !state.failed
    && state.activeProjectId === state.previousProjectId;
}

/** Build a new project off-screen. No subscriber or active preview is changed. */
export function stageProjectSources(project: PreviewProject, files: Array<{ path: string; content: string }>, revision: number, serverRevision?: number): PreviewProject {
  if (revision < (project.revision ?? 0)) throw new Error('新项目源码版本已过期。');
  let staged = project.files;
  for (const file of files) staged = writeFile(staged, file.path, file.content);
  return reconcilePreviewProject({ ...project, files: staged, revision,
    ...(serverRevision !== undefined ? { serverRevision, persistedRevision: revision } : {}),
  }, files.map((file) => file.path));
}
