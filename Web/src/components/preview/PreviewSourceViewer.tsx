interface PreviewSourceViewerProps {
  path: string | null;
  source: string | undefined;
  onChange: (source: string) => void;
}

export default function PreviewSourceViewer({ path, source, onChange }: PreviewSourceViewerProps) {
  if (!path || source === undefined) {
    return <div className="preview-source-empty">选择一个文件查看源码</div>;
  }

  const lines = source.split('\n');

  return (
    <section className="preview-source-viewer" aria-label="源码查看器">
      <div className="preview-source-path">{path}</div>
      <div className="preview-source-editor">
        <pre className="preview-source-line-numbers" aria-hidden="true">
          {lines.map((_, index) => <span key={index}>{index + 1}</span>)}
        </pre>
        <Textarea
          aria-label={`${path} 源码`}
          value={source}
          onChange={(event) => onChange(event.target.value)}
          onScroll={(event) => {
            const lineNumbers = event.currentTarget.previousElementSibling;
            if (lineNumbers instanceof HTMLElement) lineNumbers.scrollTop = event.currentTarget.scrollTop;
          }}
          spellCheck={false}
        />
      </div>
    </section>
  );
}
import { Textarea } from '../ui/textarea';
