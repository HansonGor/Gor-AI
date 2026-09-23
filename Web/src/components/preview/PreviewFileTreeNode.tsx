import { ChevronDown, ChevronRight, FileCode2, Folder, FolderOpen } from 'lucide-react';
import type { FileTreeNode } from '../../preview/core/types';
import { Button } from '../ui/button';

interface PreviewFileTreeNodeProps {
  node: FileTreeNode;
  depth: number;
  expandedPaths: ReadonlySet<string>;
  selectedFilePath: string | null;
  onToggleDirectory: (path: string) => void;
  onSelectFile: (path: string) => void;
}

export default function PreviewFileTreeNode({
  node,
  depth,
  expandedPaths,
  selectedFilePath,
  onToggleDirectory,
  onSelectFile,
}: PreviewFileTreeNodeProps) {
  const isDirectory = node.type === 'directory';
  const expanded = isDirectory && expandedPaths.has(node.path);

  return (
    <li className="preview-tree-node">
      <Button
        type="button"
        variant="ghost"
        className={node.path === selectedFilePath ? 'active' : ''}
        style={{ paddingLeft: `${10 + depth * 14}px` }}
        onClick={() => (isDirectory ? onToggleDirectory(node.path) : onSelectFile(node.path))}
        title={node.path}
      >
        {isDirectory ? (
          <>
            {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            {expanded ? <FolderOpen size={14} /> : <Folder size={14} />}
          </>
        ) : (
          <>
            <span className="preview-tree-spacer" />
            <FileCode2 size={14} />
          </>
        )}
        <span>{node.name}</span>
      </Button>
      {isDirectory && expanded && node.children && (
        <ul>
          {node.children.map((child) => (
            <PreviewFileTreeNode
              key={child.path}
              node={child}
              depth={depth + 1}
              expandedPaths={expandedPaths}
              selectedFilePath={selectedFilePath}
              onToggleDirectory={onToggleDirectory}
              onSelectFile={onSelectFile}
            />
          ))}
        </ul>
      )}
    </li>
  );
}
