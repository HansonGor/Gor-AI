import type { RuntimeDiagnostic } from './runtimeProtocol.ts';

const MAX_DEPTH = 4;

function serialize(value: unknown, seen: WeakSet<object>, depth: number): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  if (typeof value === 'symbol') return value.toString();
  if (typeof value === 'function') return `[Function ${(value as Function).name || 'anonymous'}]`;
  if (value instanceof Error) return `${value.name}: ${value.message}${value.stack ? `\n${value.stack}` : ''}`;
  if (depth >= MAX_DEPTH) return '[Max depth]';
  if (typeof value === 'object') {
    if (seen.has(value)) return '[Circular]';
    seen.add(value);
    try {
      if (Array.isArray(value)) return `[${value.map((item) => serialize(item, seen, depth + 1)).join(', ')}]`;
      const entries = Object.entries(value as Record<string, unknown>)
        .slice(0, 50)
        .map(([key, item]) => `${key}: ${serialize(item, seen, depth + 1)}`);
      return `{ ${entries.join(', ')} }`;
    } catch {
      return '[Unserializable object]';
    } finally {
      seen.delete(value);
    }
  }
  return String(value);
}

export function serializeConsoleArgs(args: unknown[]): string[] {
  return args.map((value) => serialize(value, new WeakSet<object>(), 0));
}

export function normalizeRuntimeError(
  error: unknown,
  metadata: Pick<RuntimeDiagnostic, 'runtimeId' | 'projectId' | 'buildId'>,
  location: { source?: string | null; line?: number | null; column?: number | null } = {},
): RuntimeDiagnostic {
  const value = error instanceof Error ? error : new Error(serialize(error, new WeakSet<object>(), 0));
  return {
    ...metadata,
    message: value.message || value.name || 'Unknown runtime error',
    source: location.source ?? null,
    line: location.line ?? null,
    column: location.column ?? null,
    stack: value.stack ?? null,
  };
}
