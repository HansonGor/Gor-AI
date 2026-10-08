import * as esbuild from 'esbuild-wasm';
import wasmUrl from 'esbuild-wasm/esbuild.wasm?url';
import { normalizePreviewPath } from '../../core/pathUtils.ts';
import type { PreviewFiles } from '../../core/types.ts';
import type { BuildOutputFile, PreviewBuildResult } from '../workerProtocol.ts';
import { normalizeDiagnostics } from './diagnostics.ts';
import { createVirtualFsPlugin, loaderForPath, resolveVirtualModule } from './virtualFsPlugin.ts';
import { preparePreviewCompilation } from './babelHtmlAdapter.ts';

let initialization: Promise<void> | null = null;

export function initializeCompiler(): Promise<void> {
  if (!initialization) {
    initialization = esbuild.initialize({ wasmURL: wasmUrl, worker: false }).catch((error: unknown) => {
      initialization = null;
      throw error;
    });
  }
  return initialization;
}

function outputType(path: string): BuildOutputFile['type'] {
  if (path.endsWith('.js')) return 'js';
  if (path.endsWith('.css')) return 'css';
  throw new Error(`Unexpected build output type: ${path}`);
}

export async function buildPreviewProject(
  projectId: string,
  buildId: string,
  files: PreviewFiles,
  entryPoint: string,
): Promise<PreviewBuildResult> {
  await initializeCompiler();
  const startedAt = performance.now();
  const normalizedEntry = normalizePreviewPath(entryPoint);
  const compilationFiles = preparePreviewCompilation(files, normalizedEntry);
  resolveVirtualModule(compilationFiles, normalizedEntry);
  loaderForPath(normalizedEntry);

  const result = await esbuild.build({
    entryPoints: [normalizedEntry],
    bundle: true,
    write: false,
    outdir: '/out',
    entryNames: 'bundle',
    format: 'iife',
    globalName: '__GOR_PREVIEW_BUNDLE__',
    platform: 'browser',
    jsx: 'automatic',
    sourcemap: false,
    logLevel: 'silent',
    plugins: [createVirtualFsPlugin(() => compilationFiles)],
  });

  return {
    buildId,
    projectId,
    entryPoint: normalizedEntry,
    outputFiles: (result.outputFiles ?? []).map((file) => ({
      path: file.path.replace(/\\/g, '/'),
      type: outputType(file.path),
      contents: file.text,
    })),
    warnings: normalizeDiagnostics(result.warnings),
    duration: performance.now() - startedAt,
  };
}
