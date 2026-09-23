import type { RefObject } from 'react';
import type { PreviewRuntimeState } from '../../preview/runtime/usePreviewRuntime.ts';
import type { PreviewBuildState } from '../../preview/runtime/usePreviewCompiler.ts';
import { Button } from '../ui/button';

interface PreviewRuntimePanelProps {
  iframeRef: RefObject<HTMLIFrameElement | null>;
  state: PreviewRuntimeState;
  buildState: PreviewBuildState;
  onBuildAndRun: () => void;
  onReset: () => void;
  onRestartWorker: () => void;
  buildDisabled: boolean;
}

const STATUS_LABELS: Record<PreviewRuntimeState['status'], string> = {
  idle: 'Idle',
  initializing: 'Initializing',
  ready: 'Ready',
  running: 'Running',
  success: 'Success',
  error: 'Runtime Error',
};

export default function PreviewRuntimePanel({
  iframeRef,
  state,
  buildState,
  onBuildAndRun,
  onReset,
  onRestartWorker,
  buildDisabled,
}: PreviewRuntimePanelProps) {
  return (
    <section className="preview-runtime-panel" aria-label="Sandbox Runtime">
      <div className="preview-runtime-summary">
        <span className={`preview-build-status ${buildState.status}`}>
          Build: {buildState.status === 'error' ? 'Build Error' : buildState.status}
        </span>
        <span className={`preview-runtime-status ${state.status}`}>
          Runtime: {STATUS_LABELS[state.status]}
        </span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onBuildAndRun}
          disabled={buildDisabled}
        >
          Build &amp; Run
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onReset}
          disabled={state.status === 'idle'}
        >
          Reset Runtime
        </Button>
        {buildState.workerError && (
          <Button type="button" variant="destructive" size="sm" onClick={onRestartWorker}>
            Restart Worker
          </Button>
        )}
      </div>
      {(buildState.workerError || buildState.diagnostics.length > 0) && (
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
      {state.error && (
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
