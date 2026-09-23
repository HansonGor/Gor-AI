import { normalizePreviewPath } from './pathUtils.ts';
import type { FileTreeNode, PreviewFiles } from './types.ts';

interface MutableTreeNode extends FileTreeNode {
  children?: MutableTreeNode[];
}

function sortNodes(nodes: MutableTreeNode[]): FileTreeNode[] {
  return nodes
    .sort((left, right) => {
      if (left.type !== right.type) return left.type === 'directory' ? -1 : 1;
      return left.name.localeCompare(right.name);
    })
    .map((node) => node.type === 'directory'
      ? { ...node, children: sortNodes(node.children ?? []) }
      : { name: node.name, path: node.path, type: node.type });
}

export function buildFileTree(files: PreviewFiles): FileTreeNode[] {
  const root: MutableTreeNode[] = [];

  Object.keys(files).forEach((filePath) => {
    const normalizedPath = normalizePreviewPath(filePath);
    const parts = normalizedPath.slice(1).split('/');
    let level = root;

    parts.forEach((part, index) => {
      const path = `/${parts.slice(0, index + 1).join('/')}`;
      const isFile = index === parts.length - 1;
      let node = level.find((candidate) => candidate.name === part);
      if (!node) {
        node = isFile
          ? { name: part, path, type: 'file' }
          : { name: part, path, type: 'directory', children: [] };
        level.push(node);
      }
      if (!isFile) {
        if (node.type !== 'directory') {
          throw new Error(`A file blocks the virtual directory ${path}.`);
        }
        level = node.children ?? (node.children = []);
      }
    });
  });

  return sortNodes(root);
}
