import type { PreviewFiles } from '../../core/types.ts';
import { normalizePreviewPath } from '../../core/pathUtils.ts';
import { BABEL_PREVIEW_ENTRY, htmlAttribute, htmlScripts } from '../../core/htmlScripts.ts';

/** Legacy Babel HTML is compiled locally; no CDN/Babel download, source mutation or disk IO. */
export function preparePreviewCompilation(files: PreviewFiles, entryPoint: string): PreviewFiles {
  if (entryPoint !== BABEL_PREVIEW_ENTRY) return files;
  const prepared = { ...files };
  const html = (files['/index.html'] ?? '').replace(/<!--[\s\S]*?-->/g, '');
  const scripts = htmlScripts(html).filter((script) => script.type === 'text/babel' || script.type === 'text/jsx');
  if (!scripts.length) throw new Error('Preview Babel entry has no JSX scripts.');
  const localPath = (path: string) => {
    if (/^(?:[a-z][\w+.-]*:|\/\/)/i.test(path)) throw new Error('Preview Babel scripts and styles must use virtual local files, not external URLs.');
    return normalizePreviewPath(path);
  };
  const insert = (path: string, source: string) => {
    if (Object.prototype.hasOwnProperty.call(prepared, path)) throw new Error(`Preview adapter path conflicts with project source: ${path}`);
    prepared[path] = source;
  };
  const css = Array.from(html.matchAll(/<link\b[^>]*>/gi)).flatMap(([tag]) => {
    const href = htmlAttribute(tag, 'href');
    return htmlAttribute(tag, 'rel')?.toLowerCase() === 'stylesheet' && href
      ? [`import ${JSON.stringify(localPath(href))};`] : [];
  });
  const calls = scripts.map((script, index) => {
    const path = script.src ? localPath(script.src) : `/__gor_babel_inline_${index}.jsx`;
    if (!script.src) insert(path, script.source);
    // require preserves HTML script order and isolates repeated lexical declarations.
    return `require(${JSON.stringify(path)});`;
  });
  insert(BABEL_PREVIEW_ENTRY, [
    `import React from 'react';`,
    `import * as ReactDOM from 'react-dom';`,
    `import * as ReactDOMClient from 'react-dom/client';`,
    `globalThis.React = React;`,
    `globalThis.ReactDOM = { ...ReactDOM, ...ReactDOMClient };`,
    ...css, ...calls,
  ].join('\n'));
  return prepared;
}
