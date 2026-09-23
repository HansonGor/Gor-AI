import type { PreviewBuildState } from '../../preview/runtime/usePreviewCompiler.ts';

interface PreviewBuildPanelProps {
  state: PreviewBuildState;
  onBuild: () => void;
  onRestartWorker: () => void;
}

const STATUS_LABELS: Record<PreviewBuildState['status'], string> = {
  initializing: 'Initializing',
  ready: 'Ready',
  building: 'Building',
  success: 'Success',
  error: 'Error',
};

export default function PreviewBuildPanel({ state, onBuild, onRestartWorker }: PreviewBuildPanelProps) {
  const canBuild = state.status !== 'initializing' && state.status !== 'building';
  return <section className="preview-build-panel" aria-label="Preview Project 编译状态">
    <div className="preview-build-summary">
      <span className={`preview-build-status ${state.status}`}>{STATUS_LABELS[state.status]}</span>
      <button type="button" onClick={onBuild} disabled={!canBuild}>Build</button>
      {state.workerError && <button type="button" onClick={onRestartWorker}>Restart Worker</button>}
    </div>
    {state.result && <div className="preview-build-result">
      <div><strong>Build ID</strong><span>{state.result.buildId}</span></div>
      <div><strong>Entry</strong><span>{state.result.entryPoint}</span></div>
      <div><strong>Duration</strong><span>{state.result.duration.toFixed(1)} ms</span></div>
      <div><strong>Warnings</strong><span>{state.result.warnings.length}</span></div>
      <ul>{state.result.outputFiles.map((file) => <li key={file.path}>
        <span className={`preview-output-type ${file.type}`}>{file.type.toUpperCase()}</span>
        <span>{file.path}</span>
        <span>{file.contents.length.toLocaleString()} chars</span>
      </li>)}</ul>
    </div>}
    {state.workerError && <div className="preview-build-worker-error" role="alert">{state.workerError}</div>}
    {state.diagnostics.length > 0 && <div className="preview-build-diagnostics" role="alert">
      {state.diagnostics.map((diagnostic, index) => <article key={`${diagnostic.file}-${diagnostic.line}-${index}`}>
        <div>{diagnostic.file ?? 'Build'}{diagnostic.line !== null ? ` · Line ${diagnostic.line}` : ''}{diagnostic.column !== null ? `, Column ${diagnostic.column}` : ''}</div>
        <strong>{diagnostic.message}</strong>
        {diagnostic.lineText && <pre>{diagnostic.lineText}</pre>}
      </article>)}
    </div>}
  </section>;
}
