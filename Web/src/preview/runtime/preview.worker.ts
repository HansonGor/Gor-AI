/// <reference lib="webworker" />

import type { PreviewFiles } from '../core/types.ts';
import type { MainToWorkerMessage, WorkerToMainMessage } from './workerProtocol.ts';
import { buildPreviewProject, initializeCompiler } from './compiler/esbuildCompiler.ts';
import { diagnosticFromUnknown } from './compiler/diagnostics.ts';

const workerScope: DedicatedWorkerGlobalScope = self as unknown as DedicatedWorkerGlobalScope;
let syncedProjectId: string | null = null;
let filesSnapshot: PreviewFiles = {};

function send(message: WorkerToMainMessage): void {
  workerScope.postMessage(message);
}

workerScope.onmessage = async (event: MessageEvent<MainToWorkerMessage>) => {
  const message = event.data;
  try {
    if (message.type === 'INIT') {
      await initializeCompiler();
      send({ type: 'READY', requestId: message.requestId });
      return;
    }

    if (message.type === 'RESET') {
      syncedProjectId = null;
      filesSnapshot = {};
      send({ type: 'FILES_SYNCED', requestId: message.requestId, projectId: null, fileCount: 0 });
      return;
    }

    if (message.type === 'SYNC_FILES') {
      syncedProjectId = message.projectId;
      filesSnapshot = structuredClone(message.files);
      send({
        type: 'FILES_SYNCED',
        requestId: message.requestId,
        projectId: syncedProjectId,
        fileCount: Object.keys(filesSnapshot).length,
      });
      return;
    }

    send({
      type: 'BUILD_STARTED',
      requestId: message.requestId,
      projectId: message.projectId,
      buildId: message.buildId,
    });
    const startedAt = performance.now();
    if (syncedProjectId !== message.projectId) {
      throw new Error(`Preview Project "${message.projectId}" is not synchronized with the compiler Worker.`);
    }
    try {
      const result = await buildPreviewProject(
        message.projectId,
        message.buildId,
        filesSnapshot,
        message.entryPoint,
      );
      send({ type: 'BUILD_SUCCESS', requestId: message.requestId, result });
    } catch (error) {
      send({
        type: 'BUILD_ERROR',
        requestId: message.requestId,
        projectId: message.projectId,
        buildId: message.buildId,
        diagnostics: diagnosticFromUnknown(error),
        duration: performance.now() - startedAt,
      });
    }
  } catch (error) {
    send({
      type: 'WORKER_ERROR',
      requestId: message.requestId,
      message: error instanceof Error ? error.message : String(error),
    });
  }
};
