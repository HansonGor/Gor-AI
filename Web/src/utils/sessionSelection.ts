import type { Session } from '../types';

/** Explicit links win, then the last selected session in this host namespace. */
export function initialSessionId(sessions: readonly Session[], requested: string | null, lastUsed: string | null): string | null {
  for (const id of [requested, lastUsed]) {
    if (id && sessions.some((session) => session.id === id)) return id;
  }
  // The API returns newest first. Compare dates as well for unordered responses.
  const latest = sessions.reduce<Session | null>((current, session) => {
    if (!current) return session;
    const timestamp = (value?: string) => Date.parse(value ?? '') || 0;
    return timestamp(session.updated_at) > timestamp(current.updated_at) ? session : current;
  }, null);
  return latest?.id ?? null;
}
