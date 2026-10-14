import {
  Children,
  isValidElement,
  memo,
  useEffect,
  useRef,
  useState,
  type ReactElement,
} from 'react';
import { Check, Copy } from 'lucide-react';
import type { Components } from 'react-markdown';
import { highlightCode } from './codeHighlight/client';
import { codeLanguageLabel, type CodeTokens } from './codeHighlight/languages';
import './MarkdownCodeBlock.less';

export const MarkdownCodeBlock = memo(function MarkdownCodeBlock({
  code,
  language,
  streaming = false,
  share = false,
}: {
  code: string;
  language?: string;
  streaming?: boolean;
  share?: boolean;
}) {
  const [highlighted, setHighlighted] = useState<{
    code: string;
    language?: string;
    tokens: CodeTokens | null;
  }>();
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      clearTimeout(copyTimer.current);
    };
  }, []);
  useEffect(() => {
    let cancelled = false;
    const update = () => {
      void highlightCode(code, language).then((tokens) => {
        if (!cancelled) setHighlighted({ code, language, tokens });
      });
    };
    // A quiet window avoids re-tokenizing every SSE delta. Current text is always visible.
    const timer = streaming ? setTimeout(update, 250) : undefined;
    if (!streaming) update();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [code, language, streaming]);
  const current = highlighted?.code === code && highlighted.language === language;
  const tokens = current ? highlighted.tokens : null;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      if (alive.current) setCopyState('copied');
    } catch {
      if (alive.current) setCopyState('failed');
    }
    if (alive.current) {
      clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopyState('idle'), 1800);
    }
  };
  return (
    <div
      className={`gor-code-block${share ? ' gor-code-block-share' : ''}`}
      data-code-status={current ? 'ready' : 'pending'}
    >
      <div className="gor-code-block-header">
        <span>{codeLanguageLabel(language)}</span>
        {!share && (
          <button
            type="button"
            onClick={copy}
            aria-label={copyState === 'copied' ? '已复制代码' : '复制代码'}
          >
            {copyState === 'copied' ? <Check size={14} /> : <Copy size={14} />}
            <span aria-live="polite">
              {copyState === 'copied' ? '已复制' : copyState === 'failed' ? '复制失败' : '复制'}
            </span>
          </button>
        )}
      </div>
      <pre className="gor-code-block-body">
        <code>
          {tokens
            ? tokens.map((line, row) => (
                <span key={row}>
                  {row > 0 ? '\n' : null}
                  {line.map((token, column) => (
                    <span
                      key={column}
                      style={{
                        color: token.color,
                        fontStyle: token.fontStyle && token.fontStyle & 1 ? 'italic' : undefined,
                        fontWeight: token.fontStyle && token.fontStyle & 2 ? 600 : undefined,
                        textDecoration:
                          token.fontStyle && token.fontStyle & 4 ? 'underline' : undefined,
                      }}
                    >
                      {token.content}
                    </span>
                  ))}
                </span>
              ))
            : code}
        </code>
      </pre>
    </div>
  );
});

export function markdownCodeComponents(
  options: { streaming?: boolean; share?: boolean } = {},
): Components {
  return {
    pre: ({ children }) => {
      const child = Children.toArray(children)[0];
      if (!isValidElement(child)) return <pre>{children}</pre>;
      const props = (child as ReactElement<{ children?: string; className?: string }>).props;
      const language = /(?:^|\s)language-([^\s]+)/.exec(props.className ?? '')?.[1];
      return (
        <MarkdownCodeBlock code={String(props.children ?? '')} language={language} {...options} />
      );
    },
  };
}
export const shareCodeComponents = markdownCodeComponents({ share: true });
