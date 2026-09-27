import { useEffect, useMemo, useState } from 'react';
import { PanelLeftClose, PanelLeftOpen, Plus } from 'lucide-react';
import { buildFileTree } from '../../preview/core/fileTree';
import type { PreviewFiles } from '../../preview/core/types';
import type { FileTreeNode } from '../../preview/core/types';
import PreviewFileTreeNode from './PreviewFileTreeNode';
import { Button } from '../ui/button';
import { isSceneRendererProject } from '../../modeling/sceneSpec';

interface PreviewFileTreeProps {
  files: PreviewFiles;
  selectedFilePath: string | null;
  onSelectFile: (path: string) => void;
  onDownloadFile: (path: string) => void;
  onCreateInDirectory: (directory: string) => void;
  onRequestDelete: (node: FileTreeNode) => void;
}

export default function PreviewFileTree({
  files,
  selectedFilePath,
  onSelectFile,
  onDownloadFile,
  onCreateInDirectory,
  onRequestDelete,
}: PreviewFileTreeProps) {
  const tree = useMemo(() => {
    const sceneInfrastructurePaths = new Set([
      '/src/App.tsx',
      '/src/main.tsx',
      '/src/style.css',
    ]);
    const visibleFiles = !isSceneRendererProject(files)
      ? files
      : Object.fromEntries(Object.entries(files).filter(([path]) => !sceneInfrastructurePaths.has(path)));
    const hideFolderMarker = (nodes: ReturnType<typeof buildFileTree>): ReturnType<typeof buildFileTree> =>
      nodes
        .filter((node) => !(node.type === 'file' && node.name === '.gor-folder'))
        .map((node) => node.type === 'directory'
          ? { ...node, children: hideFolderMarker(node.children ?? []) }
          : node);
    return hideFolderMarker(buildFileTree(visibleFiles));
  }, [files]);
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
          <div className="preview-file-tree-heading">
            <div className="preview-file-tree-label">Files</div>
            <Button type="button" variant="ghost" size="icon" className="preview-file-tree-create" onClick={() => onCreateInDirectory('/')} title="在项目根目录新建" aria-label="在项目根目录新建">
              <Plus size={15} />
            </Button>
          </div>
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
                onDownloadFile={onDownloadFile}
                onCreateInDirectory={onCreateInDirectory}
                onRequestDelete={onRequestDelete}
              />
            ))}
          </ul>
        </>
      )}
    </nav>
  );
}
