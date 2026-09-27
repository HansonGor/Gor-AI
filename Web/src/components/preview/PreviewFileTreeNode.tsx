import { ChevronDown, ChevronRight, Download, FileCode2, Folder, FolderOpen, Plus, Trash2 } from 'lucide-react';
import type { FileTreeNode } from '../../preview/core/types';
import { Button } from '../ui/button';

interface PreviewFileTreeNodeProps {
  node: FileTreeNode;
  depth: number;
  expandedPaths: ReadonlySet<string>;
  selectedFilePath: string | null;
  onToggleDirectory: (path: string) => void;
  onSelectFile: (path: string) => void;
  onDownloadFile: (path: string) => void;
  onCreateInDirectory: (directory: string) => void;
  onRequestDelete: (node: FileTreeNode) => void;
}

export default function PreviewFileTreeNode({
  node,
  depth,
  expandedPaths,
  selectedFilePath,
  onToggleDirectory,
  onSelectFile,
  onDownloadFile,
  onCreateInDirectory,
  onRequestDelete,
}: PreviewFileTreeNodeProps) {
  const isDirectory = node.type === 'directory';
  const expanded = isDirectory && expandedPaths.has(node.path);

  return (
    <li className="preview-tree-node">
      <div className="preview-tree-row">
        <Button
          type="button"
          variant="ghost"
          className={`preview-tree-select ${node.path === selectedFilePath ? 'active' : ''}`}
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
        {!isDirectory && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="preview-tree-download"
            onClick={() => onDownloadFile(node.path)}
            title={`下载 ${node.path}`}
            aria-label={`下载 ${node.path}`}
          >
            <Download size={13} />
          </Button>
        )}
        {isDirectory && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="preview-tree-create"
            onClick={(event) => { event.stopPropagation(); onCreateInDirectory(node.path); }}
            title={`在 ${node.path} 下新建`}
            aria-label={`在 ${node.path} 下新建`}
          >
            <Plus size={14} />
          </Button>
        )}
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="preview-tree-delete"
          onClick={(event) => { event.stopPropagation(); onRequestDelete(node); }}
          title={`删除 ${node.path}`}
          aria-label={`删除 ${node.path}`}
        >
          <Trash2 size={13} />
        </Button>
      </div>
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
              onDownloadFile={onDownloadFile}
              onCreateInDirectory={onCreateInDirectory}
              onRequestDelete={onRequestDelete}
            />
          ))}
        </ul>
      )}
    </li>
  );
}
