import type { PreviewFiles } from '../core/types.ts';

export interface BuildDiagnostic {
  message: string;
  file: string | null;
  line: number | null;
  column: number | null;
  lineText: string | null;
}

export interface BuildOutputFile {
  path: string;
  type: 'js' | 'css';
  contents: string;
}

export interface PreviewBuildResult {
  buildId: string;
  projectId: string;
  entryPoint: string;
  outputFiles: BuildOutputFile[];
  warnings: BuildDiagnostic[];
  duration: number;
}

export type MainToWorkerMessage =
  | { type: 'INIT'; requestId: string }
  | { type: 'SYNC_FILES'; requestId: string; projectId: string; files: PreviewFiles }
  | { type: 'BUILD'; requestId: string; projectId: string; buildId: string; entryPoint: string }
  | { type: 'RESET'; requestId: string };

export type WorkerToMainMessage =
  | { type: 'READY'; requestId: string }
  | { type: 'FILES_SYNCED'; requestId: string; projectId: string | null; fileCount: number }
  | { type: 'BUILD_STARTED'; requestId: string; projectId: string; buildId: string }
  | { type: 'BUILD_SUCCESS'; requestId: string; result: PreviewBuildResult }
  | { type: 'BUILD_ERROR'; requestId: string; projectId: string; buildId: string; diagnostics: BuildDiagnostic[]; duration: number }
  | { type: 'WORKER_ERROR'; requestId: string | null; message: string };

export function isWorkerToMainMessage(value: unknown): value is WorkerToMainMessage {
  if (typeof value !== 'object' || value === null || !('type' in value)) return false;
  const type = (value as { type: unknown }).type;
  return type === 'READY'
    || type === 'FILES_SYNCED'
    || type === 'BUILD_STARTED'
    || type === 'BUILD_SUCCESS'
    || type === 'BUILD_ERROR'
    || type === 'WORKER_ERROR';
}
