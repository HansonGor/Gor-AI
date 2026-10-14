import { useEffect, useState } from 'react';
import { Diff, Hunk, Decoration } from 'react-diff-view';
import { ChevronDown } from 'lucide-react';
import { changeMarker } from './diffPresentation';
import type { PresentedDiff } from './diffPresentation';
import 'react-diff-view/style/index.css';
import './CodeDiff.less';
import { highlightDiff } from './codeHighlight/diffTokens';
import type { HunkTokens } from 'react-diff-view';

/** Shared by Web and Webview; no project lookup, filesystem or runtime side effects. */
export default function CodeDiff({
  path,
  raw,
  model,
  viewType,
}: {
  path: string;
  raw: string;
  model: PresentedDiff | null;
  viewType: 'unified' | 'split';
}) {
  // Remount when raw changes via the caller key, so fold state cannot leak revisions.
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [colored, setColored] = useState<{
    path: string;
    raw: string;
    tokens: HunkTokens | null;
  }>();
  useEffect(() => {
    let cancelled = false;
    void highlightDiff(model, path).then((tokens) => {
      if (!cancelled) setColored({ path, raw, tokens });
    });
    return () => {
      cancelled = true;
    };
  }, [model, path, raw]);
  if (!model) return <pre className="code-diff-raw">{raw}</pre>;
  const hunks = model.sections.flatMap((s) =>
    s.kind === 'hunk' ? [s.hunk] : s.hunk && expanded.has(s.key) ? [s.hunk] : [],
  );
  return (
    <section className="code-diff" aria-label={`${path} 代码变更`}>
      <div className="code-diff-body">
        {viewType === 'split' && (
          <div className="code-diff-side-labels">
            <span>原文件 (before)</span>
            <span>新文件 (after)</span>
          </div>
        )}
        <Diff
          viewType={viewType}
          diffType={viewType === 'split' ? 'modify' : model.type}
          hunks={hunks}
          tokens={colored?.path === path && colored.raw === raw ? colored.tokens : null}
          renderToken={(token, renderDefault, index) =>
            token.type === 'shiki' ? (
              <span key={index} style={{ color: token.color }}>
                {token.value}
              </span>
            ) : (
              renderDefault(token, index)
            )
          }
          renderGutter={({ change, side }) =>
            viewType === 'unified' && side === 'old' ? null : (
              <span className="code-diff-gutter">
                <span>
                  {change.type === 'normal'
                    ? side === 'old'
                      ? change.oldLineNumber
                      : change.newLineNumber
                    : change.lineNumber}
                </span>
                <span aria-hidden="true">{changeMarker(change)}</span>
              </span>
            )
          }
        >
          {() =>
            model.sections
              .map((s) => {
                if (s.kind === 'hunk') return <Hunk key={s.key} hunk={s.hunk} />;
                const open = expanded.has(s.key);
                return (
                  <Decoration key={s.key}>
                    <div className="code-diff-fold">
                      {s.hunk ? (
                        <>
                          <button
                            type="button"
                            aria-expanded={open}
                            onClick={() =>
                              setExpanded((previous) => {
                                const next = new Set(previous);
                                if (next.has(s.key)) next.delete(s.key);
                                else next.add(s.key);
                                return next;
                              })
                            }
                          >
                            {open ? `收起 ${s.count} 行` : `··· 省略 ${s.count} 行`}
                            <ChevronDown
                              size={14}
                              className={open ? 'is-expanded' : ''}
                              aria-hidden="true"
                            />
                          </button>
                        </>
                      ) : (
                        <span title="原始 Diff 未提供这些行的源码">
                          ··· 省略 {s.count} 行
                          <span className="code-diff-unavailable">（未随 Diff 提供）</span>
                        </span>
                      )}
                    </div>
                  </Decoration>
                );
              })
              .flatMap((element, i) => {
                const s = model.sections[i];
                return s.kind === 'gap' && s.hunk && expanded.has(s.key)
                  ? [element, <Hunk key={`${s.key}-expanded`} hunk={s.hunk} />]
                  : [element];
              })
          }
        </Diff>
      </div>
    </section>
  );
}
