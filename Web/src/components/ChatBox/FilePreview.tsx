import { useEffect, useMemo, useState } from 'react';
import type { GeneratedFile } from '../../types';
import { Button } from '../ui/button';
import GlbModelPreview from './GlbModelPreview';

type PreviewData =
  | {
      kind: 'word';
      blocks: Array<
        { type: 'paragraph'; text: string; style?: string } | { type: 'table'; rows: string[][] }
      >;
    }
  | { kind: 'excel'; sheets: Array<{ name: string; rows: string[][] }> }
  | { kind: 'ppt'; slides: Array<{ number: number; texts: string[] }> };

interface FilePreviewProps {
  file: GeneratedFile;
}

function filenameFromUrl(url: string): string {
  try {
    const pathname = new URL(url, window.location.origin).pathname;
    return decodeURIComponent(pathname.split('/').pop() || '');
  } catch {
    return '';
  }
}

function OfficePreview({ data }: { data: PreviewData }) {
  const [sheetIndex, setSheetIndex] = useState(0);
  useEffect(() => setSheetIndex(0), [data]);

  if (data.kind === 'word') {
    return (
      <div className="preview-document">
        <article className="preview-word-page">
          {data.blocks.map((block, index) =>
            block.type === 'paragraph' ? (
              <p
                key={index}
                className={block.style?.toLowerCase().includes('title') ? 'is-title' : ''}
              >
                {block.text}
              </p>
            ) : (
              <div className="preview-table-wrap" key={index}>
                <table>
                  <tbody>
                    {block.rows.map((row, rowIndex) => (
                      <tr key={rowIndex}>
                        {row.map((cell, cellIndex) => (
                          <td key={cellIndex}>{cell}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ),
          )}
        </article>
      </div>
    );
  }

  if (data.kind === 'excel') {
    const sheet = data.sheets[sheetIndex];
    return (
      <div className="preview-excel">
        <div className="preview-sheet-tabs">
          {data.sheets.map((item, index) => (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              key={item.name}
              className={index === sheetIndex ? 'active' : ''}
              onClick={() => setSheetIndex(index)}
            >
              {item.name}
            </Button>
          ))}
        </div>
        <div className="preview-table-wrap">
          {sheet ? (
            <table>
              <tbody>
                {sheet.rows.map((row, rowIndex) => (
                  <tr key={rowIndex}>
                    {row.map((cell, cellIndex) => (
                      <td key={cellIndex}>{cell}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="preview-empty">工作簿没有可显示的工作表</div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="preview-slides">
      {data.slides.map((slide) => (
        <article className="preview-slide" key={slide.number}>
          <span className="preview-slide-number">{slide.number}</span>
          <div>
            {slide.texts.length ? (
              slide.texts.map((text, index) => <p key={index}>{text}</p>)
            ) : (
              <p className="preview-empty">空白幻灯片</p>
            )}
          </div>
        </article>
      ))}
    </div>
  );
}

export default function FilePreview({ file }: FilePreviewProps) {
  const [data, setData] = useState<PreviewData | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const filename = useMemo(() => filenameFromUrl(file.downloadUrl), [file.downloadUrl]);
  const extension =
    file.displayName.split('.').pop()?.toLowerCase() || filename.split('.').pop()?.toLowerCase();
  const isOffice = ['docx', 'xlsx', 'pptx'].includes(extension || '');
  const isInline =
    ['html', 'htm', 'pdf'].includes(extension || '') ||
    ['3d', 'html', 'react', 'vue', 'pdf'].includes(file.fileType);

  useEffect(() => {
    setData(null);
    setError('');
    if (!isOffice || !filename) return;
    const controller = new AbortController();
    setLoading(true);
    fetch(`/api/preview/${encodeURIComponent(filename)}`, { signal: controller.signal })
      .then(async (response) => {
        const payload = await response.json();
        if (!response.ok || !payload.success) throw new Error(payload.detail || '文件预览加载失败');
        setData(payload as PreviewData);
      })
      .catch((reason) => {
        if (reason.name !== 'AbortError') setError(reason.message || '文件预览加载失败');
      })
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, [filename, isOffice]);

  if (loading)
    return (
      <div className="preview-state">
        <span className="loading-spinner" />
        正在解析文件…
      </div>
    );
  if (error)
    return (
      <div className="preview-state is-error">
        <strong>无法预览此文件</strong>
        <span>{error}</span>
      </div>
    );
  if (data) return <OfficePreview data={data} />;
  if (extension === 'glb') return <GlbModelPreview file={file} />;
  if (isInline) {
    const src =
      extension === 'pdf'
        ? `${file.downloadUrl}${file.downloadUrl.includes('?') ? '&' : '?'}inline=true`
        : file.downloadUrl;
    return (
      <iframe
        key={src}
        src={src}
        title={file.displayName}
        className="preview-worker-frame"
        sandbox={extension === 'pdf' ? undefined : 'allow-scripts allow-pointer-lock'}
      />
    );
  }
  return (
    <div className="preview-state">
      <strong>此格式暂不支持在线浏览</strong>
      <span>可以使用右上角的下载按钮在本机打开。</span>
    </div>
  );
}
