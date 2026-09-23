import { useState } from 'react';
import {
  Box,
  Download,
  FileCode2,
  FileSpreadsheet,
  FileText,
  Globe2,
  PanelLeftClose,
  PanelLeftOpen,
  Presentation,
  X,
} from 'lucide-react';
import FilePreview from './FilePreview';
import PreviewProject from '../preview/PreviewProject';
import type { GeneratedFile } from '../../types';
import { Button } from '../ui/button';
import { Tabs, TabsList, TabsTrigger } from '../ui/tabs';
import { usePreviewProjectStore } from '../../stores/previewProjectStore';

export type PreviewWorkerMode = 'preview' | 'code';
export type PreviewWorkerTarget = 'project' | 'generated';

interface PreviewWorkerProps {
  files: GeneratedFile[];
  activeFile: GeneratedFile | null;
  mode: PreviewWorkerMode;
  target: PreviewWorkerTarget;
  onModeChange: (mode: PreviewWorkerMode) => void;
  onTargetChange: (target: PreviewWorkerTarget) => void;
  onSelect: (file: GeneratedFile) => void;
  onClose: () => void;
}

function FileTypeIcon({ type }: { type: string }) {
  if (type === 'word' || type === 'pdf') return <FileText aria-hidden="true" />;
  if (type === 'excel') return <FileSpreadsheet aria-hidden="true" />;
  if (type === 'ppt') return <Presentation aria-hidden="true" />;
  if (type === '3d') return <Box aria-hidden="true" />;
  return <Globe2 aria-hidden="true" />;
}

function toPreviewFileName(project: { name: string; files: Record<string, string> }): string {
  const appSource = Object.entries(project.files).find(([path]) =>
    /\/src\/App\.[jt]sx?$/.test(path),
  )?.[1];
  const indexSource = project.files['/index.html'];
  const projectSource = Object.values(project.files).join('\n');
  const headingSource = appSource?.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1];
  const city = projectSource.match(/\bcity\s*[:=]\s*['"`]([^'"`]+)['"`]/i)?.[1]?.trim();
  const namedCity = projectSource.match(
    /广州|北京|上海|深圳|杭州|成都|重庆|武汉|南京|西安|天津|苏州|长沙|郑州|青岛|厦门|福州|昆明|贵阳|哈尔滨|沈阳|大连/u,
  )?.[0];
  const headingUsesCity = /\{[^}]*\.city[^}]*\}/i.test(headingSource ?? '');
  const hasWeatherContent = /天气|weather|气象|预报/i.test(projectSource);
  const inferredHeading =
    (city || namedCity) && (headingUsesCity || hasWeatherContent)
      ? `${city || namedCity}${hasWeatherContent ? '天气' : ''}`
      : headingSource;
  const candidates = [
    inferredHeading,
    indexSource?.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1],
    project.name,
  ];
  const title = candidates
    .map((value) =>
      value
        ?.replace(/<[^>]+>/g, '')
        .replace(/&[^;]+;/g, ' ')
        .trim(),
    )
    .find((value) => value && !/^gor (react )?preview$/i.test(value));
  const conciseTitle = (title ?? project.name)
    .split(/[·|｜—–-]/)[0]
    .trim()
    .slice(0, 24);
  return `${conciseTitle || 'Preview'}.html`;
}

export default function PreviewWorker({
  files,
  activeFile,
  mode,
  target,
  onModeChange,
  onTargetChange,
  onSelect,
  onClose,
}: PreviewWorkerProps) {
  const project = usePreviewProjectStore().project;
  const projectFileName = toPreviewFileName(project);
  const [previewSidebarCollapsed, setPreviewSidebarCollapsed] = useState(false);
  const showGenerated =
    mode === 'preview' && target === 'generated' && files.length > 0 && activeFile !== null;
  return (
    <section className="preview-worker" aria-label="Preview Worker 文件预览">
      <div className="preview-worker-tabsbar">
        <Tabs
          value={mode}
          onValueChange={(value) => onModeChange(value as PreviewWorkerMode)}
          className="contents"
        >
          <TabsList className="preview-worker-modes h-auto rounded-none" aria-label="预览模式">
            <TabsTrigger value="preview">Preview</TabsTrigger>
            <TabsTrigger value="code">Code</TabsTrigger>
          </TabsList>
        </Tabs>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="preview-worker-close"
          onClick={onClose}
          aria-label="关闭 Preview Worker"
          title="关闭预览"
        >
          <X size={18} />
        </Button>
      </div>
      {mode === 'preview' && (
        <div className="preview-worker-preview-body">
          <nav
            className={`preview-worker-files ${previewSidebarCollapsed ? 'is-collapsed' : ''}`}
            aria-label="预览文件列表"
          >
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="preview-sidebar-toggle"
              onClick={() => setPreviewSidebarCollapsed((value) => !value)}
              aria-label={previewSidebarCollapsed ? '展开预览文件' : '收起预览文件'}
              title={previewSidebarCollapsed ? '展开文件' : '收起文件'}
            >
              {previewSidebarCollapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
            </Button>
            {!previewSidebarCollapsed && (
              <>
                <div className="preview-file-tree-label">Preview files</div>
                <Button
                  type="button"
                  variant="ghost"
                  className={target === 'project' ? 'active' : ''}
                  onClick={() => onTargetChange('project')}
                  title={projectFileName}
                >
                  <FileCode2 aria-hidden="true" />
                  <span className="preview-worker-file-name">{projectFileName}</span>
                </Button>
                {files.map((file) => (
                  <Button
                    type="button"
                    variant="ghost"
                    key={file.downloadUrl}
                    className={
                      target === 'generated' && activeFile?.downloadUrl === file.downloadUrl
                        ? 'active'
                        : ''
                    }
                    onClick={() => onSelect(file)}
                    title={file.displayName}
                  >
                    <FileTypeIcon type={file.fileType} />
                    <span className="preview-worker-file-name">{file.displayName}</span>
                  </Button>
                ))}
              </>
            )}
          </nav>
          {showGenerated && activeFile ? (
            <div className="preview-worker-content">
              <div className="preview-worker-file-title">
                <span>{activeFile.displayName}</span>
                <a
                  href={activeFile.downloadUrl}
                  download={activeFile.displayName}
                  title="下载文件"
                  aria-label={`下载 ${activeFile.displayName}`}
                >
                  <Download size={16} />
                </a>
              </div>
              <FilePreview file={activeFile} />
            </div>
          ) : (
            <div className="preview-worker-project">
              <PreviewProject view="preview" />
            </div>
          )}
        </div>
      )}
      {mode === 'code' && <PreviewProject view="code" />}
    </section>
  );
}
