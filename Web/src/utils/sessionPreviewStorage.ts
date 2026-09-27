import type { ImportedDistArchive } from '../preview/core/importArchive';
import type { PreviewFiles, PreviewTemplate } from '../preview/core/types';
import type { PreviewWorkerMode, PreviewWorkerTarget } from '../components/ChatBox/PreviewWorker';

const DATABASE_NAME = 'gor-session-preview-cache';
const DATABASE_VERSION = 2;
const STORE_NAME = 'previews';
const ARTIFACT_STORE_NAME = 'artifacts';

export type SessionPreviewContent =
  | {
      kind: 'source';
      projectId?: string;
      name: string;
      template: PreviewTemplate;
      files: PreviewFiles;
    }
  | {
      kind: 'dist';
      archive: ImportedDistArchive;
    };

export interface SessionPreviewUiState {
  previewOpen: boolean;
  previewWorkerOpen: boolean;
  previewWorkerMode: PreviewWorkerMode;
  previewWorkerTarget: PreviewWorkerTarget;
  activePreviewFileUrl: string | null;
  selectedFilePath: string | null;
}

export interface SessionPreviewRecord {
  sessionId: string;
  uploadName: string;
  content: SessionPreviewContent;
  updatedAt: number;
}

export interface SessionPreviewArtifactRecord {
  key: string;
  sessionId: string;
  uploadName: string;
  content: SessionPreviewContent;
  updatedAt: number;
}

export type SessionPreviewSnapshot = SessionPreviewRecord & SessionPreviewUiState;

function uiStorageKey(sessionId: string): string {
  return `gor-session-preview-ui:${sessionId}`;
}

function openDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === 'undefined') {
    return Promise.reject(new Error('当前浏览器不支持本地预览缓存。'));
  }

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME, { keyPath: 'sessionId' });
      }
      if (!database.objectStoreNames.contains(ARTIFACT_STORE_NAME)) {
        database.createObjectStore(ARTIFACT_STORE_NAME, { keyPath: 'key' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('无法打开本地预览缓存。'));
    request.onblocked = () => reject(new Error('本地预览缓存正在升级，请关闭其他应用页面后重试。'));
  });
}

async function withStore<T>(
  storeName: string,
  mode: IDBTransactionMode,
  action: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const database = await openDatabase();
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = database.transaction(storeName, mode);
      const request = action(transaction.objectStore(storeName));
      let result!: T;
      request.onsuccess = () => { result = request.result; };
      request.onerror = () => reject(request.error ?? new Error('本地预览缓存操作失败。'));
      transaction.oncomplete = () => resolve(result);
      transaction.onerror = () => reject(transaction.error ?? new Error('本地预览缓存事务失败。'));
      transaction.onabort = () => reject(transaction.error ?? new Error('本地预览缓存事务已中止。'));
    });
  } finally {
    database.close();
  }
}

export function getSessionPreview(sessionId: string): Promise<SessionPreviewSnapshot | undefined> {
  return withStore<SessionPreviewRecord | undefined>(STORE_NAME, 'readonly', (store) => store.get(sessionId)).then((record) => {
    if (!record) return undefined;
    let ui: Partial<SessionPreviewUiState> = {};
    try {
      const serialized = localStorage.getItem(uiStorageKey(sessionId));
      if (serialized) ui = JSON.parse(serialized) as Partial<SessionPreviewUiState>;
    } catch {
      // A malformed UI preference should not prevent restoring the uploaded content.
    }
    return {
      ...record,
      previewOpen: ui.previewOpen ?? false,
      previewWorkerOpen: ui.previewWorkerOpen ?? true,
      previewWorkerMode: ui.previewWorkerMode ?? 'preview',
      previewWorkerTarget: ui.previewWorkerTarget ?? (record.content.kind === 'dist' ? 'uploaded-dist' : 'project'),
      activePreviewFileUrl: ui.activePreviewFileUrl ?? null,
      selectedFilePath: ui.selectedFilePath ?? null,
    };
  });
}

export function saveSessionPreview(record: SessionPreviewRecord): Promise<IDBValidKey> {
  const artifactRecord: SessionPreviewArtifactRecord = {
    ...record,
    key: `${record.sessionId}:${normalizeUploadName(record.uploadName)}`,
  };
  return withStore(ARTIFACT_STORE_NAME, 'readwrite', (store) => store.put(artifactRecord))
    .then(() => withStore(STORE_NAME, 'readwrite', (store) => store.put(record)));
}

function normalizeUploadName(name: string): string {
  return name.trim().replace(/\.zip$/i, '').toLocaleLowerCase();
}

export function getSessionPreviewArtifact(
  sessionId: string,
  uploadName: string,
): Promise<SessionPreviewArtifactRecord | undefined> {
  const key = `${sessionId}:${normalizeUploadName(uploadName)}`;
  return withStore<SessionPreviewArtifactRecord | undefined>(ARTIFACT_STORE_NAME, 'readonly', (store) => store.get(key));
}

export function saveSessionPreviewUi(sessionId: string, state: SessionPreviewUiState): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(uiStorageKey(sessionId), JSON.stringify(state));
}

export function deleteSessionPreview(sessionId: string): Promise<void> {
  try {
    if (typeof localStorage !== 'undefined') localStorage.removeItem(uiStorageKey(sessionId));
  } catch {
    // Continue deleting the actual uploaded content even if localStorage is unavailable.
  }
  return withStore(STORE_NAME, 'readwrite', (store) => store.delete(sessionId)).then(() =>
    withStore(ARTIFACT_STORE_NAME, 'readwrite', (store) => {
      const request = store.getAll();
      request.onsuccess = () => {
        request.result
          .filter((artifact: SessionPreviewArtifactRecord) => artifact.sessionId === sessionId)
          .forEach((artifact: SessionPreviewArtifactRecord) => store.delete(artifact.key));
      };
      return request;
    }),
  ).then(() => undefined);
}
