export interface PreviewFilePresence {
  currentProjectVisible: boolean;
  projectSnapshotCount: number;
  generatedFileCount: number;
  uploadedAttachmentCount: number;
  hasImportedDist: boolean;
}

export function hasCurrentProjectSource(
  currentFileCount: number,
  isImportedSource: boolean,
  isPersistedProject: boolean,
  trackedSourcePathCount: number,
): boolean {
  return (currentFileCount > 0 && (isImportedSource || isPersistedProject))
    || trackedSourcePathCount > 0;
}

export function hasPreviewFiles(presence: PreviewFilePresence): boolean {
  return presence.currentProjectVisible
    || presence.projectSnapshotCount > 0
    || presence.generatedFileCount > 0
    || presence.uploadedAttachmentCount > 0
    || presence.hasImportedDist;
}
