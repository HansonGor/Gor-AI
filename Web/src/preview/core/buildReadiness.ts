import type { PreviewFiles } from './types.ts';

/** New projects have an empty VFS until the source commit arrives. */
export function canBuildPreviewSource(files: PreviewFiles, sourcePending = false): boolean {
  return !sourcePending && Object.keys(files).length > 0;
}
