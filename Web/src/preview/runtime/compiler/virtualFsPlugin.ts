import type { Loader, Plugin } from 'esbuild-wasm';
import { normalizePreviewPath, resolvePreviewPath } from '../../core/pathUtils.ts';
import type { PreviewFiles } from '../../core/types.ts';
import { isBareSpecifier, resolveAllowedDependency } from './dependencyResolver.ts';

const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.css', '.json'] as const;

function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot).toLowerCase();
}

export function loaderForPath(path: string): Loader {
  const extension = extensionOf(path);
  if (extension === '.ts') return 'ts';
  if (extension === '.tsx') return 'tsx';
  if (extension === '.js') return 'js';
  if (extension === '.jsx') return 'jsx';
  if (extension === '.css') return 'css';
  if (extension === '.json') return 'json';
  throw new Error(`Unsupported Preview Project file type: ${extension || '(no extension)'} (${path})`);
}

function directoryOf(path: string): string {
  const normalized = normalizePreviewPath(path);
  const slash = normalized.lastIndexOf('/');
  return slash <= 0 ? '/' : normalized.slice(0, slash);
}

export function resolveVirtualModule(files: PreviewFiles, specifier: string, importer = '/'): string {
  const basePath = specifier.startsWith('/')
    ? normalizePreviewPath(specifier)
    : resolvePreviewPath(importer === '/' ? '/' : directoryOf(importer), specifier);
  const hasKnownExtension = SOURCE_EXTENSIONS.includes(extensionOf(basePath) as typeof SOURCE_EXTENSIONS[number]);
  const candidates = hasKnownExtension
    ? [basePath]
    : [
      basePath,
      ...SOURCE_EXTENSIONS.map((extension) => `${basePath}${extension}`),
      ...SOURCE_EXTENSIONS.map((extension) => `${basePath}/index${extension}`),
    ];
  const match = candidates.find((candidate) => Object.prototype.hasOwnProperty.call(files, candidate));
  if (!match) {
    throw new Error(`Cannot resolve "${specifier}" from "${importer}" in Preview Project.`);
  }
  return match;
}

export function createVirtualFsPlugin(getFiles: () => PreviewFiles): Plugin {
  return {
    name: 'preview-virtual-fs',
    setup(build) {
      build.onResolve({ filter: /.*/ }, (args) => {
        try {
          if (isBareSpecifier(args.path)) {
            return { path: resolveAllowedDependency(args.path), namespace: 'preview-runtime-dependency' };
          }
          return { path: resolveVirtualModule(getFiles(), args.path, args.importer || '/'), namespace: 'preview-vfs' };
        } catch (error) {
          return { errors: [{ text: error instanceof Error ? error.message : String(error) }] };
        }
      });

      build.onLoad({ filter: /.*/, namespace: 'preview-vfs' }, (args) => {
        try {
          const contents = getFiles()[args.path];
          if (contents === undefined) return { errors: [{ text: `Virtual file not found: ${args.path}` }] };
          return { contents, loader: loaderForPath(args.path), resolveDir: directoryOf(args.path) };
        } catch (error) {
          return { errors: [{ text: error instanceof Error ? error.message : String(error) }] };
        }
      });

      build.onLoad({ filter: /.*/, namespace: 'preview-runtime-dependency' }, (args) => {
        const runtime = 'globalThis.__GOR_PREVIEW_RUNTIME__';
        const shims: Record<string, string> = {
          three: `module.exports = ${runtime}.THREE;`,
          react: `const React = ${runtime}.React;
export default React;
export const { Children, Component, Fragment, Profiler, PureComponent, StrictMode, Suspense, cloneElement, createContext, createElement, createFactory, createRef, forwardRef, isValidElement, lazy, memo, startTransition, useCallback, useContext, useDebugValue, useDeferredValue, useEffect, useId, useImperativeHandle, useInsertionEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore, useTransition, version } = React;`,
          'react-dom': `const ReactDOM = ${runtime}.ReactDOM;
export default ReactDOM;
export const { createPortal, flushSync, findDOMNode, hydrate, render, unmountComponentAtNode, version } = ReactDOM;`,
          'react-dom/client': `const ReactDOMClient = ${runtime}.ReactDOMClient;
export const { createRoot, hydrateRoot, version } = ReactDOMClient;`,
          'react/jsx-runtime': `const runtime = ${runtime}.jsxRuntime;
export const { Fragment, jsx, jsxs } = runtime;`,
          'react/jsx-dev-runtime': `const runtime = ${runtime}.jsxDevRuntime;
export const { Fragment, jsxDEV } = runtime;`,
        };
        const contents = shims[args.path];
        return contents ? { contents, loader: 'js' } : { errors: [{ text: `Unsupported runtime dependency: ${args.path}` }] };
      });
    },
  };
}
