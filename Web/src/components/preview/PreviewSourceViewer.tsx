import { useEffect, useRef, useState } from 'react';
import { highlightCode } from '../chat/codeHighlight/client';
import { codeLanguageFromPath, type CodeTokens } from '../chat/codeHighlight/languages';
import './PreviewSourceViewer.less';

interface PreviewSourceViewerProps {
  path: string | null;
  source: string | undefined;
  onChange: (source: string) => void;
}

export default function PreviewSourceViewer({ path, source, onChange }: PreviewSourceViewerProps) {
  const lineNumbersRef = useRef<HTMLPreElement>(null);
  const colorsRef = useRef<HTMLPreElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [colored, setColored] = useState<{
    path: string;
    source: string;
    tokens: CodeTokens | null;
  }>();
  useEffect(() => {
    if (!path || source === undefined) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      void highlightCode(source, codeLanguageFromPath(path) ?? undefined).then((tokens) => {
        if (!cancelled) setColored({ path, source, tokens });
      });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [path, source]);
  const tokens = colored?.path === path && colored.source === source ? colored.tokens : null;
  const syncScroll = () => {
    const editor = textareaRef.current;
    if (!editor) return;
    if (lineNumbersRef.current) lineNumbersRef.current.scrollTop = editor.scrollTop;
    if (colorsRef.current) {
      colorsRef.current.scrollTop = editor.scrollTop;
      colorsRef.current.scrollLeft = editor.scrollLeft;
    }
  };
  useEffect(syncScroll, [tokens]);
  if (!path || source === undefined) {
    return <div className="preview-source-empty">选择一个文件查看源码</div>;
  }

  const lines = source.split('\n');

  return (
    <section className="preview-source-viewer" aria-label="源码查看器">
      <div className="preview-source-path">{path}</div>
      <div className="preview-source-editor">
        <pre ref={lineNumbersRef} className="preview-source-line-numbers" aria-hidden="true">
          {lines.map((_, index) => (
            <span key={index}>{index + 1}</span>
          ))}
        </pre>
        {tokens && (
          <pre ref={colorsRef} className="preview-source-colors" aria-hidden="true">
            {tokens.map((line, row) => (
              <span key={row}>
                {row > 0 ? '\n' : null}
                {line.map((token, column) => (
                  <span key={column} style={{ color: token.color }}>
                    {token.content}
                  </span>
                ))}
              </span>
            ))}
            {'\u200b'}
          </pre>
        )}
        <Textarea
          ref={textareaRef}
          className={tokens ? 'is-syntax-highlighted' : undefined}
          aria-label={`${path} 源码`}
          value={source}
          onChange={(event) => onChange(event.target.value)}
          onScroll={syncScroll}
          spellCheck={false}
        />
      </div>
    </section>
  );
}
import { Textarea } from '../ui/textarea';
