import { useEffect, useMemo, useState } from 'react';
import { PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { buildFileTree } from '../../preview/core/fileTree';
import type { PreviewFiles } from '../../preview/core/types';
import PreviewFileTreeNode from './PreviewFileTreeNode';

interface PreviewFileTreeProps {
  files: PreviewFiles;
  selectedFilePath: string | null;
  onSelectFile: (path: string) => void;
}

export default function PreviewFileTree({
  files,
  selectedFilePath,
  onSelectFile,
}: PreviewFileTreeProps) {
  const tree = useMemo(() => buildFileTree(files), [files]);
  const directoryPaths = useMemo(() => {
    const paths: string[] = [];
    const visit = (nodes: ReturnType<typeof buildFileTree>) =>
      nodes.forEach((node) => {
        if (node.type === 'directory') {
          paths.push(node.path);
          visit(node.children ?? []);
        }
      });
    visit(tree);
    return paths;
  }, [tree]);
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(() => new Set(directoryPaths));
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    setExpandedPaths((current) => {
      const next = new Set(current);
      directoryPaths.forEach((path) => next.add(path));
      return next;
    });
  }, [directoryPaths]);

  const toggleDirectory = (path: string) => {
    setExpandedPaths((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  return (
    <nav
      className={`preview-file-tree ${collapsed ? 'is-collapsed' : ''}`}
      aria-label="Preview Project 文件树"
    >
      <button
        type="button"
        className="preview-sidebar-toggle"
        onClick={() => setCollapsed((value) => !value)}
        aria-label={collapsed ? '展开源码文件' : '收起源码文件'}
        title={collapsed ? '展开文件' : '收起文件'}
      >
        {collapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
      </button>
      {!collapsed && (
        <>
          <div className="preview-file-tree-label">Files</div>
          <ul>
            {tree.map((node) => (
              <PreviewFileTreeNode
                key={node.path}
                node={node}
                depth={0}
                expandedPaths={expandedPaths}
                selectedFilePath={selectedFilePath}
                onToggleDirectory={toggleDirectory}
                onSelectFile={onSelectFile}
              />
            ))}
          </ul>
        </>
      )}
    </nav>
  );
}
