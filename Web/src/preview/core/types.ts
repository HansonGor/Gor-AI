export type PreviewFiles = Record<string, string>;

export type PreviewTemplate = 'html' | 'react';

export interface PreviewProject {
  id: string;
  name: string;
  template: PreviewTemplate;
  files: PreviewFiles;
}

export interface FileTreeNode {
  name: string;
  path: string;
  type: 'file' | 'directory';
  children?: FileTreeNode[];
}
