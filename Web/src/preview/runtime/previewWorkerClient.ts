import type { PreviewFiles } from '../core/types.ts';
import type {
  BuildDiagnostic,
  MainToWorkerMessage,
  PreviewBuildResult,
  WorkerToMainMessage,
} from './workerProtocol.ts';
import { isWorkerToMainMessage } from './workerProtocol.ts';

type PendingRequest = {
  resolve: (message: WorkerToMainMessage) => void;
  reject: (error: Error) => void;
};

export class PreviewBuildError extends Error {
  readonly diagnostics: BuildDiagnostic[];
  readonly buildId: string;
  readonly projectId: string;
  readonly duration: number;

  constructor(message: Extract<WorkerToMainMessage, { type: 'BUILD_ERROR' }>) {
    super(message.diagnostics[0]?.message ?? 'Preview build failed.');
    this.name = 'PreviewBuildError';
    this.diagnostics = message.diagnostics;
    this.buildId = message.buildId;
    this.projectId = message.projectId;
    this.duration = message.duration;
  }
}

export class StalePreviewBuildError extends Error {
  constructor() {
    super('A newer Preview Project build has already started.');
    this.name = 'StalePreviewBuildError';
  }
}

export class PreviewWorkerClient {
  private readonly worker: Worker;
  private readonly pending = new Map<string, PendingRequest>();
  private requestSequence = 0;
  private buildSequence = 0;
  private disposed = false;
  private latestBuildId: string | null = null;
  private latestProjectId: string | null = null;

  constructor() {
    this.worker = new Worker(new URL('./preview.worker.ts', import.meta.url), { type: 'module' });
    this.worker.addEventListener('message', this.handleMessage);
    this.worker.addEventListener('error', this.handleWorkerError);
    this.worker.addEventListener('messageerror', this.handleMessageError);
  }

  async initialize(): Promise<void> {
    await this.request({ type: 'INIT', requestId: this.nextRequestId() }, ['READY']);
  }

  async syncFiles(projectId: string, files: PreviewFiles): Promise<void> {
    const response = await this.request({
      type: 'SYNC_FILES',
      requestId: this.nextRequestId(),
      projectId,
      files: structuredClone(files),
    }, ['FILES_SYNCED']);
    if (response.type !== 'FILES_SYNCED' || response.projectId !== projectId) {
      throw new Error('Preview Worker acknowledged a different project.');
    }
  }

  async build(projectId: string, entryPoint: string): Promise<PreviewBuildResult> {
    const buildId = `${projectId}:${Date.now()}:${++this.buildSequence}`;
    this.latestBuildId = buildId;
    this.latestProjectId = projectId;
    const response = await this.request({
      type: 'BUILD',
      requestId: this.nextRequestId(),
      projectId,
      buildId,
      entryPoint,
    }, ['BUILD_SUCCESS', 'BUILD_ERROR']);

    if (buildId !== this.latestBuildId || projectId !== this.latestProjectId) {
      throw new StalePreviewBuildError();
    }
    if (response.type === 'BUILD_ERROR') throw new PreviewBuildError(response);
    if (response.type !== 'BUILD_SUCCESS') throw new Error('Preview Worker returned an invalid build response.');
    return response.result;
  }

  async reset(): Promise<void> {
    this.latestBuildId = null;
    this.latestProjectId = null;
    await this.request({ type: 'RESET', requestId: this.nextRequestId() }, ['FILES_SYNCED']);
  }

  terminate(): void {
    this.dispose();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.worker.removeEventListener('message', this.handleMessage);
    this.worker.removeEventListener('error', this.handleWorkerError);
    this.worker.removeEventListener('messageerror', this.handleMessageError);
    this.worker.terminate();
    this.rejectAll(new Error('Preview Worker was disposed.'));
  }

  private nextRequestId(): string {
    return `preview-request-${Date.now()}-${++this.requestSequence}`;
  }

  private request(
    message: MainToWorkerMessage,
    terminalTypes: WorkerToMainMessage['type'][],
  ): Promise<WorkerToMainMessage> {
    if (this.disposed) return Promise.reject(new Error('Preview Worker is disposed.'));
    return new Promise((resolve, reject) => {
      this.pending.set(message.requestId, {
        resolve: (response) => {
          if (terminalTypes.includes(response.type)) resolve(response);
        },
        reject,
      });
      this.worker.postMessage(message);
    });
  }

  private handleMessage = (event: MessageEvent<unknown>): void => {
    if (!isWorkerToMainMessage(event.data)) {
      this.rejectAll(new Error('Preview Worker returned an unknown message.'));
      return;
    }
    const message = event.data;
    if (message.type === 'WORKER_ERROR') {
      const error = new Error(message.message);
      if (message.requestId) {
        this.pending.get(message.requestId)?.reject(error);
        this.pending.delete(message.requestId);
      } else {
        this.rejectAll(error);
      }
      return;
    }
    if (message.type === 'BUILD_STARTED') return;
    const pending = this.pending.get(message.requestId);
    if (!pending) return;
    pending.resolve(message);
    this.pending.delete(message.requestId);
  };

  private handleWorkerError = (event: ErrorEvent): void => {
    this.rejectAll(new Error(event.message || 'Preview Worker crashed.'));
  };

  private handleMessageError = (): void => {
    this.rejectAll(new Error('Preview Worker could not deserialize a message.'));
  };

  private rejectAll(error: Error): void {
    this.pending.forEach(({ reject }) => reject(error));
    this.pending.clear();
  }
}
