import type { ChatMessage } from '../types';

/** Only restore an explicitly associated journal. Never infer from file names. */
export function restoreChangeSetReference(value: unknown, sessionId: string): ChatMessage['projectChangeSet'] {
  if (!Array.isArray(value) || value.length !== 1) return undefined;
  const record = value[0];
  if (!record || typeof record.id !== 'string' || !record.id || record.sessionId !== sessionId
    || (record.provider !== 'preview' && record.provider !== 'vscode')) return undefined;
  return { id: record.id, sessionId, provider: record.provider };
}

export function bindLiveChangeSet(message: Pick<ChatMessage, 'projectChangeSet' | 'projectChangeSetAmbiguous'>,
  reference: NonNullable<ChatMessage['projectChangeSet']>) {
  const ambiguous = message.projectChangeSetAmbiguous || Boolean(message.projectChangeSet && message.projectChangeSet.id !== reference.id);
  return { projectChangeSet: ambiguous ? undefined : reference, projectChangeSetAmbiguous: ambiguous };
}
