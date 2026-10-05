import { generatedFileExtension } from './artifactFormat.ts';
import type { GeneratedFile, UploadedAttachment } from '../../types.ts';

export interface PreviewFilePresence {
  currentProjectVisible: boolean;
  projectSnapshotCount: number;
  generatedFileCount: number;
  uploadedAttachmentCount: number;
  hasImportedDist: boolean;
}

const PREVIEWABLE_GENERATED_EXTENSIONS = new Set(['.html', '.htm', '.pdf', '.glb', '.docx', '.xlsx', '.pptx']);

export function isPreviewableGeneratedFile(file: GeneratedFile): boolean {
  if (file.previewRenderer === 'presentation' && file.presentationSchema) return true;
  const extension = generatedFileExtension(file);
  return extension !== null && PREVIEWABLE_GENERATED_EXTENSIONS.has(extension);
}

export function isPreviewableUploadedAttachment(attachment: UploadedAttachment): boolean {
  const isProjectArchive = attachment.kind === 'archive' || attachment.kind === 'folder';
  return isProjectArchive && Boolean(attachment.previewStorageId || attachment.storageId);
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
