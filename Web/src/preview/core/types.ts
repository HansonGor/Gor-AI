export type PreviewFiles = Record<string, string>;

export type PreviewTemplate = 'html' | 'react';

export interface PreviewProject {
  id: string;
  name: string;
  template: PreviewTemplate;
  files: PreviewFiles;
  /** Local source revision, incremented on each text-file edit. */
  revision?: number;
  /** Server row revision used for optimistic concurrency. */
  serverRevision?: number;
  /** Highest local source revision known to be saved on the server. */
  persistedRevision?: number;
  origin?: 'generated' | 'uploaded-source';
  uploadName?: string | null;
}

export interface FileTreeNode {
  name: string;
  path: string;
  type: 'file' | 'directory';
  children?: FileTreeNode[];
}
