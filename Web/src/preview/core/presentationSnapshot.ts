import type { GeneratedFile, PreviewProjectSnapshot } from '../../types.ts';

export function createPresentationSnapshot(file: GeneratedFile, messageId: string, sessionId?: string): PreviewProjectSnapshot | undefined {
  if (file.previewRenderer !== 'presentation' || !file.presentationSchema) return undefined;
  const finalArtifact = { ...file, messageId, ...(sessionId ? { sessionId } : {}) };
  return {
    messageId,
    id: file.projectId || file.artifactId || messageId,
    projectId: file.projectId,
    artifactId: file.artifactId,
    snapshotId: file.snapshotId,
    name: file.presentationSchema.title,
    template: 'presentation',
    outputExtension: '.pptx',
    files: file.sourceFiles || { '/presentation.json': JSON.stringify(file.presentationSchema, null, 2) },
    presentationSchema: file.presentationSchema,
    presentationBackgrounds: file.presentationBackgrounds,
    renderedSlides: file.renderedSlides,
    finalArtifact,
    storyOutline: file.storyOutline,
    visualQA: file.visualQA,
    antiAIPatternReport: file.antiAIPatternReport,
    designCritique: file.designCritique,
  };
}

export function restorePresentationSnapshot(value: unknown, fallbackMessageId: string): PreviewProjectSnapshot | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const snapshot = value as Partial<PreviewProjectSnapshot>;
  if (snapshot.template !== 'presentation' || !snapshot.presentationSchema || !snapshot.files || typeof snapshot.files !== 'object') return undefined;
  return {
    messageId: String(snapshot.messageId || fallbackMessageId),
    id: String(snapshot.id || snapshot.projectId || fallbackMessageId),
    name: String(snapshot.name || snapshot.presentationSchema.title || '演示文稿'),
    template: 'presentation',
    outputExtension: '.pptx',
    files: snapshot.files as Record<string, string>,
    artifactId: snapshot.artifactId,
    projectId: snapshot.projectId,
    snapshotId: snapshot.snapshotId,
    presentationSchema: snapshot.presentationSchema,
    presentationBackgrounds: snapshot.presentationBackgrounds,
    renderedSlides: snapshot.renderedSlides,
    finalArtifact: snapshot.finalArtifact,
    storyOutline: snapshot.storyOutline,
    visualQA: snapshot.visualQA,
    antiAIPatternReport: snapshot.antiAIPatternReport,
    designCritique: snapshot.designCritique,
  };
}

export function isPresentationSnapshotFile(file: GeneratedFile, snapshots: PreviewProjectSnapshot[]): boolean {
  return Boolean(file.artifactId && snapshots.some((snapshot) => snapshot.template === 'presentation' && snapshot.artifactId === file.artifactId));
}

/**
 * A message's persisted presentation snapshot is the canonical deck for that
 * assistant turn. Older turns may already contain multiple PPT attachments
 * from repeated tool calls; keep only the artifact bound to that snapshot.
 */
export function canonicalizePresentationFiles(files: GeneratedFile[], snapshot?: PreviewProjectSnapshot): GeneratedFile[] {
  if (snapshot?.template !== 'presentation' || !snapshot.artifactId) return files;
  return files.filter((file) => file.previewRenderer !== 'presentation' || file.artifactId === snapshot.artifactId);
}
