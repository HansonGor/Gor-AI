import type { RefObject } from 'react';
import { createPortal } from 'react-dom';
import { Play } from 'lucide-react';
import type { PreviewRuntimeState } from '../../preview/runtime/usePreviewRuntime.ts';
import type { PreviewBuildState } from '../../preview/runtime/usePreviewCompiler.ts';
import { Button } from '../ui/button';

interface PreviewRuntimePanelProps {
  iframeRef: RefObject<HTMLIFrameElement | null>;
  state: PreviewRuntimeState;
  buildState: PreviewBuildState;
  onBuildAndRun: () => void;
  isSavingGlb?: boolean;
  buildDisabled: boolean;
  actionsHost?: HTMLElement | null;
  sourcePending?: boolean;
}

export default function PreviewRuntimePanel({
  iframeRef,
  state,
  buildState,
  onBuildAndRun,
  isSavingGlb = false,
  buildDisabled,
  actionsHost,
  sourcePending = false,
}: PreviewRuntimePanelProps) {
  const toolbarActions = (
    <div className="preview-runtime-summary preview-runtime-toolbar">
      <span
        className={`preview-build-status ${sourcePending ? 'ready' : buildState.status}`}
        title={sourcePending ? '等待项目源码' : `Build: ${buildState.status === 'error' ? 'Build Error' : buildState.status}`}
      >
        {sourcePending ? '等待源码' : `Build: ${buildState.status === 'error' ? 'Error' : buildState.status}`}
      </span>
      <Button type="button" variant="outline" size="sm" onClick={onBuildAndRun} disabled={buildDisabled || isSavingGlb} title={isSavingGlb ? '正在生成并保存 GLB…' : '构建并运行当前项目'}>
        {!isSavingGlb && <Play size={12} aria-hidden="true" />}
        {isSavingGlb ? '正在生成 GLB…' : 'Build & Run'}
      </Button>
    </div>
  );
  return (
    <section className="preview-runtime-panel" aria-label="Sandbox Runtime">
      {actionsHost ? createPortal(toolbarActions, actionsHost) : toolbarActions}
      {!sourcePending && (buildState.workerError || buildState.diagnostics.length > 0) && (
        <div className="preview-runtime-build-error" role="alert">
          {buildState.workerError && <strong>{buildState.workerError}</strong>}
          {buildState.diagnostics.map((diagnostic, index) => (
            <article key={`${diagnostic.file}-${diagnostic.line}-${index}`}>
              <span>
                {diagnostic.file ?? 'Build'}
                {diagnostic.line !== null ? ` · Line ${diagnostic.line}` : ''}
                {diagnostic.column !== null ? `, Column ${diagnostic.column}` : ''}
              </span>
              <strong>{diagnostic.message}</strong>
              {diagnostic.lineText && <pre>{diagnostic.lineText}</pre>}
            </article>
          ))}
        </div>
      )}
      {!sourcePending && state.error && (
        <div className="preview-runtime-error" role="alert">
          <strong>{state.error.message}</strong>
          <span>
            {state.error.source ?? 'Runtime'}
            {state.error.line !== null ? ` · Line ${state.error.line}` : ''}
            {state.error.column !== null ? `, Column ${state.error.column}` : ''}
          </span>
          {state.error.stack && <pre>{state.error.stack}</pre>}
        </div>
      )}
      {state.consoleEntries.length > 0 && (
        <div className="preview-runtime-console" aria-label="Runtime Console">
          {state.consoleEntries.map((entry, index) => (
            <div key={`${entry.timestamp}-${index}`} className={entry.level}>
              <strong>{entry.level}</strong>
              <span>{entry.args.join(' ')}</span>
            </div>
          ))}
        </div>
      )}
      <iframe ref={iframeRef} title="Sandboxed Project Preview" sandbox="allow-scripts" />
    </section>
  );
}
