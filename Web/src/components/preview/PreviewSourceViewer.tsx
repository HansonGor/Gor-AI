interface PreviewSourceViewerProps {
  path: string | null;
  source: string | undefined;
  onChange: (source: string) => void;
}

export default function PreviewSourceViewer({ path, source, onChange }: PreviewSourceViewerProps) {
  if (!path || source === undefined) {
    return <div className="preview-source-empty">选择一个文件查看源码</div>;
  }

  return (
    <section className="preview-source-viewer" aria-label="源码查看器">
      <div className="preview-source-path">{path}</div>
      <Textarea
        aria-label={`${path} 源码`}
        value={source}
        onChange={(event) => onChange(event.target.value)}
        spellCheck={false}
      />
    </section>
  );
}
import { Textarea } from '../ui/textarea';
