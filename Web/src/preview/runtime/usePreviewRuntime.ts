import { useCallback, useEffect, useRef, useState } from 'react';
import type { PreviewBuildResult } from './workerProtocol.ts';
import type { RuntimeConsoleEntry, RuntimeDiagnostic, RuntimeToParentMessage } from './runtimeProtocol.ts';
import { PreviewRuntimeController } from './runtimeController.ts';

export interface PreviewRuntimeState {
  status: 'idle' | 'initializing' | 'ready' | 'running' | 'success' | 'error';
  runtimeId: string | null;
  error: RuntimeDiagnostic | null;
  consoleEntries: RuntimeConsoleEntry[];
}

const INITIAL_STATE: PreviewRuntimeState = { status: 'idle', runtimeId: null, error: null, consoleEntries: [] };

export function usePreviewRuntime(projectId: string) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const controllerRef = useRef<PreviewRuntimeController | null>(null);
  const [state, setState] = useState<PreviewRuntimeState>(INITIAL_STATE);

  const handleEvent = useCallback((message: RuntimeToParentMessage) => {
    if (message.type === 'RUNTIME_READY') setState((current) => ({ ...current, status: 'ready' }));
    if (message.type === 'RUNTIME_STARTED') setState((current) => ({ ...current, status: 'running' }));
    if (message.type === 'RUNTIME_SUCCESS') setState((current) => ({ ...current, status: 'success' }));
    if (message.type === 'RUNTIME_ERROR') setState((current) => ({ ...current, status: 'error', error: message.error }));
    if (message.type === 'RUNTIME_CONSOLE') setState((current) => ({ ...current, consoleEntries: [...current.consoleEntries, message.entry].slice(-50) }));
  }, []);

  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;
    const controller = new PreviewRuntimeController({ iframe, runtimeUrl: `${import.meta.env.BASE_URL}preview-runtime.html`, onEvent: handleEvent });
    controllerRef.current = controller;
    return () => { controller.dispose(); controllerRef.current = null; };
  }, [handleEvent]);

  useEffect(() => {
    controllerRef.current?.reset();
    setState(INITIAL_STATE);
  }, [projectId]);

  const run = useCallback((result: PreviewBuildResult) => {
    if (result.projectId !== projectId) return;
    try {
      const runtimeId = controllerRef.current?.run(result);
      if (!runtimeId) throw new Error('Preview Runtime is not ready.');
      setState({ status: 'initializing', runtimeId, error: null, consoleEntries: [] });
    } catch (error) {
      setState({ status: 'error', runtimeId: null, error: { runtimeId: '', projectId, buildId: result.buildId, message: error instanceof Error ? error.message : String(error), source: null, line: null, column: null, stack: null }, consoleEntries: [] });
    }
  }, [projectId]);

  const reset = useCallback(() => { controllerRef.current?.reset(); setState(INITIAL_STATE); }, []);
  return { iframeRef, state, run, reset };
}
