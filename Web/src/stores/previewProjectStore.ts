import { useSyncExternalStore } from 'react';
import { createTemplateFiles } from '../preview/templates/index.ts';
import { deleteFile, listFiles, readFile, writeFile } from '../preview/core/virtualFs.ts';
import { isEditablePreviewTextPath, normalizePreviewPath } from '../preview/core/pathUtils.ts';
import type { PreviewFiles, PreviewProject, PreviewTemplate } from '../preview/core/types.ts';
import { createSceneProjectFiles, validateSceneSpec } from '../modeling/sceneSpec.ts';
import { reconcilePreviewProject } from '../preview/core/projectSnapshot.ts';

const DEFAULT_TEMPLATE: PreviewTemplate = 'react';

function createProjectState(template: PreviewTemplate): PreviewProject {
  return {
    id: `preview-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: template === 'react' ? 'React Preview' : 'HTML Preview',
    template,
    files: createTemplateFiles(template),
    revision: 0,
  };
}

export function createBlankProjectState(template: PreviewTemplate): PreviewProject {
  return {
    id: `preview-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: template === 'react' ? 'New React Project' : 'New HTML Project',
    template,
    files: Object.create(null),
    revision: 0,
    origin: 'generated',
  };
}

function createInactiveProjectState(): PreviewProject {
  return {
    id: '',
    name: '',
    template: DEFAULT_TEMPLATE,
    files: Object.create(null),
    revision: 0,
  };
}

export interface PreviewProjectStoreState {
  project: PreviewProject;
  selectedFilePath: string | null;
  buildRunRevision: number;
  buildRunGlbRevision: number;
  createProject: (template: PreviewTemplate) => void;
  createBlankProject: (template: PreviewTemplate) => void;
  clearProject: () => void;
  selectFile: (path: string | null) => void;
  readFile: (path: string) => string | undefined;
  writeFile: (path: string, content: string) => void;
  deleteFile: (path: string) => void;
  resetProject: () => void;
  importProject: (
    template: PreviewTemplate,
    files: PreviewFiles,
    name?: string,
    projectId?: string,
    revision?: number,
    serverRevision?: number,
    origin?: PreviewProject['origin'],
    uploadName?: string | null,
  ) => void;
  getFilePaths: () => string[];
  applyAiFileChange: (change: { projectId: string; path: string; content: string; revision?: number }) => boolean;
  applyAiSceneSpec: (change: { projectId: string; content: string; revision?: number }) => boolean;
  applyAiProjectCommit: (change: {
    projectId: string;
    changedFiles: Array<{ path: string; content: string }>;
    contentRevision: number;
    serverRevision: number;
  }) => boolean;
  applyServerProjectRevision: (projectId: string, contentRevision: number, serverRevision: number) => void;
  markServerSaved: (
    projectId: string,
    contentRevision: number,
    serverRevision: number,
    origin?: PreviewProject['origin'],
    uploadName?: string | null,
  ) => void;
  requestBuildAndRun: (exportGlb?: boolean) => void;
}

type Listener = () => void;
const listeners = new Set<Listener>();

let state: PreviewProjectStoreState;

function emit(): void {
  listeners.forEach((listener) => listener());
}

function updateProject(project: PreviewProject, selectedFilePath: string | null, requestBuildAndRun = false): void {
  const sameProject = project.id === state.project.id;
  const buildRunRevision = sameProject
    ? state.buildRunRevision + (requestBuildAndRun ? 1 : 0)
    : 0;
  state = {
    ...state,
    project,
    selectedFilePath,
    buildRunRevision,
    buildRunGlbRevision: sameProject ? state.buildRunGlbRevision : 0,
  };
  emit();
}

const actions: Omit<PreviewProjectStoreState, 'project' | 'selectedFilePath' | 'buildRunRevision' | 'buildRunGlbRevision'> = {
  createProject(template) {
    const project = createProjectState(template);
    updateProject(project, listFiles(project.files)[0] ?? null);
  },
  createBlankProject(template) {
    updateProject(createBlankProjectState(template), null);
  },
  clearProject() {
    updateProject(createInactiveProjectState(), null);
  },
  selectFile(path) {
    if (path !== null && readFile(state.project.files, path) === undefined) return;
    state = { ...state, selectedFilePath: path };
    emit();
  },
  readFile(path) {
    return readFile(state.project.files, path);
  },
  writeFile(path, content) {
    const files = writeFile(state.project.files, path, content);
    const normalizedPath = normalizePreviewPath(path);
    const changed = state.project.files[normalizedPath] !== content;
    updateProject({ ...state.project, files, revision: (state.project.revision ?? 0) + (changed ? 1 : 0) }, normalizedPath);
  },
  deleteFile(path) {
    const files = deleteFile(state.project.files, path);
    const paths = listFiles(files);
    const selectedFilePath = state.selectedFilePath && readFile(files, state.selectedFilePath) !== undefined
      ? state.selectedFilePath
      : paths[0] ?? null;
    const changed = readFile(state.project.files, path) !== undefined;
    updateProject({ ...state.project, files, revision: (state.project.revision ?? 0) + (changed ? 1 : 0) }, selectedFilePath);
  },
  resetProject() {
    const files = createTemplateFiles(state.project.template);
    const changed = JSON.stringify(files) !== JSON.stringify(state.project.files);
    updateProject({ ...state.project, files, revision: (state.project.revision ?? 0) + (changed ? 1 : 0) }, listFiles(files)[0] ?? null);
  },
  importProject(template, files, name, projectId, revision, serverRevision, origin, uploadName) {
    const normalizedFiles: PreviewFiles = Object.create(null);
    for (const [path, content] of Object.entries(files)) {
      const normalizedPath = normalizePreviewPath(path);
      if (normalizedPath !== path || typeof content !== 'string') throw new Error(`无效的源码文件：${path}`);
      normalizedFiles[path] = content;
    }
    // The compact server snapshot may contain only SceneSpec. Rebuild the
    // deterministic viewer on both refresh and recovery, before entry validation.
    const restored = reconcilePreviewProject({ id: projectId ?? '', name: name ?? '', template, files: normalizedFiles }, [], true);
    Object.assign(normalizedFiles, restored.files);
    template = restored.template;
    name = restored.name;
    if (!normalizedFiles['/index.html']) throw new Error('源码 ZIP 缺少 /index.html。');
    if (Object.keys(normalizedFiles).length > 100) throw new Error('源码 ZIP 文件过多。');
    const totalBytes = Object.values(normalizedFiles).reduce((total, content) => total + new TextEncoder().encode(content).byteLength, 0);
    if (totalBytes > 5_000_000) throw new Error('源码 ZIP 超过 5 MB。');
    const project: PreviewProject = {
      id: projectId?.trim() || `preview-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name: name?.trim().slice(0, 80) || (template === 'react' ? 'Imported React Project' : 'Imported HTML Project'),
      template,
      files: normalizedFiles,
      revision: typeof revision === 'number' && Number.isSafeInteger(revision) && revision >= 0 ? revision : 0,
      ...(typeof serverRevision === 'number' ? { serverRevision, persistedRevision: typeof revision === 'number' ? revision : 0 } : {}),
      ...(origin ? { origin } : {}),
      ...(uploadName !== undefined ? { uploadName } : {}),
    };
    updateProject(project, normalizedFiles['/src/scene.json'] !== undefined
      ? '/src/scene.json'
      : listFiles(normalizedFiles)[0] ?? null);
  },
  getFilePaths() {
    return listFiles(state.project.files);
  },
  applyAiFileChange(change) {
    if (change.projectId !== state.project.id || typeof change.content !== 'string' || new TextEncoder().encode(change.content).length > 100_000) return false;
    let path: string;
    try { path = normalizePreviewPath(change.path); } catch { return false; }
    if (!isEditablePreviewTextPath(path)) return false;
    const currentRevision = state.project.revision ?? 0;
    if (change.revision !== undefined && change.revision !== currentRevision + 1) return false;
    if (!Object.prototype.hasOwnProperty.call(state.project.files, path) && Object.keys(state.project.files).length >= 40) return false;
    const files = writeFile(state.project.files, path, change.content);
    if (Object.values(files).reduce((total, value) => total + new TextEncoder().encode(value).length, 0) > 500_000) return false;
    updateProject({ ...state.project, files, revision: change.revision ?? currentRevision + 1 }, path);
    return true;
  },
  applyAiSceneSpec(change) {
    if (change.projectId !== state.project.id || typeof change.content !== 'string' || new TextEncoder().encode(change.content).byteLength > 100_000) return false;
    const currentRevision = state.project.revision ?? 0;
    if (change.revision !== undefined && change.revision !== currentRevision + 1) return false;
    try {
      const scene = validateSceneSpec(JSON.parse(change.content));
      const files = { ...state.project.files, ...createSceneProjectFiles(scene) };
      if (Object.keys(files).length > 40 || Object.values(files).some((content) => new TextEncoder().encode(content).byteLength > 100_000)) return false;
      if (Object.values(files).reduce((total, content) => total + new TextEncoder().encode(content).byteLength, 0) > 500_000) return false;
      updateProject({ ...state.project, name: scene.name, template: 'html', files, revision: change.revision ?? currentRevision + 1 }, '/src/scene.json');
      return true;
    } catch {
      return false;
    }
  },
  applyAiProjectCommit(change) {
    if (change.projectId !== state.project.id || !Array.isArray(change.changedFiles)) return false;
    const currentRevision = state.project.revision ?? 0;
    if (!Number.isSafeInteger(change.contentRevision) || change.contentRevision < currentRevision) return false;
    if (!Number.isSafeInteger(change.serverRevision) || change.serverRevision < (state.project.serverRevision ?? -1)) return false;
    let files = state.project.files;
    let reconciled: PreviewProject;
    try {
      for (const changed of change.changedFiles) {
        if (typeof changed.path !== 'string' || typeof changed.content !== 'string') return false;
        const path = normalizePreviewPath(changed.path);
        if (!isEditablePreviewTextPath(path) || new TextEncoder().encode(changed.content).byteLength > 100_000) return false;
        files = writeFile(files, path, changed.content);
      }
      reconciled = reconcilePreviewProject({ ...state.project, files }, change.changedFiles.map((changed) => changed.path));
      files = reconciled.files;
      if (Object.keys(files).length > 100 || Object.values(files).some((content) => new TextEncoder().encode(content).byteLength > 100_000)) return false;
      if (Object.values(files).reduce((total, content) => total + new TextEncoder().encode(content).byteLength, 0) > 5_000_000) return false;
    } catch {
      return false;
    }
    const lastChangedPath = change.changedFiles.length > 0
      ? change.changedFiles[change.changedFiles.length - 1].path
      : state.selectedFilePath;
    const sourceChanged = change.changedFiles.some((changed) => state.project.files[changed.path] !== changed.content);
    updateProject({
      ...state.project,
      files,
      name: reconciled.name,
      template: reconciled.template,
      revision: change.contentRevision,
      persistedRevision: change.contentRevision,
      serverRevision: change.serverRevision,
    }, lastChangedPath, sourceChanged);
    return true;
  },
  applyServerProjectRevision(projectId, contentRevision, serverRevision) {
    if (projectId !== state.project.id) return;
    if (serverRevision < (state.project.serverRevision ?? -1)) return;
    if (contentRevision < (state.project.persistedRevision ?? -1)) return;
    updateProject({
      ...state.project,
      serverRevision,
      persistedRevision: contentRevision,
    }, state.selectedFilePath);
  },
  markServerSaved(projectId, contentRevision, serverRevision, origin, uploadName) {
    if (projectId !== state.project.id) return;
    if (contentRevision < (state.project.persistedRevision ?? -1)) return;
    if (serverRevision < (state.project.serverRevision ?? -1)) return;
    updateProject({
      ...state.project,
      serverRevision,
      persistedRevision: Math.max(state.project.persistedRevision ?? -1, contentRevision),
      ...(origin ? { origin } : {}),
      ...(uploadName !== undefined ? { uploadName } : {}),
    }, state.selectedFilePath);
  },
  requestBuildAndRun(exportGlb = false) {
    const buildRunRevision = state.buildRunRevision + 1;
    state = {
      ...state,
      buildRunRevision,
      buildRunGlbRevision: exportGlb ? buildRunRevision : state.buildRunGlbRevision,
    };
    emit();
  },
};

state = {
  project: createInactiveProjectState(),
  selectedFilePath: null,
  buildRunRevision: 0,
  buildRunGlbRevision: 0,
  ...actions,
};

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

interface PreviewProjectStoreHook {
  (): PreviewProjectStoreState;
  getState: () => PreviewProjectStoreState;
  subscribe: (listener: Listener) => () => void;
}

export const usePreviewProjectStore = Object.assign(
  () => useSyncExternalStore(subscribe, () => state, () => state),
  { getState: () => state, subscribe },
) as PreviewProjectStoreHook;
