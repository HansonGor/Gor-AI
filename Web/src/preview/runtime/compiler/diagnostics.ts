import type { BuildDiagnostic } from '../workerProtocol.ts';

export interface CompilerMessageLike {
  text?: string;
  message?: string;
  location?: {
    file?: string;
    line?: number;
    column?: number;
    lineText?: string;
  } | null;
}

export function normalizeDiagnostics(messages: readonly CompilerMessageLike[]): BuildDiagnostic[] {
  return messages.map((message) => ({
    message: message.text ?? message.message ?? 'Unknown build error',
    file: message.location?.file?.replace(/^preview-vfs:/, '') || null,
    line: message.location?.line ?? null,
    column: message.location?.column === undefined ? null : message.location.column + 1,
    lineText: message.location?.lineText || null,
  }));
}

export function diagnosticFromUnknown(error: unknown): BuildDiagnostic[] {
  if (typeof error === 'object' && error !== null && 'errors' in error && Array.isArray(error.errors)) {
    return normalizeDiagnostics(error.errors as CompilerMessageLike[]);
  }
  return [{
    message: error instanceof Error ? error.message : String(error),
    file: null,
    line: null,
    column: null,
    lineText: null,
  }];
}
