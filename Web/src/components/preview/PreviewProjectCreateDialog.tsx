import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { FilePlus2, FolderPlus, X } from 'lucide-react';
import { PREVIEW_SUPPORTED_EXTENSIONS } from '../../preview/runtime/compiler/virtualFsPlugin';
import { Button } from '../ui/button';

interface PreviewProjectCreateDialogProps {
  open: boolean;
  baseDirectory: string;
  existingPaths: string[];
  onOpenChange: (open: boolean) => void;
  onCreateFile: (path: string) => string | null;
  onCreateFolder: (markerPath: string) => string | null;
}

function joinPath(directory: string, name: string): string {
  return directory === '/' ? `/${name}` : `${directory}/${name}`;
}

export default function PreviewProjectCreateDialog({
  open,
  baseDirectory,
  existingPaths,
  onOpenChange,
  onCreateFile,
  onCreateFolder,
}: PreviewProjectCreateDialogProps) {
  const [kind, setKind] = useState<'file' | 'folder'>('file');
  const [name, setName] = useState('');
  const [extension, setExtension] = useState<(typeof PREVIEW_SUPPORTED_EXTENSIONS)[number]>('.tsx');
  const [error, setError] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const onOpenChangeRef = useRef(onOpenChange);
  onOpenChangeRef.current = onOpenChange;
  const existing = useMemo(() => new Set(existingPaths.map((path) => path.toLowerCase())), [existingPaths]);

  useEffect(() => {
    if (!open) return;
    setKind('file');
    setName('');
    setError('');
    const timer = window.setTimeout(() => inputRef.current?.focus(), 0);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onOpenChangeRef.current(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [open, baseDirectory]);

  if (!open) return null;

  const trimmedName = name.trim();
  const invalidName = !trimmedName || trimmedName === '.' || trimmedName === '..' || /[\\/\0:*?"<>|\u0000-\u001f]/.test(trimmedName);
  const nameWithoutSupportedExtension = PREVIEW_SUPPORTED_EXTENSIONS.reduce((value, item) =>
    value.toLowerCase().endsWith(item) ? value.slice(0, -item.length) : value,
  trimmedName);
  const cleanName = kind === 'file'
    ? nameWithoutSupportedExtension
    : trimmedName;
  const itemPath = cleanName ? joinPath(baseDirectory, `${cleanName}${kind === 'file' ? extension : ''}`) : '';
  const markerPath = itemPath ? joinPath(itemPath, '.gor-folder') : '';
  const isDuplicate = itemPath && (
    existing.has(itemPath.toLowerCase()) ||
    existingPaths.some((path) => path.toLowerCase().startsWith(`${itemPath.toLowerCase()}/`)) ||
    (kind === 'folder' && existing.has(markerPath.toLowerCase()))
  );

  const submit = () => {
    if (invalidName) {
      setError('请输入有效名称；名称不能包含路径分隔符或系统保留字符。');
      return;
    }
    if (isDuplicate) {
      setError('同名文件或文件夹已存在，请更换名称。');
      return;
    }
    const result = kind === 'file' ? onCreateFile(itemPath) : onCreateFolder(markerPath);
    if (result) {
      setError(result);
      return;
    }
    onOpenChange(false);
  };

  const isLight = document.querySelector('.chat-page')?.classList.contains('theme-light') ?? false;
  return createPortal(
    <div className="preview-create-overlay" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onOpenChange(false);
    }}>
      <section className={`preview-create-dialog ${isLight ? 'theme-light' : ''}`} role="dialog" aria-modal="true" aria-labelledby="preview-create-title">
        <header className="preview-create-header">
          <span className="preview-create-heading-icon">{kind === 'file' ? <FilePlus2 size={18} /> : <FolderPlus size={18} />}</span>
          <div>
            <h2 id="preview-create-title">新建{kind === 'file' ? '文件' : '文件夹'}</h2>
            <p>创建位置：<code>{baseDirectory}</code></p>
          </div>
          <Button type="button" variant="ghost" size="icon" onClick={() => onOpenChange(false)} aria-label="关闭"><X size={17} /></Button>
        </header>
        <div className="preview-create-kind" role="tablist" aria-label="创建类型">
          <button type="button" className={kind === 'file' ? 'active' : ''} onClick={() => { setKind('file'); setError(''); }}><FilePlus2 size={15} />文件</button>
          <button type="button" className={kind === 'folder' ? 'active' : ''} onClick={() => { setKind('folder'); setError(''); }}><FolderPlus size={15} />文件夹</button>
        </div>
        <label className="preview-create-label" htmlFor="preview-create-name">{kind === 'file' ? '文件名' : '文件夹名称'}</label>
        <div className="preview-create-name-row">
          <input
            id="preview-create-name"
            ref={inputRef}
            value={name}
            onChange={(event) => { setName(event.target.value); setError(''); }}
            onKeyDown={(event) => { if (event.key === 'Enter') submit(); }}
            placeholder={kind === 'file' ? '例如：Component' : '例如：components'}
            autoComplete="off"
          />
          {kind === 'file' && (
            <select aria-label="文件扩展名" value={extension} onChange={(event) => setExtension(event.target.value as typeof extension)}>
              {PREVIEW_SUPPORTED_EXTENSIONS.map((item) => <option key={item} value={item}>{item}</option>)}
            </select>
          )}
        </div>
        <div className="preview-create-hint">
          {kind === 'file' ? <>支持扩展名：{PREVIEW_SUPPORTED_EXTENSIONS.map((item) => <code key={item}>{item}</code>)}</> : <>空文件夹会以项目内部标记保存，不会显示在目录树中。</>}
          <span>完整路径：{itemPath || joinPath(baseDirectory, '…')}{kind === 'folder' ? '/' : ''}</span>
        </div>
        {error && <div className="preview-create-error" role="alert">{error}</div>}
        <footer className="preview-create-footer">
          <Button type="button" variant="outline" size="sm" onClick={() => onOpenChange(false)}>取消</Button>
          <Button type="button" size="sm" onClick={submit}>创建</Button>
        </footer>
      </section>
    </div>,
    document.body,
  );
}
