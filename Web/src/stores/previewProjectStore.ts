import { useSyncExternalStore } from 'react';
import { createTemplateFiles } from '../preview/templates/index.ts';
import { deleteFile, listFiles, readFile, writeFile } from '../preview/core/virtualFs.ts';
import { normalizePreviewPath } from '../preview/core/pathUtils.ts';
import type { PreviewFiles, PreviewProject, PreviewTemplate } from '../preview/core/types.ts';
import { createSceneProjectFiles, validateSceneSpec } from '../modeling/sceneSpec.ts';

const DEFAULT_TEMPLATE: PreviewTemplate = 'react';

function createProjectState(template: PreviewTemplate): PreviewProject {
  return {
    id: `preview-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: template === 'react' ? 'React Preview' : 'HTML Preview',
    template,
    files: createTemplateFiles(template),
  };
}

export interface PreviewProjectStoreState {
  project: PreviewProject;
  selectedFilePath: string | null;
  buildRunRevision: number;
  createProject: (template: PreviewTemplate) => void;
  selectFile: (path: string | null) => void;
  readFile: (path: string) => string | undefined;
  writeFile: (path: string, content: string) => void;
  deleteFile: (path: string) => void;
  resetProject: () => void;
  importProject: (template: PreviewTemplate, files: PreviewFiles, name?: string, projectId?: string) => void;
  getFilePaths: () => string[];
  applyAiFileChange: (change: { projectId: string; path: string; content: string }) => boolean;
  applyAiSceneSpec: (change: { projectId: string; content: string }) => boolean;
  requestBuildAndRun: () => void;
}

type Listener = () => void;
const listeners = new Set<Listener>();

let state: PreviewProjectStoreState;

function emit(): void {
  listeners.forEach((listener) => listener());
}

function updateProject(project: PreviewProject, selectedFilePath: string | null): void {
  state = { ...state, project, selectedFilePath, buildRunRevision: project.id === state.project.id ? state.buildRunRevision : 0 };
  emit();
}

const actions: Omit<PreviewProjectStoreState, 'project' | 'selectedFilePath' | 'buildRunRevision'> = {
  createProject(template) {
    const project = createProjectState(template);
    updateProject(project, listFiles(project.files)[0] ?? null);
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
    updateProject({ ...state.project, files }, normalizePreviewPath(path));
  },
  deleteFile(path) {
    const files = deleteFile(state.project.files, path);
    const paths = listFiles(files);
    const selectedFilePath = state.selectedFilePath && readFile(files, state.selectedFilePath) !== undefined
      ? state.selectedFilePath
      : paths[0] ?? null;
    updateProject({ ...state.project, files }, selectedFilePath);
  },
  resetProject() {
    const files = createTemplateFiles(state.project.template);
    updateProject({ ...state.project, files }, listFiles(files)[0] ?? null);
  },
  importProject(template, files, name, projectId) {
    const normalizedFiles: PreviewFiles = Object.create(null);
    for (const [path, content] of Object.entries(files)) {
      const normalizedPath = normalizePreviewPath(path);
      if (normalizedPath !== path || typeof content !== 'string') throw new Error(`无效的源码文件：${path}`);
      normalizedFiles[path] = content;
    }
    if (!normalizedFiles['/index.html']) throw new Error('源码 ZIP 缺少 /index.html。');
    if (Object.keys(normalizedFiles).length > 100) throw new Error('源码 ZIP 文件过多。');
    const totalBytes = Object.values(normalizedFiles).reduce((total, content) => total + new TextEncoder().encode(content).byteLength, 0);
    if (totalBytes > 5_000_000) throw new Error('源码 ZIP 超过 5 MB。');
    const project: PreviewProject = {
      id: projectId?.trim() || `preview-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name: name?.trim().slice(0, 80) || (template === 'react' ? 'Imported React Project' : 'Imported HTML Project'),
      template,
      files: normalizedFiles,
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
    if (path !== change.path || !(/^\/src\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.(?:tsx?|jsx?|css|json|html)$/.test(path) || ['/index.html', '/main.js', '/style.css'].includes(path))) return false;
    if (!Object.prototype.hasOwnProperty.call(state.project.files, path) && Object.keys(state.project.files).length >= 40) return false;
    const files = writeFile(state.project.files, path, change.content);
    if (Object.values(files).reduce((total, value) => total + new TextEncoder().encode(value).length, 0) > 500_000) return false;
    updateProject({ ...state.project, files }, path);
    return true;
  },
  applyAiSceneSpec(change) {
    if (change.projectId !== state.project.id || typeof change.content !== 'string' || new TextEncoder().encode(change.content).byteLength > 100_000) return false;
    try {
      const scene = validateSceneSpec(JSON.parse(change.content));
      const files = { ...state.project.files, ...createSceneProjectFiles(scene) };
      if (Object.keys(files).length > 40 || Object.values(files).some((content) => new TextEncoder().encode(content).byteLength > 100_000)) return false;
      if (Object.values(files).reduce((total, content) => total + new TextEncoder().encode(content).byteLength, 0) > 500_000) return false;
      updateProject({ ...state.project, name: scene.name, files }, '/src/scene.json');
      return true;
    } catch {
      return false;
    }
  },
  requestBuildAndRun() {
    state = { ...state, buildRunRevision: state.buildRunRevision + 1 };
    emit();
  },
};

const initialProject = createProjectState(DEFAULT_TEMPLATE);
state = {
  project: initialProject,
  selectedFilePath: listFiles(initialProject.files)[0] ?? null,
  buildRunRevision: 0,
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
