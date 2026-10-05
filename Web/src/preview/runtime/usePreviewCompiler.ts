import { useCallback, useEffect, useRef, useState } from 'react';
import type { PreviewFiles } from '../core/types.ts';
import type { BuildDiagnostic, PreviewBuildResult } from './workerProtocol.ts';
import {
  PreviewBuildError,
  PreviewWorkerClient,
  StalePreviewBuildError,
} from './previewWorkerClient.ts';

export type PreviewBuildStatus = 'initializing' | 'ready' | 'building' | 'success' | 'error';

export interface PreviewBuildState {
  status: PreviewBuildStatus;
  result: PreviewBuildResult | null;
  diagnostics: BuildDiagnostic[];
  workerError: string | null;
}

const INITIAL_STATE: PreviewBuildState = {
  status: 'initializing',
  result: null,
  diagnostics: [],
  workerError: null,
};

export function usePreviewCompiler(projectId: string, files: PreviewFiles, revision = 0) {
  const clientRef = useRef<PreviewWorkerClient | null>(null);
  const lifecycleGenerationRef = useRef(0);
  const buildGenerationRef = useRef(0);
  const buildCallsRef = useRef(0);
  const [state, setState] = useState<PreviewBuildState>(INITIAL_STATE);

  const startWorker = useCallback(() => {
    const generation = ++lifecycleGenerationRef.current;
    buildGenerationRef.current += 1;
    clientRef.current?.dispose();
    const client = new PreviewWorkerClient();
    clientRef.current = client;
    setState(INITIAL_STATE);
    void client.initialize().then(() => {
      if (generation === lifecycleGenerationRef.current) {
        setState({ status: 'ready', result: null, diagnostics: [], workerError: null });
      }
    }).catch((error: unknown) => {
      if (generation === lifecycleGenerationRef.current) {
        setState({
          status: 'error',
          result: null,
          diagnostics: [],
          workerError: error instanceof Error ? error.message : String(error),
        });
      }
    });
  }, []);

  useEffect(() => {
    startWorker();
    return () => {
      lifecycleGenerationRef.current += 1;
      buildGenerationRef.current += 1;
      clientRef.current?.dispose();
      clientRef.current = null;
    };
  }, [startWorker]);

  useEffect(() => {
    buildGenerationRef.current += 1;
    setState((current) => current.status === 'initializing'
      ? current
      : { status: 'ready', result: null, diagnostics: [], workerError: null });
  }, [projectId, files]);

  const build = useCallback(async (entryPoint: string) => {
    const client = clientRef.current;
    if (!client) return null;
    const buildCall = ++buildCallsRef.current;
    const generation = ++buildGenerationRef.current;
    console.info(`[PreviewBuild] project_id=${projectId} revision=${revision} build_call=${buildCall} status=started`);
    setState({ status: 'building', result: null, diagnostics: [], workerError: null });
    try {
      await client.syncFiles(projectId, files);
      const result = await client.build(projectId, entryPoint);
      if (generation !== buildGenerationRef.current) return null;
      setState({ status: 'success', result, diagnostics: [], workerError: null });
      console.info(`[PreviewBuild] project_id=${projectId} revision=${revision} build_call=${buildCall} status=success`);
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('preview_build_result', {
          detail: { projectId, revision, success: true, diagnostics: [], buildCall },
        }));
      }
      return result;
    } catch (error) {
      if (generation !== buildGenerationRef.current || error instanceof StalePreviewBuildError) return null;
      let diagnostics: BuildDiagnostic[] = [];
      if (error instanceof PreviewBuildError) {
        diagnostics = error.diagnostics;
        setState({ status: 'error', result: null, diagnostics, workerError: null });
      } else {
        const message = error instanceof Error ? error.message : String(error);
        setState({
          status: 'error',
          result: null,
          diagnostics: [],
          workerError: message,
        });
        diagnostics = [{ message, file: null, line: null, column: null, lineText: null }];
      }
      console.error(
        `[PreviewBuild] project_id=${projectId} revision=${revision} build_call=${buildCall} status=error diagnostics=${JSON.stringify(diagnostics.map((item) => ({ path: item.file, line: item.line, column: item.column, message: item.message })))}`,
      );
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('preview_build_result', {
          detail: { projectId, revision, success: false, diagnostics, buildCall },
        }));
      }
      return null;
    }
  }, [files, projectId, revision]);

  return { state, build, restartWorker: startWorker };
}
