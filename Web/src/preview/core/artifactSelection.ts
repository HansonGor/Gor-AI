import type { ChatMessage, PreviewProjectSnapshot } from '../../types.ts';

/** Creation order is shared across current projects, snapshots and exported files. */
export function previewArtifactCreationOrder(messages: ChatMessage[]): Record<string, number> {
  const order: Record<string, number> = Object.create(null);
  const projectOrder = new Map<string, number>();
  let previous = 0;
  for (const message of messages) {
    const parsed = Date.parse(message.created_at ?? '');
    const time = Number.isFinite(parsed) ? parsed : previous + 1;
    previous = time;
    const snapshot = message.previewSnapshot;
    const ids = new Set([...(message.previewChanges ?? []).map((change) => change.projectId),
      ...(snapshot ? [snapshot.projectId || snapshot.id] : [])]);
    for (const id of ids) {
      if (!projectOrder.has(id)) projectOrder.set(id, time);
      order[`project:${id}`] = projectOrder.get(id)!;
    }
    if (snapshot) order[`project-snapshot:${snapshot.messageId}`] = projectOrder.get(snapshot.projectId || snapshot.id)!;
    for (const file of message.files?.length ? message.files : message.file ? [message.file] : []) {
      const projectId = file.projectId || (ids.size === 1 ? [...ids][0] : undefined);
      const key = `generated:${file.downloadUrl}`;
      order[key] ??= projectId ? projectOrder.get(projectId) ?? time : time;
    }
    for (const attachment of message.attachments ?? []) {
      order[`uploaded:${attachment.kind}:${attachment.name}`] ??= time;
    }
  }
  return order;
}

export function sortPreviewArtifactEntries<T extends { key: string }>(entries: T[], order: Record<string, number>): T[] {
  return [...entries].sort((a, b) => (order[a.key] ?? Number.MAX_SAFE_INTEGER) - (order[b.key] ?? Number.MAX_SAFE_INTEGER));
}

/** A stale generated-file selection must never supply Code for the current project. */
export function sourceSnapshotForTarget(target: string, active: PreviewProjectSnapshot | null, generated?: PreviewProjectSnapshot): PreviewProjectSnapshot | undefined {
  if (target === 'project-snapshot') return active ?? undefined;
  if (target === 'generated') return generated;
  return undefined;
}
