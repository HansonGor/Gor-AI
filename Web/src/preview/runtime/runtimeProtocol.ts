export type PreviewRuntimeStatus = 'idle' | 'initializing' | 'ready' | 'running' | 'success' | 'error';

export interface RuntimeMetadata {
  runtimeId: string;
  projectId: string;
  buildId: string;
}

export interface RuntimeDiagnostic extends RuntimeMetadata {
  message: string;
  source: string | null;
  line: number | null;
  column: number | null;
  stack: string | null;
}

export type RuntimeConsoleLevel = 'log' | 'info' | 'warn' | 'error';

export interface RuntimeConsoleEntry extends RuntimeMetadata {
  level: RuntimeConsoleLevel;
  args: string[];
  timestamp: number;
}

export type ParentToRuntimeMessage =
  | ({ type: 'RUNTIME_INIT' } & RuntimeMetadata)
  | ({ type: 'RUNTIME_RUN'; javascript: string; css: string | null } & RuntimeMetadata)
  | ({ type: 'RUNTIME_RESET' } & RuntimeMetadata);

export type RuntimeToParentMessage =
  | { type: 'RUNTIME_HOST_READY'; runtimeId: string }
  | ({ type: 'RUNTIME_READY' } & RuntimeMetadata)
  | ({ type: 'RUNTIME_STARTED' } & RuntimeMetadata)
  | ({ type: 'RUNTIME_SUCCESS' } & RuntimeMetadata)
  | ({ type: 'RUNTIME_ERROR'; error: RuntimeDiagnostic } & RuntimeMetadata)
  | ({ type: 'RUNTIME_CONSOLE'; entry: RuntimeConsoleEntry } & RuntimeMetadata);

function hasMetadata(value: Record<string, unknown>): boolean {
  return typeof value.runtimeId === 'string'
    && typeof value.projectId === 'string'
    && typeof value.buildId === 'string';
}

export function isParentToRuntimeMessage(value: unknown): value is ParentToRuntimeMessage {
  if (typeof value !== 'object' || value === null) return false;
  const message = value as Record<string, unknown>;
  if (!hasMetadata(message)) return false;
  if (message.type === 'RUNTIME_INIT' || message.type === 'RUNTIME_RESET') return true;
  return message.type === 'RUNTIME_RUN'
    && typeof message.javascript === 'string'
    && (typeof message.css === 'string' || message.css === null);
}

export function isRuntimeToParentMessage(value: unknown): value is RuntimeToParentMessage {
  if (typeof value !== 'object' || value === null) return false;
  const message = value as Record<string, unknown>;
  if (message.type === 'RUNTIME_HOST_READY') return typeof message.runtimeId === 'string';
  if (!hasMetadata(message)) return false;
  if (message.type === 'RUNTIME_READY' || message.type === 'RUNTIME_STARTED' || message.type === 'RUNTIME_SUCCESS') return true;
  if (message.type === 'RUNTIME_ERROR') return typeof message.error === 'object' && message.error !== null;
  return message.type === 'RUNTIME_CONSOLE' && typeof message.entry === 'object' && message.entry !== null;
}
